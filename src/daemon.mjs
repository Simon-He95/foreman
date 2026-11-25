import {
  appendEvent,
  appendInbox,
  getMasterFc,
  getTask,
  getWorkerModelRoutes,
  queuedTasks,
  runningTasks,
  updateTask,
} from "./db.mjs";
import { hasContract, verifyContract } from "./contract.mjs";
import {
  assertT3ProviderId,
  mergeModelRoutes,
  planTaskModel,
} from "./model-policy.mjs";
import { notifyMaster } from "./notifier.mjs";
import { formatDuration } from "./state.mjs";

function asText(value, max = 64000) {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

export class Daemon {
  constructor({ db, config, adapters, logger = console }) {
    this.db = db;
    this.config = config;
    this.adapters = adapters;
    this.logger = logger;
    this.timer = null;
    this.ticking = false;
    this.stopping = false;
    this.startedAt = Date.now();
    this.lastErrorLog = new Map();
    this.lastEventLog = new Map();
    this.stats = {
      ticks: 0,
      starts: 0,
      done: 0,
      failed: 0,
      retries: 0,
      lost: 0,
      cancelled: 0,
    };
  }

  adapterFor(task) {
    const adapter =
      this.adapters[task.adapter] || this.adapters[this.config.adapter];
    if (!adapter) throw new Error(`no adapter registered: ${task.adapter}`);
    return adapter;
  }

  leaseFor(task) {
    return this.adapterFor(task).leaseMs || this.config.leaseMs;
  }

  async start() {
    this.stopping = false;
    await this.reconcile("boot");
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.error("[daemon] tick failed", error));
    }, this.config.tickMs);
    this.logger.info(
      `[daemon] started tick=${this.config.tickMs}ms concurrency=${this.config.concurrency} adapters=${Object.keys(this.adapters).join(",")}`,
    );
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + 5000;
    while (this.ticking && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Running workers are intentionally left alive. On the next boot they are
    // re-attached by thread id, or blocked if the thread id was never recorded.
  }

  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      this.stats.ticks += 1;
      await this.pollRunning();
      await this.recoverExpired();
      await this.claimQueued();
    } finally {
      this.ticking = false;
    }
  }

  async reconcile(reason = "boot") {
    const running = runningTasks(this.db);
    if (running.length === 0) return;
    this.logger.info(`[daemon] reconcile ${running.length} running task(s) (${reason})`);
    for (const task of running) {
      if (!task.thread_id) {
        await this.finalizeBlocked(
          task,
          "control plane restarted before a thread id was recorded; verify the worker manually",
        );
        continue;
      }
      try {
        const outcome = await this.adapterFor(task).poll(task);
        if (outcome.state === "running") {
          this.touch(task, "running", outcome.link);
          appendEvent(this.db, task.id, "reattached", {
            threadId: task.thread_id,
            reason,
          });
          this.logger.info(
            `[daemon] reattached ${task.id} -> ${task.thread_id}`,
          );
        } else if (
          ["done", "failed", "blocked", "cancelled"].includes(outcome.state)
        ) {
          await this.finalize(task, outcome);
        } else {
          await this.requeueOnlyIfStopped(task, outcome.error || "thread not found", {
            assumeStopped: outcome.state === "unknown",
          });
        }
      } catch (error) {
        // Keep ownership while the adapter is unreachable. The lease still
        // expires eventually, but a short outage must not duplicate work.
        const lease = this.leaseFor(task);
        updateTask(this.db, task.id, {
          lease_until: Date.now() + lease,
          error: `reattach failed: ${error.message}`,
        });
        appendEvent(this.db, task.id, "reattach_error", {
          error: error.message,
        });
        this.logError(task.id, "reattach", error);
      }
    }
  }

  touch(task, state = "running", link = null) {
    const lease = this.leaseFor(task);
    updateTask(this.db, task.id, {
      lease_until: Date.now() + lease,
      heartbeat_at: Date.now(),
      last_polled_at: Date.now(),
      error: state === "running" ? task.error : null,
      ...(link && link !== task.thread_link ? { thread_link: link } : {}),
    });
  }

  async pollRunning() {
    for (const task of runningTasks(this.db)) {
      if (this.config.executionMode === "worker" && task.worker_id) {
        continue;
      }
      if (!task.thread_id) {
        await this.finalizeBlocked(
          task,
          "control plane restarted before a thread id was recorded; verify the worker manually",
        );
        continue;
      }
      let outcome;
      try {
        outcome = await this.adapterFor(task).poll(task);
      } catch (error) {
        // Do not extend the lease on a failed poll: if the adapter keeps
        // failing, the lease must eventually expire.
        updateTask(this.db, task.id, {
          last_polled_at: Date.now(),
          error: `poll failed: ${error.message}`,
        });
        if (this.shouldEvent(task.id, "poll_error")) {
          appendEvent(this.db, task.id, "poll_error", { error: error.message });
        }
        this.logError(task.id, "poll", error);
        continue;
      }

      if (outcome.state === "running") {
        this.touch(task, "running", outcome.link);
        continue;
      }
      if (["done", "failed", "blocked", "cancelled"].includes(outcome.state)) {
        await this.finalize(task, outcome);
        continue;
      }
      await this.requeueOnlyIfStopped(task, outcome.error || "thread unknown", {
        assumeStopped: outcome.state === "unknown",
      });
    }
  }

  async recoverExpired() {
    const expired = runningTasks(this.db).filter(
      (task) => task.lease_until && task.lease_until < Date.now(),
    );
    for (const task of expired) {
      // pollRunning already gave live threads a fresh lease. Anything still
      // expired is unreachable or gone. Only requeue if the adapter can prove
      // the old worker is stopped; otherwise a second start could duplicate it.
      const reason = `lease expired after ${formatDuration(Date.now() - (task.heartbeat_at || task.started_at || Date.now()))} without a heartbeat`;
      if (this.config.executionMode === "worker" && task.worker_id) {
        await this.finalizeBlocked(
          task,
          `${reason}; worker ${task.worker_id} stopped reporting; verify it before retrying`,
        );
        continue;
      }
      await this.requeueOnlyIfStopped(task, reason);
    }
  }

  async claimQueued() {
    if (this.config.executionMode === "worker") return;
    const running = runningTasks(this.db).length;
    const slots = Math.max(0, this.config.concurrency - running);
    if (slots === 0) return;
    const queued = queuedTasks(this.db, slots);
    for (const task of queued) {
      const adapter = this.adapterFor(task);
      const lease = adapter.leaseMs || this.config.leaseMs;
      const ts = Date.now();
      const updated = updateTask(this.db, task.id, {
        status: "running",
        attempts: task.attempts + 1,
        started_at: ts,
        heartbeat_at: ts,
        last_polled_at: ts,
        lease_until: ts + lease,
        not_before: null,
        worker_id: null,
        attempt_id: null,
        thread_id: null,
        error: null,
        result: null,
        finished_at: null,
      });
      appendEvent(this.db, task.id, "started", {
        adapter: task.adapter,
        attempt: updated.attempts,
      });
      try {
        const started = await adapter.start(updated);
        updateTask(this.db, task.id, {
          thread_id: started.threadId,
          thread_link: started.link || task.thread_link || null,
          heartbeat_at: Date.now(),
          lease_until: Date.now() + lease,
        });
        appendEvent(this.db, task.id, "thread_started", {
          threadId: started.threadId,
          threadLink: started.link || null,
          adapter: task.adapter,
        });
        if (started.link) {
          const model = task.model
            ? String(task.model).replace(/^dimcode-api-oauth\//, "")
            : null;
          notifyMaster(
            this.db,
            this.config,
            [
              `▶️ 开始：${task.title}（${task.id}）${model ? ` · ${model}` : ""}${task.effort ? ` / ${task.effort}` : ""}`,
              started.link,
            ].join("\n"),
            task.master_thread_id,
          );
        }
        this.stats.starts += 1;
        this.logger.info(
          `[daemon] started ${task.id} "${task.title}" -> ${started.threadId}`,
        );
      } catch (error) {
        appendEvent(this.db, task.id, "start_error", {
          error: error.message,
        });
        this.logError(task.id, "start", error);
        await this.requeueOrFail(updated, `start failed: ${error.message}`);
      }
    }
  }

  async requeueOrFail(task, reason) {
    const fresh = getTask(this.db, task.id);
    if (!fresh || fresh.status !== "running") return;
    const canRetry = fresh.attempts < fresh.max_attempts;
    if (canRetry) {
      updateTask(this.db, fresh.id, {
        status: "queued",
        thread_id: null,
        worker_id: null,
        attempt_id: null,
        lease_until: null,
        not_before: Date.now() + Math.max(0, this.config.retryDelayMs || 0),
        heartbeat_at: null,
        last_polled_at: null,
        error: reason,
        started_at: null,
      });
      appendEvent(this.db, fresh.id, "retry", {
        reason,
        attempt: fresh.attempts,
        maxAttempts: fresh.max_attempts,
      });
      this.stats.retries += 1;
      this.logger.warn(
        `[daemon] requeue ${fresh.id} (attempt ${fresh.attempts}/${fresh.max_attempts}): ${reason}`,
      );
      return;
    }
    await this.finalize(fresh, { state: "failed", error: reason });
  }

  async requeueOnlyIfStopped(task, reason, { assumeStopped = false } = {}) {
    let canRequeue = assumeStopped || !task.thread_id;
    let stopError = null;
    if (task.thread_id && !canRequeue) {
      try {
        const stopped = await this.adapterFor(task).stop(task);
        canRequeue = Boolean(
          stopped && (stopped.stopped === true || stopped.missing === true),
        );
      } catch (error) {
        stopError = error.message;
      }
    }
    if (!canRequeue) {
      await this.finalizeBlocked(
        task,
        `${reason}; cannot confirm the old worker stopped${stopError ? ` (${stopError})` : ""}; verify thread ${task.thread_id || "-"} manually`,
      );
      return;
    }
    await this.requeueOrFail(task, reason);
  }

  async finalizeBlocked(task, reason) {
    await this.finalize(task, { state: "blocked", error: reason });
  }

  async finalize(task, outcome) {
    const fresh = getTask(this.db, task.id) || task;
    if (!["running", "blocked"].includes(fresh.status)) return;
    const state = outcome.state;
    let status =
      state === "done"
        ? "done"
        : state === "failed"
          ? "failed"
          : state === "blocked"
            ? "blocked"
            : "cancelled";
    let error = asText(outcome.error);
    let contract = null;

    if (status === "done") {
      if (fresh.worker_id && this.config.executionMode === "worker") {
        if (outcome.contract && typeof outcome.contract.ok === "boolean") {
          contract = outcome.contract;
        } else if (hasContract(fresh)) {
          contract = {
            ok: false,
            reason: "worker did not provide completion-contract evidence",
            checks: [],
          };
        } else {
          contract = { ok: true, checks: [] };
        }
      } else {
        try {
          contract = verifyContract(fresh, outcome);
        } catch (err) {
          contract = {
            ok: false,
            reason: `contract check errored: ${err.message}`,
            checks: [],
          };
        }
      }
      if (!contract.ok) {
        status = "blocked";
        error = `completion contract failed: ${contract.reason}`;
        appendEvent(this.db, fresh.id, "contract_failed", {
          reason: contract.reason,
          checks: contract.checks,
          result: asText(outcome.result),
        });
      }
    }

    const ts = Date.now();
    updateTask(this.db, fresh.id, {
      status,
      result: asText(outcome.result),
      error,
      lease_until: null,
      not_before: null,
      heartbeat_at: ts,
      last_polled_at: ts,
      finished_at: status === "blocked" ? null : ts,
    });
    appendEvent(this.db, fresh.id, status, {
      result: asText(outcome.result),
      error,
      threadId: fresh.thread_id,
      contract,
    });

    if (status === "done") {
      this.stats.done += 1;
      appendInbox(this.db, "task_completed", fresh.id, {
        title: fresh.title,
        result: asText(outcome.result),
        threadId: fresh.thread_id,
        durationMs: ts - (fresh.started_at || fresh.created_at),
        model: fresh.model,
        effort: fresh.effort,
      });
      this.logger.info(`[daemon] done ${fresh.id} "${fresh.title}"`);
      notifyMaster(
        this.db,
        this.config,
        `✅ 完成：${fresh.title}（${fresh.id}）· ${formatDuration(ts - (fresh.started_at || fresh.created_at))}\n${String(asText(outcome.result) || "").slice(0, 1200)}${fresh.thread_link ? `\n${fresh.thread_link}` : ""}`,
        fresh.master_thread_id,
      );
    } else if (status === "failed") {
      this.stats.failed += 1;
      appendInbox(this.db, "task_failed", fresh.id, {
        title: fresh.title,
        error,
        threadId: fresh.thread_id,
        attempts: fresh.attempts,
        model: fresh.model,
        effort: fresh.effort,
      });
      this.logger.warn(`[daemon] failed ${fresh.id} "${fresh.title}": ${error}`);
      notifyMaster(
        this.db,
        this.config,
        `❌ 失败：${fresh.title}（${fresh.id}）\n${String(error || "").slice(0, 1200)}${fresh.thread_link ? `\n${fresh.thread_link}` : ""}`,
        fresh.master_thread_id,
      );
    } else if (status === "blocked") {
      appendInbox(this.db, "needs_human", fresh.id, {
        title: fresh.title,
        error,
        threadId: fresh.thread_id,
        model: fresh.model,
        effort: fresh.effort,
      });
      this.logger.warn(`[daemon] blocked ${fresh.id} "${fresh.title}": ${error}`);
      notifyMaster(
        this.db,
        this.config,
        `⛔ 等待人工：${fresh.title}（${fresh.id}）\n${String(error || "").slice(0, 1200)}${fresh.thread_link ? `\n${fresh.thread_link}` : ""}`,
        fresh.master_thread_id,
      );
    } else {
      this.stats.cancelled += 1;
    }
  }

  async cancel(taskId, reason = "cancelled by user") {
    const task = getTask(this.db, taskId);
    if (!task) {
      const error = new Error(`task not found: ${taskId}`);
      error.status = 404;
      throw error;
    }
    if (["done", "failed", "cancelled"].includes(task.status)) {
      return task;
    }
    if (task.thread_id) {
      try {
        await this.adapterFor(task).stop(task);
      } catch (error) {
        this.logError(task.id, "stop", error);
      }
    }
    const current = getTask(this.db, task.id);
    if (!current || ["done", "failed", "cancelled"].includes(current.status)) {
      return current;
    }
    const updated = updateTask(this.db, task.id, {
      status: "cancelled",
      lease_until: null,
      not_before: null,
      error: reason,
      finished_at: Date.now(),
    });
    appendEvent(this.db, task.id, "cancelled", { reason });
    this.stats.cancelled += 1;
    return updated;
  }

  retry(taskId) {
    const task = getTask(this.db, taskId);
    if (!task) {
      const error = new Error(`task not found: ${taskId}`);
      error.status = 404;
      throw error;
    }
    if (["running", "queued"].includes(task.status)) {
      const error = new Error(
        `cannot retry a ${task.status} task; cancel it first`,
      );
      error.status = 409;
      throw error;
    }
    if (
      task.status === "blocked" &&
      /cannot confirm the old worker stopped/.test(task.error || "")
    ) {
      const error = new Error(
        "blocked task may still have a live worker; verify it in the adapter before retrying",
      );
      error.status = 409;
      throw error;
    }
    let retryTarget = {};
    // A task that failed before a thread existed has no useful model lock to
    // preserve. Re-plan it against the current routes so changing a model does
    // not leave a permanently poisoned retry button.
    if (
      task.adapter === "t3" &&
      ["failed", "lost"].includes(task.status) &&
      !task.thread_id
    ) {
      const masterFc = task.master_thread_id
        ? getMasterFc(this.db, task.master_thread_id)
        : null;
      const routes = mergeModelRoutes(
        this.config.workerModelRoutes,
        getWorkerModelRoutes(this.db, null),
        getWorkerModelRoutes(this.db, task.master_thread_id),
      );
      const plan = planTaskModel(this.config, {
        title: task.title,
        brief: task.brief,
        adapter: task.adapter,
        provider: task.provider,
        model: task.model,
        effort: task.effort,
        routes,
        masterFc,
      });
      const provider = assertT3ProviderId(
        plan.provider ||
          this.config.forceProvider ||
          task.provider ||
          this.config.t3Provider,
      );
      retryTarget = {
        provider,
        model: plan.model,
        effort: plan.effort,
      };
    }
    const updated = updateTask(this.db, task.id, {
      status: "queued",
      attempts: 0,
      thread_id: null,
      worker_id: null,
      attempt_id: null,
      lease_until: null,
      not_before: null,
      heartbeat_at: null,
      last_polled_at: null,
      started_at: null,
      finished_at: null,
      result: null,
      error: null,
      ...retryTarget,
    });
    appendEvent(this.db, task.id, "manual_retry", {});
    return updated;
  }

  resume(taskId) {
    const task = getTask(this.db, taskId);
    if (!task) {
      const error = new Error(`task not found: ${taskId}`);
      error.status = 404;
      throw error;
    }
    if (task.status !== "blocked") {
      const error = new Error(`cannot resume a ${task.status} task`);
      error.status = 409;
      throw error;
    }
    if (task.worker_id) {
      const error = new Error(
        "worker tasks cannot resume the old thread; retry to create a new attempt",
      );
      error.status = 409;
      throw error;
    }
    if (!task.thread_id) {
      const error = new Error("blocked task has no thread id to resume");
      error.status = 409;
      throw error;
    }
    const ts = Date.now();
    const updated = updateTask(this.db, task.id, {
      status: "running",
      lease_until: ts + this.leaseFor(task),
      not_before: null,
      heartbeat_at: ts,
      last_polled_at: ts,
      error: null,
      finished_at: null,
    });
    appendEvent(this.db, task.id, "resumed", {
      threadId: task.thread_id,
    });
    return updated;
  }

  shouldEvent(taskId, kind) {
    const key = `${taskId}:${kind}`;
    const last = this.lastEventLog.get(key) || 0;
    if (Date.now() - last < 60000) return false;
    this.lastEventLog.set(key, Date.now());
    return true;
  }

  logError(taskId, phase, error) {
    const last = this.lastErrorLog.get(`${taskId}:${phase}`) || 0;
    if (Date.now() - last < 60000) return;
    this.lastErrorLog.set(`${taskId}:${phase}`, Date.now());
    this.logger.error(`[daemon] ${phase} ${taskId}: ${error.message}`);
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      ticking: this.ticking,
      ...this.stats,
    };
  }
}
