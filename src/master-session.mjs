import { spawn } from "node:child_process";
import {
  getMasterFc,
  getMasterProject,
  getMeta,
  setMasterFc,
  setMasterProject,
  setMeta,
} from "./db.mjs";
import {
  leaderProviderSummary,
  normalizeLeaderOverride,
} from "./leader-options.mjs";

export function masterDefaults(config) {
  const summary = leaderProviderSummary(config);
  const selected = normalizeLeaderOverride(
    {
      provider: summary.default.provider,
      model: summary.default.model,
    },
    config,
  );
  return {
    provider: selected.provider,
    model: selected.model,
    effort: selected.effort,
    mode: selected.mode,
    label: summary.default.label || `${selected.provider} / ${selected.model}`,
    project: config.t3Project || config.projectPath,
  };
}

function run(bin, args, { cwd, timeoutMs = 130000 } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
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
      reject(new Error(`t3 master create timed out after ${timeoutMs}ms`));
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
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function createMasterSession({
  db,
  config,
  leader = null,
  title = "Foreman",
  message = "现在什么情况？",
  project = null,
}) {
  const bound = getMeta(db, "master_thread_id");
  if (bound) {
    const error = new Error(`master thread is already bound: ${bound}`);
    error.status = 409;
    throw error;
  }
  const selected = leader
    ? normalizeLeaderOverride(leader, config)
    : masterDefaults(config);
  const masterProject = String(project || config.t3Project || config.projectPath);
  const masterModel = `${selected.provider}::${selected.model}`;
  const args = [
    "thread",
    "start",
    masterProject,
    String(message),
    "--title",
    String(title),
    "--provider",
    "foreman",
    "--model",
    masterModel,
    "--option",
    `effort=${selected.effort || "auto"}`,
    "--wait",
    "--json",
  ];
  const result = await run(config.t3Bin, args, {
    cwd: config.cwd,
    timeoutMs: Math.max(30000, Number(config.leaderTimeoutMs) || 130000),
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code !== 0) {
    const error = new Error(
      `t3 master create exited ${result.code}: ${output.slice(-1500)}`,
    );
    error.status = 502;
    throw error;
  }
  let payload = null;
  for (const line of result.stdout.trim().split(/\r?\n/).filter(Boolean).reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        payload = parsed;
        break;
      }
    } catch {
      // keep looking
    }
  }
  const threadId =
    payload?.threadId ||
    payload?.thread_id ||
    payload?.id ||
    payload?.thread?.id ||
    null;
  if (!threadId) {
    const error = new Error("t3 did not return a master thread id");
    error.status = 502;
    throw error;
  }
  setMeta(db, "master_thread_id", threadId);
  setMasterFc(db, threadId, {
    provider: selected.provider,
    model: selected.model,
    effort: selected.effort,
  });
  setMasterProject(db, threadId, masterProject);
  const masterFc = getMasterFc(db, threadId);
  const storedProject = getMasterProject(db, threadId);
  return {
    threadId,
    leader: masterFc
      ? {
          provider: masterFc.provider,
          model: masterFc.model,
          effort: masterFc.effort,
        }
      : selected,
    project: storedProject || masterProject,
  };
}
