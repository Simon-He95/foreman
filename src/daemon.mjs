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
import {
  resolveTargetPlan,
  targetPlanFromResolution,
} from "./model-catalog.mjs";
import { notifyMaster } from "./notifier.mjs";
import { reconcileT3Threads } from "./reconcile.mjs";
import { checkForUpdate } from "./update.mjs";
import { formatDuration } from "./state.mjs";

function asText(value, max = 64000) {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

const THREAD_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
const THREAD_RECONCILE_BOOT_DELAY_MS = 8000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_CHECK_BOOT_DELAY_MS = 6000;

export class Daemon {
  constructor({ db, config, adapters, logger = console }) {
    this.db = db;
    this.config = config;
    this.adapters = adapters;
    this.logger = logger;
    this.timer = null;
    this.ticking = false;
    this.stopping = false;
    this.threadReconcileTimer = null;
    this.threadReconcileRunning = false;
    this.updateTimer = null;
    this.updateCheckRunning = false;
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

  resolveTaskTarget(task) {
    if (task.adapter !== "t3") {
      return targetPlanFromResolution(
        {
          provider: task.provider || null,
          model: task.model || null,
          effort: task.effort || null,
          validation: { ok: true, errors: [], warnings: [], suggestions: [] },
        },
        { source: task.target_source || "tier" },
      );
    }
    const masterFc = task.master_thread_id
      ? getMasterFc(this.db, task.master_thread_id)
      : null;
    return resolveTargetPlan(
      this.config,
      {
        provider:
          task.provider ||
          this.config.forceProvider ||
          this.config.t3Provider,
        model: task.model || this.config.t3Model,
        effort: task.effort,
      },
      {
        source: task.target_source || "claim",
        preferredProviders: [
          task.provider,
          this.config.forceProvider,
          masterFc?.provider,
          this.config.t3Provider,
        ],
      },
    );
  }

  preflightFailure(task, validation) {
    const reason = `model target rejected before start: ${validation.errors.join("; ")}`;
    const updated = updateTask(this.db, task.id, {
      status: "blocked",
      lease_until: null,
      not_before: null,
      error: reason,
      finished_at: null,
    });
    appendEvent(this.db, task.id, "preflight_failed", {
      errors: validation.errors,
      warnings: validation.warnings,
      suggestions: validation.suggestions,
    });
    this.logger.warn(`[daemon] blocked ${task.id} before start: ${reason}`);
    notifyMaster(
      this.db,
      this.config,
      `⛔ 启动前路由校验失败：${task.title}（${task.id}）\n${reason}`,
      task.master_thread_id,
    );
    return updated;
  }

  async start() {
    this.stopping = false;
    await this.reconcile("boot");
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.error("[daemon] tick failed", error));
    }, this.config.tickMs);
    this.scheduleThreadReconcile("boot", THREAD_RECONCILE_BOOT_DELAY_MS);
    this.scheduleUpdateCheck("boot", UPDATE_CHECK_BOOT_DELAY_MS);
    this.logger.info(
      `[daemon] started tick=${this.config.tickMs}ms concurrency=${this.config.concurrency} adapters=${Object.keys(this.adapters).join(",")}`,
    );
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.threadReconcileTimer) clearTimeout(this.threadReconcileTimer);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.timer = null;
    this.threadReconcileTimer = null;
    this.updateTimer = null;
    const deadline = Date.now() + 5000;
    while ((this.ticking || this.threadReconcileRunning) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Running workers are intentionally left alive. On the next boot they are
    // re-attached by thread id, or blocked if the thread id was never recorded.
  }

  scheduleThreadReconcile(reason = "interval", delay = THREAD_RECONCILE_INTERVAL_MS) {
    if (this.stopping) return;
    if (this.threadReconcileTimer) clearTimeout(this.threadReconcileTimer);
    this.threadReconcileTimer = setTimeout(async () => {
      await this.reconcileThreads(reason);
      this.scheduleThreadReconcile("interval");
    }, delay);
    this.threadReconcileTimer.unref?.();
  }

  async reconcileThreads(reason = "interval") {
    if (this.stopping || this.threadReconcileRunning) return;
    const adapter = this.adapters.t3;
    if (!adapter) return;
    this.threadReconcileRunning = true;
    try {
      const result = await reconcileT3Threads(this.db, {
        adapter,
        apply: true,
      });
      if (result.missing.length) {
        const active = result.missing.filter((item) =>
          ["queued", "running", "blocked"].includes(item.status),
        );
        this.logger.warn(
          `[daemon] thread reconcile (${reason}): ${result.missing.length} missing, ${result.updated} updated`,
        );
        if (active.length) {
          notifyMaster(
            this.db,
            this.config,
            `⚠️ 自动对账发现 ${active.length} 个活跃任务的 T3 thread 已消失，已标记为失联，不会自动重开：${active.map((item) => item.taskId).join(", ")}`,
            null,
          );
        }
      }
    } catch (error) {
      this.logger.warn(`[daemon] thread reconcile failed: ${error.message}`);
    } finally {
      this.threadReconcileRunning = false;
    }
  }

  scheduleUpdateCheck(reason = "interval", delay = UPDATE_CHECK_INTERVAL_MS) {
    if (this.stopping) return;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(async () => {
      await this.checkUpdates(reason);
      this.scheduleUpdateCheck("interval");
    }, delay);
    this.updateTimer.unref?.();
  }

  async checkUpdates(reason = "interval") {
    if (this.stopping || this.updateCheckRunning) return;
    this.updateCheckRunning = true;
    try {
      const update = await checkForUpdate(this.db, { force: true });
      if (update.updateAvailable) {
        this.logger.info(
          `[daemon] update available (${reason}): ${update.current} -> ${update.latest}`,
        );
      } else if (update.error) {
        this.logger.warn(`[daemon] update check failed: ${update.error}`);
      }
    } catch (error) {
      this.logger.warn(`[daemon] update check failed: ${error.message}`);
    } finally {
      this.updateCheckRunning = false;
    }
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
        } else if (outcome.state === "unknown") {
          await this.markThreadLost(
            task,
            outcome.error || "T3 thread no longer exists",
          );
        } else {
          await this.requeueOnlyIfStopped(task, outcome.error || "thread not found");
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
      if (outcome.state === "unknown") {
        await this.markThreadLost(
          task,
          outcome.error || "T3 thread no longer exists",
        );
        continue;
      }
      await this.requeueOnlyIfStopped(task, outcome.error || "thread unknown");
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
      const target = this.resolveTaskTarget(task);
      if (task.adapter === "t3" && target.model && !target.validation.ok) {
        this.preflightFailure(task, target.validation);
        continue;
      }
      const adapter = this.adapterFor(task);
      const lease = adapter.leaseMs || this.config.leaseMs;
      const ts = Date.now();
      const updated = updateTask(this.db, task.id, {
        status: "running",
        provider: target.provider || task.provider,
        model: target.model || task.model,
        effort: task.effort,
        target,
        attempts: task.attempts + 1,
        started_at: ts,
        heartbeat_at: ts,
        last_polled_at: ts,
        lease_until: ts + lease,
        not_before: null,
        worker_id: null,
        attempt_id: null,
        thread_id: null,
        thread_link: null,
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
          const model = task.model ? String(task.model) : null;
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
          code: error.code || "start",
          retryable: error.retryable !== false,
        });
        this.logError(task.id, "start", error);
        if (error.retryable === false) {
          const errorClass = error.code || "start";
          await this.finalize(updated, {
            state: "blocked",
            error: `${errorClass}: ${error.message}`,
          });
          continue;
        }
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
        thread_link: null,
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
    let missing = false;
    if (task.thread_id && !canRequeue) {
      try {
        const stopped = await this.adapterFor(task).stop(task);
        missing = stopped?.missing === true;
        canRequeue = Boolean(
          stopped && (stopped.stopped === true || missing),
        );
      } catch (error) {
        stopError = error.message;
      }
    }
    if (missing) {
      await this.markThreadLost(
        task,
        `${reason}; T3 thread no longer exists`,
      );
      return;
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

  async markThreadLost(task, reason) {
    const fresh = getTask(this.db, task.id) || task;
    if (fresh.status !== "running") return fresh;
    const threadId = fresh.thread_id || null;
    const why = `T3 thread disappeared while running; marked lost, not restarted automatically${threadId ? ` (${threadId})` : ""}${reason ? `: ${reason}` : ""}`;
    const updated = updateTask(this.db, fresh.id, {
      status: "lost",
      thread_id: null,
      thread_link: null,
      lease_until: null,
      heartbeat_at: null,
      last_polled_at: null,
      error: why,
      finished_at: Date.now(),
    });
    appendEvent(this.db, fresh.id, "thread_missing", {
      threadId,
      reason,
      action: "marked_lost",
    });
    this.stats.lost += 1;
    this.logger.warn(`[daemon] lost ${fresh.id}: ${why}`);
    notifyMaster(
      this.db,
      this.config,
      `⚠️ 任务「${fresh.title}」的 T3 thread 已消失，已标记为失联；未自动重开。`,
      fresh.master_thread_id,
    );
    return updated;
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
        `✅ 完成：${fresh.title}（${fresh.id}）· ${formatDuration(ts - (fresh.started_at || fresh.created_at))}\n${String(asText(outcome.result) || "").slice(0, 1200)}\n\n需要完整过程或细节，直接在主会话里问 Foreman。`,
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
        `❌ 失败：${fresh.title}（${fresh.id}）\n${String(error || "").slice(0, 1200)}\n\n需要完整过程或细节，直接在主会话里问 Foreman。`,
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
        `⛔ 等待人工：${fresh.title}（${fresh.id}）\n${String(error || "").slice(0, 1200)}\n\n需要完整过程或细节，直接在主会话里问 Foreman。`,
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

  async retryVerified(taskId) {
    const task = getTask(this.db, taskId);
    if (!task) {
      const error = new Error(`task not found: ${taskId}`);
      error.status = 404;
      throw error;
    }
    if (
      task.status === "blocked" &&
      /cannot confirm the old worker stopped/.test(task.error || "")
    ) {
      let stopped = null;
      let stopError = null;
      try {
        stopped = await this.adapterFor(task).stop(task);
      } catch (error) {
        stopError = error.message;
      }
      if (!(stopped?.stopped === true || stopped?.missing === true)) {
        const error = new Error(
          `blocked task may still have a live worker${stopError ? ` (${stopError})` : stopped?.reason ? ` (${stopped.reason})` : ""}`,
        );
        error.status = 409;
        throw error;
      }
      // The adapter proved the old thread is missing or terminal. Remember why
      // in the event log, then let the normal retry path clear thread_id.
      appendEvent(this.db, task.id, "retry_verified", {
        threadId: task.thread_id || null,
        missing: stopped?.missing === true,
        reason: stopped?.reason || null,
      });
      return this.retry(taskId, { verified: true });
    }
    return this.retry(taskId);
  }

  retry(taskId, { verified = false } = {}) {
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
      !verified &&
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
    let target = null;
    if (task.adapter === "t3") {
      const masterFc = task.master_thread_id
        ? getMasterFc(this.db, task.master_thread_id)
        : null;
      const routes = mergeModelRoutes(
        this.config.workerModelRoutes,
        getWorkerModelRoutes(this.db, null),
        getWorkerModelRoutes(this.db, task.master_thread_id),
      );
      // A task that failed before a thread existed has no useful model lock to
      // preserve. Re-plan it against the current routes so changing a model
      // does not leave a permanently poisoned retry button. A task that did
      // start keeps its original target unless the target is itself now
      // invalid; in that case retrying would only reproduce the failure.
      if (["failed", "lost"].includes(task.status) && !task.thread_id) {
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
        target = resolveTargetPlan(
          this.config,
          {
            provider:
              plan.provider ||
              this.config.forceProvider ||
              task.provider ||
              null,
            model: plan.model,
            effort: plan.effort,
          },
          {
            source: plan.source || "retry",
            preferredProviders: [
              plan.provider,
              this.config.forceProvider,
              task.provider,
              masterFc?.provider,
              this.config.t3Provider,
            ],
          },
        );
        retryTarget = {
          provider: target.provider
            ? assertT3ProviderId(target.provider)
            : null,
          model: target.model || plan.model,
          effort: plan.effort,
          target,
        };
      } else {
        target = resolveTargetPlan(
          this.config,
          {
            provider: task.provider || this.config.forceProvider || null,
            model: task.model,
            effort: task.effort,
          },
          {
            source: task.target_source || "retry",
            preferredProviders: [
              task.provider,
              this.config.forceProvider,
              masterFc?.provider,
              this.config.t3Provider,
            ],
          },
        );
      }
      if (target.model && !target.validation.ok) {
        const error = new Error(
          `model target rejected before retry: ${target.validation.errors.join("; ")}`,
        );
        error.status = 409;
        error.suggestions = target.validation.suggestions;
        throw error;
      }
    }
    const updated = updateTask(this.db, task.id, {
      status: "queued",
      ...(target ? { target } : {}),
      attempts: 0,
      thread_id: null,
      thread_link: null,
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
