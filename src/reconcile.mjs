import { appendEvent, listTasks, updateTask } from "./db.mjs";

const ACTIVE_STATUSES = new Set(["queued", "running", "blocked"]);

/**
 * Compare T3 task thread references with the live T3 server.
 *
 * This never deletes tasks and never retries work. A missing thread on an
 * active task is marked `lost` so the daemon cannot silently recreate it;
 * terminal tasks keep their history but lose the dead link. Run with
 * `apply: false` first to inspect the changes.
 */
export async function reconcileT3Threads(
  db,
  { adapter, apply = false, limit = 500 } = {},
) {
  if (!adapter || typeof adapter.show !== "function") {
    throw new Error("reconcile requires a T3 adapter with show()");
  }
  const tasks = listTasks(db, { limit }).filter(
    (task) => task.adapter === "t3" && task.thread_id,
  );
  const result = {
    checked: 0,
    missing: [],
    updated: 0,
    errors: [],
  };

  for (const task of tasks) {
    result.checked += 1;
    let outcome;
    try {
      outcome = await adapter.show(task);
    } catch (error) {
      result.errors.push({
        taskId: task.id,
        threadId: task.thread_id,
        error: error.message,
      });
      continue;
    }
    if (outcome.state !== "unknown") continue;

    const missing = {
      taskId: task.id,
      title: task.title,
      status: task.status,
      threadId: task.thread_id,
      threadLink: task.thread_link,
    };
    result.missing.push(missing);
    if (!apply) continue;

    const active = ACTIVE_STATUSES.has(task.status);
    if (active) {
      const reason = `T3 thread ${task.thread_id} is no longer available; marked lost during reconcile (was ${task.status}); not restarted automatically`;
      updateTask(db, task.id, {
        status: "lost",
        thread_id: null,
        thread_link: null,
        lease_until: null,
        heartbeat_at: null,
        last_polled_at: null,
        error: reason,
        finished_at: Date.now(),
      });
      appendEvent(db, task.id, "thread_missing", {
        threadId: task.thread_id,
        previousStatus: task.status,
        action: "marked_lost",
      });
      result.updated += 1;
      continue;
    }

    if (task.thread_id || task.thread_link) {
      updateTask(db, task.id, {
        thread_id: null,
        thread_link: null,
      });
      appendEvent(db, task.id, "thread_missing", {
        threadId: task.thread_id,
        action: "cleared_link",
      });
      result.updated += 1;
    }
  }

  return result;
}
