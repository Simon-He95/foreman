# Concepts

## Master thread

A T3 thread whose provider is **Foreman (control plane)**. It is a chat
surface for the Foreman leader. It does not execute project work; it delegates.

A thread with provider `dim`, `codex`, or `claude` is a worker/chat thread and
will do work directly. It is not the Foreman master.

## Control plane

`src/cli.mjs up` starts:

- HTTP dashboard and JSON API on `:3777`
- task daemon (claims/starts/polls tasks)
- leader loop (drains completion events)

The control plane stores state in SQLite (`<dataDir>/foreman.db`). State cards,
the leader prompt, and the dashboard all read from that ledger.

## Task

A durable unit of work with a title, brief, project, adapter, priority,
completion contract, model, and effort. States:

`queued → running → done | failed | blocked | cancelled`

A task created by the master is a **native T3 child thread**. A task created by
`foreman add` or an automatic leader wakeup is a top-level T3 thread.

## Native lineage

When the master and task share a project, the ACP agent calls T3
`delegate_task`; T3 records:

```json
{
  "lineage": {
    "parentThreadId": "<master>",
    "relationshipToParent": "subagent",
    "rootThreadId": "<master>"
  }
}
```

The T3 thread details/Lineage panel can then open the child directly.

## Model and effort

Every task can carry a provider/model pair and an effort level. The leader
selects a difficulty tier (light / standard / deep / coding), and explicit user
requests override the tier. The control plane resolves the pair against the T3
catalog, records the actual reasoning option/value, and stores the result as a
target plan. Workers execute that plan instead of re-resolving it against a
different local cache. See [models and effort](models-and-effort.md).

## Completion contract

Optional evidence that a task really finished:

- `DONE` token as a standalone line
- artifact path / content
- git diff present

A contract is a safety check, not proof of semantic correctness. If a worker
returns a good result without the token, the task is marked `blocked`, not
`done`.

## Notifications

Terminal states are pushed with `t3 thread send` to the bound master:

```text
📣 Foreman：✅ 完成：任务标题（tsk_...）· 4s
<result>
https://app.t3.codes/threads/.../...
```

The master ACP agent recognizes the notification marker and ends that turn
without calling the leader, so notifications do not create a second leader turn.

## Trust boundaries

- The dashboard is an ops surface; protect it with a token if not loopback.
- Task titles/briefs/results and web content are untrusted input.
- Worker tokens are separate from the dashboard token and scoped to worker APIs.
- Project roots are allow-listed; don't point them at the whole filesystem.
