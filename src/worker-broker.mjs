import {
  appendEvent,
  getTask,
  getWorker,
  listWorkers,
  newId,
  touchWorker,
  updateTask,
  upsertWorker,
} from "./db.mjs";
import { WORKER_PROTOCOL_VERSION } from "./protocol.mjs";

export function registerWorker(db, input) {
  const id = String(input.id ?? "").trim();
  if (!id) {
    const error = new Error("worker id is required");
    error.status = 400;
    throw error;
  }
  if (Number(input.protocolVersion) !== WORKER_PROTOCOL_VERSION) {
    const error = new Error(
      `worker protocol ${input.protocolVersion ?? "missing"} is incompatible; control requires ${WORKER_PROTOCOL_VERSION}`,
    );
    error.status = 426;
    error.requiredProtocolVersion = WORKER_PROTOCOL_VERSION;
    throw error;
  }
  const existing = getWorker(db, id);
  let projects = null;
  if (Array.isArray(input.projects)) {
    projects = input.projects.map(String).slice(0, 100);
  } else if (existing?.projects) {
    try {
      const parsed = JSON.parse(existing.projects);
      projects = Array.isArray(parsed) ? parsed : null;
    } catch {
      projects = null;
    }
  }
  const worker = upsertWorker(db, {
    id,
    name: input.name ? String(input.name).slice(0, 120) : id,
    capacity: Math.max(1, Math.min(64, Number(input.capacity) || 1)),
    running: Number(input.running) || 0,
    projects,
    version: input.version ? String(input.version).slice(0, 80) : null,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    status: existing?.status === "draining" ? "draining" : "online",
  });
  return worker;
}

export function leaseForAdapter(config, adapter) {
  return adapter === "t3"
    ? config.t3LeaseMs || config.leaseMs
    : config.mockLeaseMs || config.leaseMs;
}

export function claimTasksForWorker(db, config, { workerId, limit } = {}) {
  const worker = getWorker(db, workerId);
  if (!worker) {
    const error = new Error(`unknown worker: ${workerId}`);
    error.status = 404;
    throw error;
  }
  const running = db
    .prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'running' AND worker_id = ?")
    .get(workerId);
  if (worker.status === "draining") {
    touchWorker(db, workerId, { running: Number(running.count || 0) });
    return [];
  }
  if (worker.status !== "online") {
    const error = new Error(`worker ${workerId} is ${worker.status}; resume it first`);
    error.status = 409;
    throw error;
  }
  const free = Math.max(
    0,
    Number(worker.capacity) - Number(running.count || 0),
  );
  const capacity = Math.max(0, Math.min(Number(limit) || free, free));
  if (capacity === 0) {
    touchWorker(db, workerId, { running: Number(running.count || 0) });
    return [];
  }

  let projectNames = [];
  if (worker.projects) {
    try {
      const parsed = JSON.parse(worker.projects);
      if (Array.isArray(parsed)) projectNames = parsed.map(String).filter(Boolean);
    } catch {
      projectNames = [];
    }
  }
  const projectFilter = projectNames.length
    ? `AND p.name IN (${projectNames.map(() => "?").join(", ")})`
    : "";
  const candidates = db
    .prepare(
      `SELECT t.*, p.name AS project_name FROM tasks t
       LEFT JOIN projects p ON t.project_id = p.id
       WHERE t.status = 'queued'
         AND (t.worker_id IS NULL OR t.worker_id = ?)
         AND (t.not_before IS NULL OR t.not_before <= ?)
         ${projectFilter}
       ORDER BY t.priority DESC, t.created_at ASC
       LIMIT ?`,
    )
    .all(workerId, Date.now(), ...projectNames, capacity);

  const claimed = [];
  for (const task of candidates) {
    const ts = Date.now();
    const lease = leaseForAdapter(config, task.adapter);
    const attemptId = newId("att");
    const updated = updateTask(db, task.id, {
      status: "running",
      worker_id: workerId,
      attempt_id: attemptId,
      attempts: task.attempts + 1,
      thread_id: null,
      started_at: ts,
      heartbeat_at: ts,
      last_polled_at: ts,
      lease_until: ts + lease,
      not_before: null,
      error: null,
      result: null,
      finished_at: null,
    });
    appendEvent(db, task.id, "worker_claimed", {
      workerId,
      attempt: updated.attempts,
      attemptId,
    });
    claimed.push({ ...updated, project_name: task.project_name });
  }
  touchWorker(db, workerId, {
    running: Number(running.count || 0) + claimed.length,
    status: "online",
  });
  return claimed;
}

export function touchWorkerTask(
  db,
  config,
  { workerId, taskId, attemptId, threadId } = {},
) {
  const worker = touchWorker(db, workerId);
  if (!worker) {
    const error = new Error(`unknown worker: ${workerId}`);
    error.status = 404;
    throw error;
  }
  if (!taskId) return null;
  const task = getTask(db, taskId);
  if (!task) {
    const error = new Error(`task not found: ${taskId}`);
    error.status = 404;
    throw error;
  }
  if (task.worker_id !== workerId || task.status !== "running") {
    const error = new Error(`task ${taskId} is not running on worker ${workerId}`);
    error.status = 409;
    throw error;
  }
  if (task.attempt_id && task.attempt_id !== attemptId) {
    const error = new Error(`stale attempt for ${taskId}`);
    error.status = 409;
    throw error;
  }
  const ts = Date.now();
  return updateTask(db, taskId, {
    thread_id: threadId ? String(threadId).slice(0, 300) : task.thread_id,
    heartbeat_at: ts,
    last_polled_at: ts,
    lease_until: ts + leaseForAdapter(config, task.adapter),
  });
}

export function releaseWorkerTask(db, workerId) {
  const running = db
    .prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'running' AND worker_id = ?")
    .get(workerId);
  return touchWorker(db, workerId, {
    running: Number(running.count || 0),
    status: "online",
  });
}

export function workerAssignments(db, workerId) {
  return db
    .prepare(
      `SELECT t.*, p.name AS project_name FROM tasks t
       LEFT JOIN projects p ON t.project_id = p.id
       WHERE t.worker_id = ? AND t.status = 'running'
       ORDER BY t.started_at ASC`,
    )
    .all(workerId);
}

export function workerSnapshot(db, { staleMs = 30000 } = {}) {
  const now = Date.now();
  return listWorkers(db).map((worker) => {
    const { token_hash, token_hint, ...safe } = worker;
    let projects = [];
    if (worker.projects) {
      try {
        projects = JSON.parse(worker.projects);
      } catch {
        projects = [String(worker.projects)];
      }
    }
    return {
      ...safe,
      projects,
      tokenHint: token_hint || null,
      online: Boolean(
        worker.last_heartbeat_at && now - worker.last_heartbeat_at < staleMs,
      ),
    };
  });
}
