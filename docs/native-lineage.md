# Native lineage

Foreman can create a task as a real T3 **subagent child thread** under the
master. This is what makes the T3 Thread details / Lineage panel useful.

## Flow

1. You send a prompt in a T3 thread whose provider is `foreman`.
2. The ACP agent calls `POST /api/ask` with `delegateTasks: true`.
3. The leader returns a pending `add_task` instead of inserting it directly.
4. While the master run is still active, the ACP agent calls T3 MCP
   `delegate_task` with the task brief, model, and effort.
5. T3 creates a child thread with:
   - `parentThreadId = master thread id`
   - `relationshipToParent = subagent`
6. Foreman calls `POST /api/tasks/import` and records the child as a running task.
7. The daemon polls the child, verifies the completion contract, and notifies the
   master.

## Requirements

- **Same project:** the master and the task must be in the same T3 project.
  T3 does not allow a local delegate into a different project. Use a master in
  `demo-repo` for tasks in `demo-repo`; a Scratch master falls back to top-level.
- **Active parent run:** delegation happens inside the master's ACP
  `session/prompt`, so the master run must still be active. Automatic leader
  wakeups happen outside a run and therefore create top-level tasks.
- **T3 MCP:** the Foreman provider process must have
  `T3_ACP_MCP_ENDPOINT` and `T3_ACP_MCP_AUTHORIZATION` (T3 supplies these).

## Fallback behavior

If delegation is unavailable, Foreman falls back to a top-level `t3 thread
start`. The task still runs, but it will not appear under the master's lineage.
The master reply says that the fallback happened.

## Verification

```bash
node src/cli.mjs status
```

The task's `thread_id` will look like a normal T3 id (`mcp:...`) for a
top-level thread, or a delegated-task id
(`thread:delegated-task:...`) for a native child.

In the T3 DB:

```sql
select thread_id, title,
       json_extract(payload_json, '$.lineage.parentThreadId') as parent,
       json_extract(payload_json, '$.lineage.relationshipToParent') as rel
from orchestration_v2_projection_threads;
```

## Links

A native child link is returned as a T3 thread reference and may look like:

```text
t3-thread://v2/<project-id>/thread:delegated-task:...
```

Foreman stores an `https://app.t3.codes/...` link for the dashboard/notifications
while keeping the T3-native reference in the master message.
