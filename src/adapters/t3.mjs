import { spawn } from "node:child_process";
import {
  normalizeEffort,
  reasoningOptionFor,
  reasoningValue,
} from "../model-policy.mjs";

function run(bin, args, { cwd, env, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.FOREMAN_TOKEN;
    const child = spawn(bin, args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(
        new Error(
          `${bin} ${args.join(" ")} timed out after ${timeoutMs}ms\n${stderr.slice(-2000)}`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function tryJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // find the last JSON object/array in the output
    const start = Math.min(
      ...["{", "["]
        .map((char) => trimmed.indexOf(char))
        .filter((index) => index >= 0),
    );
    if (!Number.isFinite(start)) return null;
    const candidate = trimmed.slice(start);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function deepFindThread(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.thread && typeof payload.thread === "object") return payload.thread;
  if (payload.data && typeof payload.data === "object") {
    if (payload.data.thread) return payload.data.thread;
    if (payload.data.id && !payload.data.messages) return payload.data;
  }
  if (payload.id && (payload.messages || payload.status || payload.state)) {
    return payload;
  }
  return payload;
}

function parseThreadId(text) {
  const json = tryJson(text);
  if (json) {
    const thread = deepFindThread(json);
    const id = pick(thread, ["id", "threadId", "thread_id"]);
    if (id) return String(id);
    const nested = pick(json, ["threadId", "thread_id", "id"]);
    if (nested) return String(nested);
  }
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const match = line.match(
      /\b((?:mcp|thr|thread|t3)_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
    );
    if (match) return match[1];
  }
  return null;
}

function classify(payload, text) {
  const thread = deepFindThread(payload);
  const status = String(
    pick(thread, [
      "status",
      "state",
      "turnStatus",
      "lastTurnStatus",
      "runState",
      "phase",
      "activity",
    ]) ?? "",
  ).toLowerCase();
  const messages = Array.isArray(payload?.messages)
    ? payload.messages
    : Array.isArray(thread?.messages)
      ? thread.messages
      : [];
  const lastAssistant = [...messages]
    .reverse()
    .find(
      (message) =>
        (message.role === "assistant" || message.role === "agent") &&
        (message.text || message.content),
    );
  const result =
    lastAssistant?.text ??
    lastAssistant?.content ??
    pick(thread, ["result", "lastResult", "summary"]);
  const error = pick(thread, ["error", "lastError", "failure"]);

  if (thread?.blockedOnThreadWait === true) {
    return {
      state: "blocked",
      error: "thread is waiting on another thread",
      raw: thread,
    };
  }
  if (Number(thread?.pendingRequestCount || 0) > 0) {
    return {
      state: "blocked",
      error: `thread has ${thread.pendingRequestCount} pending request(s)`,
      raw: thread,
    };
  }
  if (error) {
    return { state: "failed", error: String(error), raw: thread };
  }
  if (/(fail|error|cancel|abort|crash)/.test(status)) {
    return { state: "failed", error: `thread status: ${status}`, raw: thread };
  }
  if (/(blocked|await|approval|permission|input|question)/.test(status)) {
    return {
      state: "blocked",
      error: `thread is waiting: ${status}`,
      raw: thread,
    };
  }
  if (/(done|complete|completed|idle|finished|ended|success)/.test(status)) {
    return {
      state: "done",
      result: result ? String(result) : `thread finished (${status})`,
      raw: thread,
    };
  }
  if (
    /(prepar|wait|run|active|stream|busy|working|progress|pending|queued|starting)/.test(
      status,
    )
  ) {
    return { state: "running", raw: thread };
  }

  const running = pick(thread, ["isRunning", "running", "busy", "streaming"]);
  if (running === true) return { state: "running", raw: thread };

  const flat = String(text ?? "").toLowerCase();
  if (/(waiting for (approval|permission|input)|needs? (you|input|approval))/.test(flat)) {
    return { state: "blocked", error: "thread is waiting for a human", raw: null };
  }
  if (/(not found|no such thread|unknown thread)/.test(flat)) {
    return { state: "unknown", error: "thread not found" };
  }
  if (/(\bidle\b|\bcompleted\b|\bfinished\b)/.test(flat)) {
    return { state: "done", result: "thread is idle", raw: null };
  }
  if (/(\brunning\b|\bstreaming\b|\bworking\b|\bpreparing\b)/.test(flat)) {
    return { state: "running", raw: null };
  }
  return { state: "running", raw: null };
}

export class T3Adapter {
  name = "t3";

  constructor({
    t3Bin,
    projectPath,
    worktree,
    worktreeBase,
    provider,
    model,
    reasoningOption,
    leaseMs,
  }) {
    this.t3Bin = t3Bin;
    this.projectPath = projectPath;
    this.worktree = worktree;
    this.worktreeBase = worktreeBase || "HEAD";
    this.provider = provider;
    this.model = model;
    this.reasoningOption = reasoningOption || "effort";
    this.leaseMs = leaseMs;
  }

  async call(args, options = {}) {
    return run(this.t3Bin, args, {
      cwd: options.cwd || this.projectPath,
      timeoutMs: options.timeoutMs ?? 60000,
    });
  }

  async start(task) {
    const project = task.project_path || this.projectPath;
    const needsMainTree = Boolean(
      task.artifact_path || Number(task.require_diff || 0) === 1,
    );
    const buildArgs = () => {
      const args = ["thread", "start"];
      // Artifact/diff contracts are verified against task.project_path. A
      // separate worktree would make those checks inspect the wrong tree.
      if (this.worktree && !needsMainTree) {
        args.push("--worktree", this.worktreeBase);
      }
      const effectiveModel = task.model
        ? String(task.model).trim()
        : this.model;
      const provider = task.provider || this.provider;
      const effort = normalizeEffort(task.effort);
      if (provider && effectiveModel) {
        args.push("--provider", provider, "--model", effectiveModel);
        const reasoningOption = reasoningOptionFor(
          provider,
          task.reasoningOption || this.reasoningOption,
        );
        if (effort && effort !== "auto" && reasoningOption) {
          args.push(
            "--option",
            `${reasoningOption}=${reasoningValue(effectiveModel, effort)}`,
          );
        }
      }
      if (task.title) args.push("--title", String(task.title).slice(0, 160));
      let brief = String(task.brief || task.title);
      if (
        task.completion_token &&
        !brief.includes(String(task.completion_token))
      ) {
        brief += `\n\n完成后最后单独一行输出：${task.completion_token}`;
      }
      args.push(project, brief, "--json");
      return args;
    };

    let { code, stdout, stderr } = await this.call(buildArgs(), {
      cwd: project,
      timeoutMs: 120000,
    });
    let output = `${stdout}\n${stderr}`;

    if (code !== 0 && /No T3 Code project matches/i.test(output)) {
      const added = await this.call(["project", "add", project], {
        cwd: project,
        timeoutMs: 60000,
      });
      if (added.code !== 0) {
        throw new Error(
          `t3 project add failed: ${added.stderr.trim() || added.stdout.trim()}`,
        );
      }
      ({ code, stdout, stderr } = await this.call(buildArgs(), {
        cwd: project,
        timeoutMs: 120000,
      }));
      output = `${stdout}\n${stderr}`;
    }

    if (code !== 0) {
      if (/no default model|modelselection/i.test(output)) {
        throw new Error(
          `t3 thread start needs a provider/model. Set FOREMAN_T3_PROVIDER and FOREMAN_T3_MODEL (for example codex + gpt-6-astra). ${stderr.trim() || stdout.trim()}`,
        );
      }
      throw new Error(
        `t3 thread start exited ${code}: ${stderr.trim() || stdout.trim()}`,
      );
    }
    const threadId = parseThreadId(stdout) || parseThreadId(stderr);
    if (!threadId) {
      throw new Error(
        `t3 thread start did not return a thread id.\nstdout: ${stdout.slice(-2000)}\nstderr: ${stderr.slice(-2000)}`,
      );
    }
    let link =
      tryJson(stdout)?.thread?.link ||
      tryJson(stdout)?.link ||
      null;
    if (!link) {
      try {
        const shown = await this.show({ ...task, thread_id: threadId });
        link = shown.link || null;
      } catch {
        // Link is best-effort; polling will retry.
      }
    }
    return { threadId, link, raw: { stdout, stderr } };
  }

  async show(task) {
    const { code, stdout, stderr } = await this.call(
      ["thread", "show", task.thread_id, "--json", "--messages", "5"],
      { timeoutMs: 30000 },
    );
    const output = `${stdout}\n${stderr}`;
    if (code !== 0) {
      const classified = classify(null, output);
      if (classified.state === "unknown") return classified;
      throw new Error(
        `t3 thread show exited ${code}: ${stderr.trim() || stdout.trim()}`,
      );
    }
    const payload = tryJson(stdout);
    const classified = classify(payload, output);
    const link =
      payload?.thread?.link ||
      payload?.link ||
      deepFindThread(payload)?.link ||
      null;
    return { ...classified, link: link ? String(link) : null };
  }

  async poll(task) {
    if (!task.thread_id) return { state: "unknown", error: "no thread id" };
    return this.show(task);
  }

  async attach(task) {
    return this.poll(task);
  }

  async stop(task) {
    if (!task.thread_id) return { stopped: false };
    // The T3 thread CLI (0.1.x) exposes start/send/show/list, not stop/interrupt.
    // Interrupt is available to in-thread agents over MCP, so the daemon leaves
    // the thread alive and records the cancellation locally.
    return {
      stopped: false,
      unsupported: true,
      reason: "t3 thread CLI has no stop/cancel subcommand",
    };
  }

  async health() {
    try {
      const { code, stdout, stderr } = await this.call(
        ["thread", "list", "--project", this.projectPath, "--json"],
        { timeoutMs: 15000 },
      );
      return {
        ok: code === 0,
        bin: this.t3Bin,
        detail: code === 0 ? "t3 CLI reachable" : stderr.trim(),
        sample: code === 0 ? stdout.slice(0, 300) : null,
      };
    } catch (error) {
      return { ok: false, bin: this.t3Bin, detail: error.message };
    }
  }
}
