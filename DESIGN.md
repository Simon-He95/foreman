# Foreman design

Foreman is an **operations layer for coding-agent fleets**, not another agent
runtime. T3 Code owns threads, tools, approvals, and the worker UI. Foreman
owns the durable facts around them.

This document explains the design decisions behind the code. For user-facing
concepts see [docs/concepts.md](docs/concepts.md); for setup see
[docs/quickstart.md](docs/quickstart.md).

## One sentence

> A leader should be able to answer "what is running, what is queued, what
> finished, and what failed?" from a durable ledger, without remembering a
> conversation.

## Principles

1. **The ledger is the product.** SQLite is the source of truth for tasks,
   leases, attempts, events, inbox items, and chat. Model memory is never the
   source of counts.
2. **A completion is a fact, not a message.** A worker ending its turn is not
   proof that work is done. Terminal states append an inbox event; optional
   contracts add machine-checkable evidence.
3. **Silence is not success.** Every running task has a lease and a heartbeat.
   A missing heartbeat is requeued or failed, never silently marked done.
4. **Push, then reconcile.** The leader consumes terminal events in a batch;
   restart follows the same ledger and reattaches live worker threads by id.
5. **One task, one worker thread.** The unit of delegation is a task. Native
   lineage makes that task a T3 child thread; it does not turn one task into a
   model-chosen swarm.
6. **T3 executes; Foreman supervises.** Foreman does not reimplement T3's
   agent loop, approvals, worktrees, or provider protocol.
7. **Local-first and explicit.** Loopback is the default; a token is required
   when exposed; project roots are allow-listed; model/provider selection is
   explicit configuration.
8. **No build step.** Foreman ships plain ESM and static HTML. Node runs the
   source directly, which keeps the install path and debugging story small.

## What Foreman owns

| Foreman owns | T3 Code owns |
| --- | --- |
| Task ledger and status | Threads and runs |
| Leases, attempts, retries, recovery | Agent execution and tools |
| Completion inbox and contracts | Approvals and diff/worktree UI |
| Leader prompt and state card | Provider protocol and model catalog |
| Native-lineage delegation target | `parentThreadId` / `subagent` lineage |
| Dashboard and ops API | Interactive chat and worker UI |

## Native lineage is a path decision

The leader always emits an `add_task` intent. The master ACP bridge then decides
whether native delegation is possible:

```text
Foreman master thread
        │  /api/ask with delegateTasks
        ▼
leader returns a pending add_task
        │
        ├─ same project + T3 MCP available
        │     → delegate_task → child thread (subagent)
        │
        └─ different project / MCP unavailable / delegation error
              → /api/tasks → daemon → top-level thread
```

This is not a per-task model decision. A read-only research task and a coding
task follow the same path; the task's **model tier** is independent of whether
it becomes a subagent or a top-level thread.

## Runtime topology

```text
T3 Code (desktop app or `t3 serve`, default :3773)
   │  threads, tools, approvals, provider instances
   ▼
Foreman `up` (:3777)
   ├─ HTTP dashboard + JSON API
   ├─ daemon: claim → lease → poll → verify → retry/reattach
   └─ leader loop: drain completion inbox → bounded state card → briefing
   │
   └─ SQLite: dataDir/foreman.db
```

The dashboard is optional. The T3 master is optional for CLI-only use, but it is
required for in-T3 chat and completion notifications. Exactly one Foreman
process may own a data directory; the pid lock enforces that.

## Module map

```text
src/
  cli.mjs              command dispatch, init, status, task/master/project commands
  config.mjs           config/env/flags resolution and paths
  db.mjs               SQLite schema and ledger primitives
  daemon.mjs           claim, lease, poll, retry, reattach
  leader.mjs           leader prompt, model policy actions, fallback
  model-policy.mjs     tier classification and provider reasoning mapping
  server.mjs           HTTP API, auth, project-root checks
  state.mjs            bounded state card shared by every surface
  adapters/            mock and T3 execution adapters
  worker-*.mjs         remote/local worker protocol and runner
public/
  index.html           single-file dashboard; split CSS/JS if it grows
tools/
  foreman-acp-agent.mjs  ACP bridge used by the Foreman provider
  dim-acp-wrapper.mjs    DimAgent permission wrapper
  acp-mock-agent.mjs     deterministic ACP provider for smoke tests
scripts/
  setup-t3-*.mjs       one-time T3/provider registration helpers
  release.mjs          one-command npm release (bumpp + publish + tag)
docs/
  user guides, concepts, configuration, workers, recipes, assets
test/
  integration.test.mjs end-to-end ledger, daemon, API, worker, and ACP tests
```

`tools/` is for runtime integrations that ship with the product. `scripts/` is
for one-time setup and maintainer workflows. If either grows, split by domain
rather than adding more top-level files.

## Non-goals

Foreman is not:

- a model or an agent runtime
- a T3 replacement or a second UI
- a distributed task scheduler with multiple writers or HA
- a sandbox, secret manager, or remote-execution security boundary
- a workflow engine that infers arbitrary graphs from natural language
- a promise that a worker solved the semantic problem correctly; contracts are
  evidence, not proof

## Tradeoffs we accept for alpha

- **Single SQLite writer.** Simple, debuggable, and sufficient for one control
  plane. HA and multi-control-plane coordination are out of scope for now.
- **Polling T3.** More portable than assuming a webhook/MCP event surface. The
  cost is a tick per running task; MCP events are future work.
- **Static model catalog.** Explicit `modelFast` / `modelStrong` / `modelCoding`
  keeps selection predictable. Upstream model changes require config updates
  until capability discovery is implemented.
- **HTTP worker transport.** Easy to deploy over Tailscale/LAN; TLS and
  authentication are deliberately the operator's responsibility.
- **Monolithic dashboard and integration test.** Fast to iterate while the
  product shape is changing; split when the public surface stabilizes.

## Design review checklist

Before adding a feature, ask:

- Does it make the ledger more or less authoritative?
- Does it duplicate T3's responsibilities?
- Can it be explained from `foreman status` without model memory?
- What happens on restart, missing heartbeat, or provider failure?
- Is the default safe for local use and explicit for remote use?
- Does the README stay focused on onboarding, with detailed reference moved to docs?
