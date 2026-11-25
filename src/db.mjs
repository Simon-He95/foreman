import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  local_path TEXT NOT NULL,
  default_adapter TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'online',
  capacity INTEGER NOT NULL DEFAULT 1,
  running INTEGER NOT NULL DEFAULT 0,
  projects TEXT,
  version TEXT,
  protocol_version INTEGER,
  token_hash TEXT,
  token_hint TEXT,
  token_created_at INTEGER,
  last_heartbeat_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  adapter TEXT NOT NULL DEFAULT 'mock',
  project_id TEXT,
  project_path TEXT NOT NULL,
  worker_id TEXT,
  attempt_id TEXT,
  permission_mode TEXT,
  provider TEXT,
  model TEXT,
  effort TEXT,
  completion_token TEXT,
  artifact_path TEXT,
  artifact_contains TEXT,
  require_diff INTEGER NOT NULL DEFAULT 0,
  thread_id TEXT,
  thread_link TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  lease_until INTEGER,
  not_before INTEGER,
  heartbeat_at INTEGER,
  last_polled_at INTEGER,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  type TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  task_id TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_finished ON tasks(status, finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);
CREATE INDEX IF NOT EXISTS idx_inbox_unconsumed ON inbox(consumed_at, seq);
CREATE INDEX IF NOT EXISTS idx_chat_id ON chat(id);
`;

export const STATUSES = [
  "queued",
  "running",
  "blocked",
  "done",
  "failed",
  "lost",
  "cancelled",
];

const TASK_FIELDS = new Set([
  "parent_id",
  "title",
  "brief",
  "status",
  "priority",
  "adapter",
  "project_id",
  "project_path",
  "worker_id",
  "attempt_id",
  "permission_mode",
  "provider",
  "model",
  "effort",
  "completion_token",
  "artifact_path",
  "artifact_contains",
  "require_diff",
  "thread_id",
  "thread_link",
  "attempts",
  "max_attempts",
  "lease_until",
  "not_before",
  "heartbeat_at",
  "last_polled_at",
  "result",
  "error",
  "started_at",
  "finished_at",
]);

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const SCHEMA_VERSION = 2;

// Additive migrations only. The schema is created with CREATE IF NOT EXISTS,
// then each migration brings older ledgers up to the current shape. Never
// rewrite or drop a user's task/chat rows in a migration.
const MIGRATIONS = [
  {
    version: 1,
    up(db) {
      ensureColumn(db, "tasks", "completion_token", "TEXT");
      ensureColumn(db, "tasks", "artifact_path", "TEXT");
      ensureColumn(db, "tasks", "artifact_contains", "TEXT");
      ensureColumn(db, "tasks", "require_diff", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "tasks", "not_before", "INTEGER");
      ensureColumn(db, "tasks", "project_id", "TEXT");
      ensureColumn(db, "tasks", "worker_id", "TEXT");
      ensureColumn(db, "tasks", "attempt_id", "TEXT");
      ensureColumn(db, "tasks", "thread_link", "TEXT");
      ensureColumn(db, "tasks", "model", "TEXT");
      ensureColumn(db, "tasks", "effort", "TEXT");
      ensureColumn(db, "workers", "token_hash", "TEXT");
      ensureColumn(db, "workers", "token_hint", "TEXT");
      ensureColumn(db, "workers", "token_created_at", "INTEGER");
      ensureColumn(db, "workers", "protocol_version", "INTEGER");
    },
  },
  {
    version: 2,
    up(db) {
      ensureColumn(db, "tasks", "provider", "TEXT");
    },
  },
];

export function schemaVersion(db) {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version) || 0;
}

function migrate(db) {
  const current = schemaVersion(db);
  if (current >= SCHEMA_VERSION) return;
  for (const migration of MIGRATIONS) {
    if (current >= migration.version) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  if (dbPath !== ":memory:") {
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // best effort
    }
  }
  return db;
}

export function newId(prefix = "tsk") {
  return `${prefix}_${Date.now().toString(36)}_${crypto
    .randomBytes(3)
    .toString("hex")}`;
}

export function now() {
  return Date.now();
}

export function getTask(db, id) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) ?? null;
}

export function listTasks(db, { status, limit = 200 } = {}) {
  if (status) {
    return db
      .prepare(
        "SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC LIMIT ?",
      )
      .all(status, limit);
  }
  return db
    .prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?")
    .all(limit);
}

export function dashboardTasks(db, { terminalLimit = 200 } = {}) {
  const active = db
    .prepare(
      "SELECT * FROM tasks WHERE status IN ('queued', 'running', 'blocked') ORDER BY priority DESC, created_at ASC",
    )
    .all();
  const recent = db
    .prepare(
      "SELECT * FROM tasks WHERE status NOT IN ('queued', 'running', 'blocked') ORDER BY COALESCE(finished_at, updated_at) DESC LIMIT ?",
    )
    .all(terminalLimit);
  return [...active, ...recent];
}

export function recentTerminalTasks(db, statuses, limit = 12) {
  if (!statuses.length) return [];
  const marks = statuses.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT * FROM tasks WHERE status IN (${marks})
       ORDER BY COALESCE(finished_at, updated_at) DESC LIMIT ?`,
    )
    .all(...statuses, limit);
}

export function addProject(db, input) {
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error("project name is required");
  if (/[\\/]/.test(name)) throw new Error("project name cannot contain / or \\");
  const localPath = String(input.path ?? "").trim();
  if (!localPath) throw new Error("project path is required");
  if (getProject(db, name)) throw new Error(`project already exists: ${name}`);
  const id = input.id || newId("prj");
  const ts = now();
  db.prepare(
    `INSERT INTO projects
      (id, name, local_path, default_adapter, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    localPath,
    input.adapter || null,
    input.enabled === false ? 0 : 1,
    ts,
    ts,
  );
  return getProject(db, id);
}

export function getProject(db, idOrName) {
  const key = String(idOrName ?? "").trim();
  if (!key) return null;
  return (
    db
      .prepare("SELECT * FROM projects WHERE id = ? OR name = ? LIMIT 1")
      .get(key, key) ?? null
  );
}

export function listProjects(db, { includeDisabled = false } = {}) {
  const where = includeDisabled ? "" : "WHERE enabled = 1";
  return db
    .prepare(`SELECT * FROM projects ${where} ORDER BY name ASC`)
    .all();
}

export function updateProject(db, idOrName, patch = {}) {
  const project = getProject(db, idOrName);
  if (!project) return null;
  const fields = [];
  const values = [];
  for (const key of ["name", "local_path", "default_adapter", "enabled"]) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(key === "enabled" ? (patch[key] ? 1 : 0) : patch[key]);
    }
  }
  if (fields.length === 0) return project;
  db.prepare(
    `UPDATE projects SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`,
  ).run(...values, now(), project.id);
  return getProject(db, project.id);
}

export function upsertWorker(db, input) {
  const id = String(input.id ?? "").trim();
  if (!id) throw new Error("worker id is required");
  const ts = now();
  db.prepare(
    `INSERT INTO workers
      (id, name, status, capacity, running, projects, version,
       protocol_version, last_heartbeat_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       status = excluded.status,
       capacity = excluded.capacity,
       running = excluded.running,
       projects = excluded.projects,
       version = excluded.version,
       protocol_version = excluded.protocol_version,
       last_heartbeat_at = excluded.last_heartbeat_at,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    input.name || id,
    input.status || "online",
    Math.max(1, Number(input.capacity) || 1),
    Math.max(0, Number(input.running) || 0),
    input.projects ? JSON.stringify(input.projects) : null,
    input.version || null,
    Number(input.protocolVersion) || null,
    ts,
    ts,
    ts,
  );
  return getWorker(db, id);
}

export function getWorker(db, id) {
  return db.prepare("SELECT * FROM workers WHERE id = ?").get(String(id)) ?? null;
}

export function listWorkers(db) {
  return db.prepare("SELECT * FROM workers ORDER BY id").all();
}

export function touchWorker(db, id, patch = {}) {
  const current = getWorker(db, id);
  if (!current) return null;
  const ts = now();
  const status = patch.status || current.status;
  const capacity = Math.max(1, Number(patch.capacity ?? current.capacity) || 1);
  const running = Math.max(0, Number(patch.running ?? current.running) || 0);
  const projects =
    patch.projects === undefined
      ? current.projects
      : JSON.stringify(patch.projects);
  db.prepare(
    `UPDATE workers SET status = ?, capacity = ?, running = ?, projects = ?,
       last_heartbeat_at = ?, updated_at = ? WHERE id = ?`,
  ).run(status, capacity, running, projects, ts, ts, id);
  return getWorker(db, id);
}

export function setWorkerStatus(db, id, status) {
  const worker = getWorker(db, id);
  if (!worker) return null;
  const value = ["online", "draining", "offline"].includes(status)
    ? status
    : "offline";
  db.prepare(
    "UPDATE workers SET status = ?, updated_at = ? WHERE id = ?",
  ).run(value, now(), id);
  return getWorker(db, id);
}

export function setWorkerToken(db, id, { hash, hint } = {}) {
  const worker = getWorker(db, id);
  if (!worker) return null;
  db.prepare(
    "UPDATE workers SET token_hash = ?, token_hint = ?, token_created_at = ?, updated_at = ? WHERE id = ?",
  ).run(hash, hint, now(), now(), id);
  return getWorker(db, id);
}

export function revokeWorkerToken(db, id) {
  const worker = getWorker(db, id);
  if (!worker) return null;
  db.prepare(
    "UPDATE workers SET token_hash = NULL, token_hint = NULL, token_created_at = NULL, updated_at = ? WHERE id = ?",
  ).run(now(), id);
  return getWorker(db, id);
}

export function getWorkerByTokenHash(db, hash) {
  const key = String(hash || "");
  if (!key) return null;
  return (
    db
      .prepare("SELECT * FROM workers WHERE token_hash = ? LIMIT 1")
      .get(key) ?? null
  );
}

export function runningTasks(db) {
  return db
    .prepare("SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at ASC")
    .all();
}

export function queuedTasks(db, limit, at = Date.now()) {
  return db
    .prepare(
      "SELECT * FROM tasks WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY priority DESC, created_at ASC LIMIT ?",
    )
    .all(at, limit);
}

export function addTask(db, input) {
  const title = String(input.title ?? "").trim().slice(0, 200);
  if (!title) throw new Error("title is required");
  const brief = String(input.brief ?? title).slice(0, 20000);
  const completionToken = input.completionToken
    ? String(input.completionToken).trim().slice(0, 200)
    : null;
  const artifactPath = input.artifactPath
    ? String(input.artifactPath).trim().slice(0, 500)
    : null;
  const artifactContains = input.artifactContains
    ? String(input.artifactContains).slice(0, 4000)
    : null;
  const provider = input.provider
    ? String(input.provider).trim().slice(0, 120)
    : null;
  const model = input.model ? String(input.model).trim().slice(0, 200) : null;
  const effort = input.effort ? String(input.effort).trim().slice(0, 40) : null;
  const id = input.id || newId("tsk");
  const ts = now();
  const requestedPriority = Number(input.priority);
  const priority = Number.isFinite(requestedPriority)
    ? Math.max(0, Math.min(100, requestedPriority))
    : 50;
  db.prepare(
    `INSERT INTO tasks
      (id, parent_id, title, brief, status, priority, adapter, project_id,
       project_path, worker_id, permission_mode, provider, model, effort, completion_token, artifact_path,
       artifact_contains, require_diff, thread_id, attempts, max_attempts,
       lease_until, not_before, heartbeat_at, last_polled_at, result, error,
       created_at, updated_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?,
             NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
  ).run(
    id,
    input.parentId ?? null,
    title,
    brief,
    priority,
    input.adapter || "mock",
    input.projectId ?? null,
    String(input.projectPath || process.cwd()),
    input.workerId ?? null,
    input.permissionMode ?? null,
    provider,
    model,
    effort,
    completionToken,
    artifactPath,
    artifactContains,
    input.requireDiff ? 1 : 0,
    Math.max(1, Math.min(10, Number(input.maxAttempts) || 2)),
    ts,
    ts,
  );
  appendEvent(db, id, "queued", {
    title,
    priority,
    adapter: input.adapter || "mock",
    provider,
    model,
    effort,
  });
  return getTask(db, id);
}

export function importRunningTask(db, input) {
  const threadId = String(input.threadId || "").trim();
  if (!threadId) throw new Error("threadId is required");
  db.exec("BEGIN IMMEDIATE");
  try {
    const task = addTask(db, { ...input, id: input.id });
    const ts = now();
    const leaseMs = Math.max(1000, Number(input.leaseMs) || 600000);
    updateTask(db, task.id, {
      status: "running",
      thread_id: threadId,
      thread_link: input.threadLink ? String(input.threadLink) : null,
      attempts: 1,
      heartbeat_at: ts,
      last_polled_at: ts,
      started_at: ts,
      lease_until: ts + leaseMs,
      error: null,
    });
    appendEvent(db, task.id, "imported_thread", {
      threadId,
      threadLink: input.threadLink ?? null,
      childRunId: input.childRunId ?? null,
    });
    db.exec("COMMIT");
    return getTask(db, task.id);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw error;
  }
}

export function updateTask(db, id, patch) {
  const keys = Object.keys(patch).filter((key) => TASK_FIELDS.has(key));
  if (keys.length === 0) return getTask(db, id);
  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  const values = keys.map((key) => patch[key] ?? null);
  db.prepare(
    `UPDATE tasks SET ${assignments}, updated_at = ? WHERE id = ?`,
  ).run(...values, now(), id);
  return getTask(db, id);
}

export function counts(db) {
  const out = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const row of db
    .prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status")
    .all()) {
    out[row.status] = Number(row.count);
  }
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}

export function appendEvent(db, taskId, type, payload = null) {
  db.prepare(
    "INSERT INTO events (task_id, type, payload, created_at) VALUES (?, ?, ?, ?)",
  ).run(
    taskId ?? null,
    type,
    payload === null ? null : JSON.stringify(payload),
    now(),
  );
}

export function stateVersion(db) {
  const row = db
    .prepare(
      `SELECT
         (SELECT COALESCE(MAX(seq), 0) FROM events) AS events,
         (SELECT COALESCE(MAX(updated_at), 0) FROM tasks) AS tasks,
         (SELECT COALESCE(MAX(id), 0) FROM chat) AS chat,
         (SELECT COALESCE(MAX(updated_at), 0) FROM projects) AS projects,
         (SELECT COUNT(*) FROM projects) AS project_count,
         (SELECT COALESCE(MAX(updated_at), 0) FROM workers) AS workers,
         (SELECT COUNT(*) FROM workers) AS worker_count,
         (SELECT COUNT(*) FROM tasks WHERE status IN ('queued', 'running', 'blocked')) AS active`,
    )
    .get();
  const bucket = Number(row.active) > 0 ? Math.floor(Date.now() / 5000) : 0;
  return `${row.events}-${row.tasks}-${row.chat}-${row.projects}-${row.project_count}-${row.workers}-${row.worker_count}-${bucket}`;
}

export function backupDb(db, targetPath) {
  const target = path.resolve(String(targetPath));
  if (fs.existsSync(target)) {
    throw new Error(`backup target already exists: ${target}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // best effort
  }
  return target;
}

export function compactDb(
  db,
  { keepEvents = 20000, keepChat = 2000, consumedInboxDays = 7 } = {},
) {
  const eventLimit = Math.max(0, Number(keepEvents) || 0);
  const chatLimit = Math.max(0, Number(keepChat) || 0);
  const days = Math.max(0, Number(consumedInboxDays) || 0);
  const cutoff = now() - days * 24 * 60 * 60 * 1000;
  const result = { events: 0, chat: 0, inbox: 0 };
  db.exec("BEGIN");
  try {
    result.events = Number(
      db
        .prepare(
          "DELETE FROM events WHERE seq <= (SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?)",
        )
        .run(eventLimit).changes,
    );
    result.chat = Number(
      db
        .prepare(
          "DELETE FROM chat WHERE id <= (SELECT id FROM chat ORDER BY id DESC LIMIT 1 OFFSET ?)",
        )
        .run(chatLimit).changes,
    );
    result.inbox = Number(
      db
        .prepare(
          "DELETE FROM inbox WHERE consumed_at IS NOT NULL AND consumed_at < ?",
        )
        .run(cutoff).changes,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  return result;
}

export function recentEvents(db, limit = 50) {
  return db
    .prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?")
    .all(limit)
    .map((row) => ({
      ...row,
      payload: row.payload ? safeJson(row.payload) : null,
    }));
}

export function appendInbox(db, kind, taskId = null, payload = null) {
  db.prepare(
    "INSERT INTO inbox (kind, task_id, payload, created_at) VALUES (?, ?, ?, ?)",
  ).run(
    kind,
    taskId,
    payload === null ? null : JSON.stringify(payload),
    now(),
  );
}

export function unconsumedInbox(db, limit = 100) {
  return db
    .prepare(
      "SELECT * FROM inbox WHERE consumed_at IS NULL ORDER BY seq ASC LIMIT ?",
    )
    .all(limit)
    .map((row) => ({
      ...row,
      payload: row.payload ? safeJson(row.payload) : null,
    }));
}

export function consumeInbox(db, seqs) {
  if (!seqs || seqs.length === 0) return 0;
  const ts = now();
  const stmt = db.prepare(
    "UPDATE inbox SET consumed_at = ? WHERE seq = ? AND consumed_at IS NULL",
  );
  let changed = 0;
  for (const seq of seqs) changed += Number(stmt.run(ts, seq).changes);
  return changed;
}

export function addChat(db, role, content) {
  const ts = now();
  db.prepare(
    "INSERT INTO chat (role, content, created_at) VALUES (?, ?, ?)",
  ).run(role, content, ts);
  return { role, content, created_at: ts };
}

export function recentChat(db, limit = 50) {
  return db
    .prepare(
      "SELECT * FROM (SELECT * FROM chat ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
    )
    .all(limit);
}

export function getMeta(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function setMasterFc(db, threadId, fc) {
  if (!threadId || !fc) return;
  setMeta(
    db,
    `master_fc:${threadId}`,
    JSON.stringify({
      provider: String(fc.provider || ""),
      model: String(fc.model || ""),
      effort: String(fc.effort || "auto"),
      label: fc.label ? String(fc.label) : undefined,
      updated_at: Date.now(),
    }),
  );
}

export function getMasterFc(db, threadId) {
  if (!threadId) return null;
  const raw = getMeta(db, `master_fc:${threadId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listMasterFcs(db) {
  return db
    .prepare("SELECT key, value FROM meta WHERE key LIKE 'master_fc:%' ORDER BY key")
    .all()
    .map((row) => {
      let value = null;
      try {
        value = JSON.parse(row.value);
      } catch {
        // ignore malformed optional metadata
      }
      return { threadId: row.key.slice("master_fc:".length), ...(value || {}) };
    })
    .filter((row) => row.provider && row.model);
}

export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
