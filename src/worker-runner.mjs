import fs from "node:fs";
import path from "node:path";
import { createAdapterRegistry } from "./adapters/index.mjs";
import { verifyContract } from "./contract.mjs";
import { parseTargetJson } from "./model-catalog.mjs";
import { WORKER_PROTOCOL_VERSION } from "./protocol.mjs";

async function postJson(url, token, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (!response.ok) {
      const error = new Error(
        data.error || `control plane returned ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export class WorkerRunner {
  constructor({ config, adapters, logger = console, workerId } = {}) {
    this.config = config;
    this.adapters = adapters || createAdapterRegistry(config);
    this.logger = logger;
    this.workerId = workerId || config.workerId;
    this.capacity = Math.max(1, Number(config.workerCapacity) || 1);
    this.projectMap =
      config.workerProjectMap && typeof config.workerProjectMap === "object"
        ? config.workerProjectMap
        : {};
    const explicitProjects = Array.isArray(config.workerProjects)
      ? config.workerProjects.map(String).filter(Boolean)
      : [];
    this.projects = explicitProjects.length
      ? explicitProjects
      : Object.keys(this.projectMap);
    this.controlUrl = String(config.controlUrl || "").replace(/\/+$/, "");
    let token = config.workerToken || config.authToken || null;
    if (!token && config.workerTokenFile) {
      try {
        token = fs.readFileSync(config.workerTokenFile, "utf8").trim() || null;
      } catch {
        token = null;
      }
    }
    this.token = token;
    this.running = new Map();
    this.pollErrors = new Map();
    this.statePath = path.join(
      config.dataDir,
      `worker-state-${this.workerId.replace(/[^a-zA-Z0-9_.-]/g, "-")}.json`,
    );
    this.lastHeartbeat = 0;
    this.timer = null;
    this.ticking = false;
    this.stopping = false;
  }

  async post(path, body) {
    return postJson(
      `${this.controlUrl}${path}`,
      this.token,
      { workerId: this.workerId, ...body },
      Math.max(5000, Number(this.config.workerPollMs) * 5 || 5000),
    );
  }

  loadState() {
    try {
      const rows = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      return new Map(
        (Array.isArray(rows) ? rows : [])
          .filter((entry) => entry?.task?.id)
          .map((entry) => [entry.task.id, entry]),
      );
    } catch {
      return new Map();
    }
  }

  saveState() {
    try {
      fs.mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });
      const rows = [...this.running.values()].map(({ task, threadId }) => ({
        task,
        threadId: threadId || task.thread_id || null,
      }));
      fs.writeFileSync(this.statePath, JSON.stringify(rows, null, 2), {
        mode: 0o600,
      });
    } catch (error) {
      this.logger.error(`[worker] cannot persist state: ${error.message}`);
    }
  }

  async register() {
    const data = await this.post("/api/worker/register", {
      id: this.workerId,
      name: this.workerId,
      capacity: this.capacity,
      projects: this.projects.length ? this.projects : null,
      version: "0.1.0",
      protocolVersion: WORKER_PROTOCOL_VERSION,
    });
    this.logger.info(
      `[worker] registered ${data.worker.id} capacity=${data.worker.capacity} -> ${this.controlUrl}`,
    );
    this.lastHeartbeat = Date.now();
  }

  async heartbeat() {
    await this.post("/api/worker/heartbeat", {
      running: this.running.size,
    });
    this.lastHeartbeat = Date.now();
  }

  async reattach() {
    const saved = this.loadState();
    const data = await this.post("/api/worker/assignments", {});
    let count = 0;
    for (const task of data.tasks || []) {
      let mapped;
      try {
        mapped = this.mapTask(task);
      } catch (error) {
        await this.report(task.id, "failed", {
          attemptId: task.attempt_id,
          error: `worker project mapping failed: ${error.message}`,
        });
        continue;
      }
      const adapter = this.adapters[mapped.adapter];
      if (!adapter) {
        await this.report(task.id, "failed", {
          attemptId: task.attempt_id,
          error: `worker has no adapter: ${mapped.adapter}`,
        });
        continue;
      }
      const entry = saved.get(task.id);
      const threadId =
        task.thread_id ||
        (entry?.task?.attempt_id === task.attempt_id ? entry.threadId : null);
      mapped.thread_id = threadId || null;
      this.running.set(task.id, { task: mapped, adapter, threadId });
      this.saveState();
      await this.report(task.id, "running", { threadId });
      count += 1;
    }
    this.saveState();
    if (count) this.logger.info(`[worker] reattached ${count} assignment(s)`);
  }

  async start() {
    this.stopping = false;
    await this.register();
    await this.reattach();
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.handleTickError(error));
    }, Math.max(200, Number(this.config.workerPollMs) || 1000));
    this.logger.info(`[worker] started ${this.workerId} capacity=${this.capacity}`);
  }

  handleTickError(error) {
    if (error.status === 401 || error.status === 403) {
      this.logger.error(
        `[worker] authentication failed (${error.status}); revoke/enroll a worker token and restart`,
      );
      this.stop().catch(() => {});
      return;
    }
    this.logger.error("[worker] tick failed", error);
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + 5000;
    while (this.ticking && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.saveState();
  }

  async report(taskId, state, extra = {}) {
    const entry = this.running.get(taskId);
    return this.post("/api/worker/report", {
      taskId,
      state,
      attemptId: extra.attemptId || entry?.task?.attempt_id,
      ...extra,
    });
  }

  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      if (Date.now() - this.lastHeartbeat > 5000) {
        await this.heartbeat();
      }
      await this.pollRunning();
      await this.claim();
    } finally {
      this.ticking = false;
    }
  }

  async pollRunning() {
    for (const [taskId, entry] of [...this.running.entries()]) {
      let outcome;
      try {
        outcome = await entry.adapter.poll(entry.task);
        this.pollErrors.delete(taskId);
      } catch (error) {
        const count = (this.pollErrors.get(taskId) || 0) + 1;
        this.pollErrors.set(taskId, count);
        this.logger.warn(
          `[worker] poll ${taskId} failed (${count}): ${error.message}`,
        );
        if (count < 3) continue;
        await this.finish(taskId, "failed", { error: error.message });
        continue;
      }

      if (outcome.state === "running") {
        await this.report(taskId, "running", {
          threadId: entry.threadId || entry.task.thread_id,
        });
        continue;
      }
      if (["done", "failed", "blocked", "cancelled"].includes(outcome.state)) {
        await this.finish(taskId, outcome.state, {
          result: outcome.result,
          error: outcome.error,
        });
        continue;
      }
      await this.finish(taskId, "failed", {
        error: outcome.error || `unknown worker state: ${outcome.state}`,
      });
    }
  }

  async finish(taskId, state, extra = {}) {
    const entry = this.running.get(taskId);
    let finalState = state;
    const reportExtra = { ...extra };
    if (state === "done" && entry) {
      let contract;
      try {
        contract = verifyContract(entry.task, { result: extra.result });
      } catch (error) {
        contract = {
          ok: false,
          reason: `contract check errored: ${error.message}`,
          checks: [],
        };
      }
      reportExtra.contract = contract;
      if (!contract.ok) {
        finalState = "blocked";
        reportExtra.error = `completion contract failed: ${contract.reason}`;
      }
    }
    try {
      await this.report(taskId, finalState, {
        attemptId: entry?.task?.attempt_id,
        threadId: entry?.threadId || entry?.task?.thread_id,
        ...reportExtra,
      });
      this.running.delete(taskId);
      this.pollErrors.delete(taskId);
      this.saveState();
      this.logger.info(`[worker] ${finalState} ${taskId}`);
    } catch (error) {
      this.saveState();
      this.logger.error(
        `[worker] report ${finalState} ${taskId} failed: ${error.message}`,
      );
    }
  }

  mapTask(task) {
    const target =
      task.target && typeof task.target === "object"
        ? task.target
        : parseTargetJson(task.target_json);
    const withTarget = target ? { ...task, target } : task;
    const mappings = Object.keys(this.projectMap);
    if (mappings.length === 0) return withTarget;
    const name = task.project_name || null;
    if (!name) {
      throw new Error("worker requires project_name for mapped execution");
    }
    const local = this.projectMap[name];
    if (!local) {
      throw new Error(`no local mapping for project ${name}`);
    }
    return { ...withTarget, project_path: path.resolve(this.config.cwd, local) };
  }

  async claim() {
    const free = this.capacity - this.running.size;
    if (free <= 0) return;
    const data = await this.post("/api/worker/claim", { limit: free });
    this.lastHeartbeat = Date.now();
    for (const task of data.tasks || []) {
      let mapped;
      try {
        mapped = this.mapTask(task);
      } catch (error) {
        await this.report(task.id, "failed", {
          attemptId: task.attempt_id,
          error: `worker project mapping failed: ${error.message}`,
        });
        continue;
      }
      const adapter = this.adapters[mapped.adapter];
      if (!adapter) {
        await this.report(task.id, "failed", {
          attemptId: task.attempt_id,
          error: `worker has no adapter: ${mapped.adapter}`,
        });
        continue;
      }
      try {
        const started = await adapter.start(mapped);
        const threadId = started?.threadId || null;
        this.running.set(task.id, { task: mapped, adapter, threadId });
        this.saveState();
        await this.report(task.id, "running", { threadId });
        this.logger.info(
          `[worker] started ${task.id} -> ${threadId || "(no thread id)"}`,
        );
      } catch (error) {
        this.logger.error(`[worker] start ${task.id} failed: ${error.message}`);
        const state = error.retryable === false ? "blocked" : "failed";
        const code = error.code ? `${error.code}: ` : "";
        await this.report(task.id, state, {
          attemptId: task.attempt_id,
          error: `worker start failed: ${code}${error.message}`,
        });
      }
    }
  }

  snapshot() {
    return {
      workerId: this.workerId,
      controlUrl: this.controlUrl,
      capacity: this.capacity,
      running: [...this.running.keys()],
      ticking: this.ticking,
    };
  }
}
