import fs from "node:fs";
import path from "node:path";

function parseDurationMs(text, fallback = 4000) {
  const match = String(text).match(/duration\s*=\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?/i);
  if (!match) return fallback;
  const value = Number(match[1]);
  const unit = (match[2] || "ms").toLowerCase();
  const multiplier = unit === "h" ? 3600000 : unit === "m" ? 60000 : unit === "s" ? 1000 : 1;
  return Math.max(50, Math.round(value * multiplier));
}

export class MockAdapter {
  name = "mock";

  constructor({ dataDir, leaseMs = 30000 } = {}) {
    this.dir = path.join(dataDir, "mock");
    fs.mkdirSync(this.dir, { recursive: true });
    this.leaseMs = leaseMs;
  }

  file(taskId) {
    return path.join(this.dir, `${taskId}.json`);
  }

  read(taskId) {
    try {
      return JSON.parse(fs.readFileSync(this.file(taskId), "utf8"));
    } catch {
      return null;
    }
  }

  async start(task) {
    const payload = {
      taskId: task.id,
      startedAt: Date.now(),
      durationMs: parseDurationMs(task.brief),
      fail: /(^|\s)FAIL(\s|$)/i.test(task.brief),
      cancelled: false,
      brief: task.brief,
    };
    fs.writeFileSync(this.file(task.id), JSON.stringify(payload, null, 2));
    return { threadId: `mock_${task.id}` };
  }

  async poll(task) {
    const data = this.read(task.id);
    if (!data) return { state: "unknown", error: "mock state file missing" };
    if (data.cancelled) return { state: "cancelled" };
    const elapsed = Date.now() - data.startedAt;
    if (elapsed < data.durationMs) {
      return {
        state: "running",
        progress: { elapsedMs: elapsed, durationMs: data.durationMs },
      };
    }
    if (data.fail) {
      return {
        state: "failed",
        error: `mock failure requested after ${elapsed}ms`,
      };
    }
    return {
      state: "done",
      result: `mock worker finished "${task.title}" in ${elapsed}ms`,
    };
  }

  async attach(task) {
    return this.poll(task);
  }

  async stop(task) {
    const data = this.read(task.id);
    if (!data) return { stopped: false, missing: true };
    data.cancelled = true;
    data.cancelledAt = Date.now();
    fs.writeFileSync(this.file(task.id), JSON.stringify(data, null, 2));
    return { stopped: true };
  }
}
