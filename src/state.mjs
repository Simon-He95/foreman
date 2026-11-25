import path from "node:path";
import {
  counts,
  listTasks,
  listProjects,
  listWorkers,
  recentTerminalTasks,
  runningTasks,
  queuedTasks,
  recentEvents,
  getMasterFc,
  getMasterProject,
  getMeta,
  getWorkerModelRoutes,
} from "./db.mjs";
import { mergeModelRoutes, modelRouteText } from "./model-policy.mjs";

export const STATUS_LABEL = {
  queued: "排队",
  running: "运行中",
  blocked: "等待人工",
  done: "完成",
  failed: "失败",
  lost: "失联",
  cancelled: "已取消",
};

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d${String(h % 24).padStart(2, "0")}h`;
}

export function shortPath(config, p) {
  if (!p) return "-";
  const relative = path.relative(config.cwd, p);
  if (relative === "") return ".";
  return relative && !relative.startsWith("..") ? relative : p;
}

function oneLine(text, max = 120) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function contractLabel(task) {
  const parts = [];
  if (task.completion_token) parts.push(`token:${oneLine(task.completion_token, 40)}`);
  if (task.artifact_path) parts.push(`artifact:${oneLine(task.artifact_path, 80)}`);
  if (Number(task.require_diff || 0) === 1) parts.push("git-diff");
  return parts.join(" + ");
}

function policyLabel(task) {
  const provider = task.provider ? String(task.provider) : null;
  const model = task.model ? String(task.model) : null;
  const effort = task.effort || null;
  return [
    provider ? `provider=${provider}` : null,
    model ? `model=${model}` : null,
    effort ? `effort=${effort}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function taskLine(task, config, extra = "") {
  const end =
    task.status === "blocked" ? task.heartbeat_at || Date.now() : Date.now();
  const elapsed = task.started_at
    ? `已跑 ${formatDuration(end - task.started_at)}`
    : `等待 ${formatDuration(end - task.created_at)}`;
  const thread = task.thread_link || (task.thread_id ? `thread=${task.thread_id}` : "thread=-");
  const heartbeat = task.heartbeat_at
    ? `心跳 ${formatDuration(Date.now() - task.heartbeat_at)} 前`
    : "心跳 -";
  const attempt = `第 ${task.attempts}/${task.max_attempts} 次`;
  const project = shortPath(config, task.project_path);
  const contract = contractLabel(task);
  const contractPart = contract ? ` | 契约=${contract}` : "";
  const policy = policyLabel(task);
  const policyPart = policy ? ` | ${policy}` : "";
  return `- [${task.id}] ${oneLine(task.title, 80)} | ${elapsed} | ${attempt} | ${thread} | ${heartbeat} | @${project}${policyPart}${contractPart}${extra}`;
}

export function buildStateCard(
  db,
  config,
  { maxItems = 12, masterThreadId = null, masterFc = null } = {},
) {
  const c = counts(db);
  const running = runningTasks(db);
  const queued = queuedTasks(db, 200);
  const blocked = listTasks(db, { status: "blocked", limit: 200 });
  const done = recentTerminalTasks(db, ["done"], maxItems);
  const failed = recentTerminalTasks(db, ["failed", "lost"], maxItems);

  const lines = [];
  lines.push(
    `FOREMAN 状态卡（权威数据，来自 SQLite；生成于 ${new Date().toLocaleString("zh-CN", { hour12: false })}）`,
  );
  lines.push(`GOAL: ${config.goal}`);
  const selectedMasterThreadId =
    masterThreadId || getMeta(db, "master_thread_id");
  const selectedFc =
    masterFc ||
    (selectedMasterThreadId ? getMasterFc(db, selectedMasterThreadId) : null);
  if (selectedFc) {
    lines.push(
      `FC: ${selectedFc.provider} / ${selectedFc.model} / effort ${selectedFc.effort || "auto"} (master ${selectedMasterThreadId})`,
    );
  } else {
    lines.push(
      `FC: ${config.leaderProvider || config.leaderMode} / ${config.leaderModel || "(config default)"} / effort ${config.leaderEffort || "auto"}`,
    );
  }
  const routes = mergeModelRoutes(
    config.workerModelRoutes,
    getWorkerModelRoutes(db, null),
    getWorkerModelRoutes(db, selectedMasterThreadId),
  );
  lines.push(`WORKER ROUTES: ${modelRouteText(routes)}`);
  const masterProject = getMasterProject(db, selectedMasterThreadId);
  lines.push(`MASTER PROJECT: ${shortPath(config, masterProject)}`);
  lines.push(
    `EXECUTION: ${config.executionMode === "worker" ? "worker (daemon only schedules; registered workers execute)" : "local (daemon executes tasks itself)"}`,
  );
  const roots = [...new Set([...(config.allowedProjectRoots || []), config.projectPath, config.cwd].filter(Boolean))];
  lines.push(`PROJECT ROOTS: ${roots.map((root) => shortPath(config, root)).join(", ")}`);
  const projects = listProjects(db);
  lines.push(
    `PROJECTS: ${
      projects.length
        ? projects
            .map((project) => `${project.name}@${shortPath(config, project.local_path)}`)
            .join(", ")
        : "(none)"
    }`,
  );
  const workers = listWorkers(db);
  lines.push(
    `WORKERS: ${
      workers.length
        ? workers
            .map(
              (worker) =>
                `${worker.id}(${worker.status},${worker.running}/${worker.capacity},${worker.last_heartbeat_at ? `${formatDuration(Date.now() - worker.last_heartbeat_at)} ago` : "no heartbeat"})`,
            )
            .join(", ")
        : "(none)"
    }`,
  );
  lines.push(
    `TOTALS: total=${c.total} queued=${c.queued} running=${c.running} blocked=${c.blocked} done=${c.done} failed=${c.failed} lost=${c.lost} cancelled=${c.cancelled}`,
  );
  lines.push("");
  lines.push(`RUNNING (${c.running}):`);
  if (running.length === 0) lines.push("- (none)");
  for (const task of running.slice(0, maxItems)) {
    lines.push(taskLine(task, config));
  }
  if (running.length > maxItems) {
    lines.push(`- ... 还有 ${running.length - maxItems} 个在跑`);
  }

  lines.push("");
  lines.push(`QUEUED (${c.queued}):`);
  if (queued.length === 0) lines.push("- (none)");
  for (const task of queued.slice(0, maxItems)) {
    const contract = contractLabel(task);
    const policy = policyLabel(task);
    lines.push(
      `- [${task.id}] ${oneLine(task.title, 80)} | 优先级 ${task.priority} | 已等 ${formatDuration(Date.now() - task.created_at)} | @${shortPath(config, task.project_path)}${task.thread_link ? ` | ${task.thread_link}` : ""}${policy ? ` | ${policy}` : ""}${contract ? ` | 契约=${contract}` : ""}`,
    );
  }
  if (c.queued > maxItems) {
    lines.push(`- ... 还有 ${c.queued - maxItems} 个排队`);
  }

  lines.push("");
  lines.push(`BLOCKED (${c.blocked}):`);
  if (blocked.length === 0) lines.push("- (none)");
  for (const task of blocked.slice(0, maxItems)) {
    lines.push(`${taskLine(task, config)} | 原因: ${oneLine(task.error, 120)}`);
  }
  if (c.blocked > maxItems) {
    lines.push(`- ... 还有 ${c.blocked - maxItems} 个等待人工`);
  }

  lines.push("");
  lines.push("RECENT DONE:");
  if (done.length === 0) lines.push("- (none)");
  for (const task of done.slice(0, maxItems)) {
    lines.push(
      `- [${task.id}] ${oneLine(task.title, 80)} | 用时 ${formatDuration((task.finished_at || Date.now()) - (task.started_at || task.created_at))} | 结果: ${oneLine(task.result, 100)}${task.thread_link ? ` | ${task.thread_link}` : ""}`,
    );
  }

  lines.push("");
  lines.push("FAILED / LOST:");
  if (failed.length === 0) lines.push("- (none)");
  for (const task of failed.slice(0, maxItems)) {
    lines.push(
      `- [${task.id}] ${oneLine(task.title, 80)} | ${STATUS_LABEL[task.status] || task.status} | ${oneLine(task.error, 120)}${task.thread_link ? ` | ${task.thread_link}` : ""}`,
    );
  }

  return lines.join("\n");
}

export function ruleReply(db, config) {
  const c = counts(db);
  const running = runningTasks(db);
  const queued = queuedTasks(db, 200);
  const blocked = listTasks(db, { status: "blocked", limit: 200 });

  if (c.total === 0) {
    return "现在没有任何任务。给我一个目标，或者用 `foreman add` 添加任务。";
  }

  const parts = [];
  parts.push(
    `现在共 ${c.total} 个任务：${c.running} 个在跑，${c.queued} 个排队，${c.blocked} 个等人，${c.done} 个完成，${c.failed + c.lost} 个失败/失联。`,
  );

  if (running.length) {
    parts.push(
      `在跑的是：${running
        .slice(0, 6)
        .map(
          (task) =>
            `${task.title}（${formatDuration(Date.now() - (task.started_at || Date.now()))}，${task.thread_id || "无 thread"}）`,
        )
        .join("；")}${running.length > 6 ? ` 等 ${running.length} 个` : ""}。`,
    );
  } else {
    parts.push("目前没有任务在跑。");
  }

  if (queued.length) {
    parts.push(
      `队列里还有 ${queued.length} 个：${queued
        .slice(0, 5)
        .map((task) => task.title)
        .join("、")}${queued.length > 5 ? " 等" : ""}。`,
    );
  }

  if (blocked.length) {
    parts.push(
      `需要你决定的 ${blocked.length} 个：${blocked
        .slice(0, 5)
        .map((task) => `${task.title}（${oneLine(task.error, 60)}）`)
        .join("；")}。`,
    );
  }

  const latest = recentEvents(db, 1)[0];
  if (latest) {
    parts.push(
      `最近一次事件：${latest.type}${latest.task_id ? `（${latest.task_id}）` : ""}，${formatDuration(Date.now() - latest.created_at)} 前。`,
    );
  }

  return parts.join("\n");
}
