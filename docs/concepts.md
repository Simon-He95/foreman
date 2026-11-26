# Concepts

## Master thread

A T3 thread whose provider is **Foreman (control plane)**. It is the user's
long-lived, single session with the fleet: it takes requests, delegates work,
absorbs completion notifications, and answers for every task. It does not
execute project work itself.

Worker threads are execution details. The user should not need to open them to
learn what happened; ask the master instead.

The T3-backed leader also reuses one **internal leader thread** per master,
provider, model, and effort, so its own context is long-lived instead of
creating a new “leader turn” thread every message. Other leader backends
(`dim`, `dima`, `codex`, `claude`) reconstruct context from SQLite each turn.

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

A task created by the master may be a **native T3 child thread** when lineage is
available. A task created by `foreman add` or an automatic leader wakeup is a
top-level T3 thread. In both cases the user-facing interface remains the master
session.

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

The T3 thread details/Lineage panel can then open the child directly for
debugging. This is optional and not part of the normal one-session workflow.

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

需要完整过程或细节，直接在主会话里问 Foreman。
```

The master ACP agent recognizes the notification marker and ends that turn
without calling the leader, so notifications do not create a second leader turn.

## Task lookup

The state card carries summaries: active tasks, recent completions, and recent
failures. When the user asks for more detail, the leader can emit a `lookup`
instead of guessing or sending the user to a worker thread. Foreman reads the
task and its last events from SQLite, appends that detail to the next leader
call, and the master answers in the same conversation. `lookup: "chat:<terms>"`
opens the durable conversation history instead of the task ledger; a task miss
also falls back to chat search. Lookup is bounded to one object per user turn.

## Trust boundaries

- The dashboard is an ops surface; protect it with a token if not loopback.
- Task titles/briefs/results and web content are untrusted input.
- Worker tokens are separate from the dashboard token and scoped to worker APIs.
- Project roots are allow-listed; don't point them at the whole filesystem.
