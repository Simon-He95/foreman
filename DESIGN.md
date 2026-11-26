# Foreman design

Foreman is an **operations layer for coding-agent fleets**, not another agent
runtime. T3 Code owns threads, tools, approvals, and the worker UI. Foreman
owns the durable facts around them.

This document explains the design decisions behind the code. For user-facing
concepts see [docs/concepts.md](docs/concepts.md); for setup see
[docs/quickstart.md](docs/quickstart.md).

## One sentence

> One long-lived master session should be able to take a new request, dispatch
> it, watch the fleet, and answer "what is running, what finished, and what
> failed — in detail?" from a durable ledger, without making the user visit
> each task thread.

## Principles

1. **One session is the interface.** The master thread is long-lived and is
   the only place the user needs to talk. It dispatches work, absorbs
   completions, and answers for the whole fleet. Worker threads are execution
   details, not navigation targets.
2. **The ledger is the product.** SQLite is the source of truth for tasks,
   leases, attempts, events, inbox items, and chat. Model memory is never the
   source of counts. The master can look up a task's brief, result, error, and
   event trail on demand inside the same conversation.
3. **A completion is a fact, not a message.** A worker ending its turn is not
   proof that work is done. Terminal states append an inbox event; optional
   contracts add machine-checkable evidence.
4. **Silence is not success.** Every running task has a lease and a heartbeat.
   A missing heartbeat is reconciled. A missing T3 thread is marked `lost`
   rather than silently restarted; terminal thread references are cleaned in
   the background.
5. **Push, then reconcile.** The leader consumes terminal events in a batch;
   restart follows the same ledger and reattaches live worker threads by id.
6. **One task, one worker thread.** The unit of delegation is a task. Native
   lineage is an optional T3 view of that task; it does not turn one task into a
   model-chosen swarm, and it is not required for the one-session experience.
7. **T3 executes; Foreman supervises.** Foreman does not reimplement T3's
   agent loop, approvals, worktrees, or provider protocol.
8. **Local-first and explicit.** Loopback is the default; a token is required
   when exposed; project roots are allow-listed. Model/provider intent is
   explicit, capability truth comes from the T3 catalog, and every task stores
   the resolved target plan that the fleet actually executes.
9. **No build step.** Foreman ships plain ESM and static HTML. Node runs the
   source directly, which keeps the install path and debugging story small.

## What Foreman owns

| Foreman owns | T3 Code owns |
| --- | --- |
| Dynamic task ledger and status | Threads and runs |
| Ad-hoc priority queue | Native Workflows (pipelines, schedules, webhooks, approvals) |
| Leases, attempts, retries, recovery | Agent execution and tools |
| Completion inbox and contracts | Approvals and diff/worktree UI |
| Model target resolution + routing policy | Authoritative provider/model catalog |
| Leader prompt and state card | Provider protocol |
| One-session interface and detail lookup | Worker/Lineage UI for debugging |
| Optional native-lineage delegation target | `parentThreadId` / `subagent` lineage |
| Dashboard and ops API | Interactive thread UI |

## One-session contract

The user-facing unit is a conversation, not a task thread. The master session:

- receives new requests and dispatches tasks;
- receives completion/failure/needs-human notifications;
- reads the state card for fleet-wide status;
- can request a **task lookup** when the state card only has a summary.

A lookup is a bounded read against SQLite: task brief, result, error, contract,
thread reference, and the last events, or a `chat:` search over the durable
conversation history. The leader is called again with that lookup appended to
the prompt, then must answer. This avoids both fabricated details and the old
failure mode of telling the user to open a worker thread just to learn what
happened.

For T3-backed FC models, Foreman keeps one internal leader thread per master,
provider, model, and effort and sends every subsequent prompt there. It is an
implementation detail of the one-session interface, not a new user-facing thread
per turn. The other leader backends rebuild their context from SQLite on every
turn.

The worker thread id remains in the ledger for debugging and reattach, and T3
Lineage remains useful when an execution must be inspected. Neither is part of
the normal query path.

## Native lineage is an optional path decision

The one-session interface does not depend on native lineage. The leader always
emits an `add_task` intent; the master ACP bridge may use native delegation when
the project and provider make it possible:

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
task follow the same path; the task's **model target** is independent of whether
it becomes a subagent or a top-level thread. Native lineage compares canonical
project identity (`project_key` / real path), not a user-supplied path string.

## Model target pipeline

A model is never passed around as a bare slug once a task leaves the request
boundary. The control plane resolves one immutable target plan:

```text
tier / route / explicit override
        │
        ▼
T3 catalog snapshot (provider + model advertised?)
        │  no → reject with suggestions
        ▼
reasoning descriptor (option id + advertised values)
        │  map max → xhigh / max / ultra as advertised
        ▼
target_json + provider/model/effort + reasoning option/value
        │
        ├─ local daemon → adapter
        └─ worker claim → assignment.target → worker adapter
```

The catalog is currently a snapshot of T3's provider cache, not a live
capability/auth RPC. The snapshot records `source`, `revision`, `observedAt`,
and `stale`; auth/model-start failures are classified as non-retryable when
possible. A live source can replace the cache implementation without changing
the router, task plan, or adapters.

The target plan is deliberately stored on the task. It gives retries and
diagnostics an audit trail, lets a worker use the control plane's decision even
with a different cache, and prevents a catalog change from silently changing
an already-started task.

## Runtime topology

```text
T3 Code (desktop app or `t3 serve`, default :3773)
   │  threads, tools, approvals, provider instances
   ▼
Foreman `up` (:3777)
   ├─ HTTP dashboard + JSON API
   ├─ daemon: resolve target → claim → lease → poll → verify → retry/reattach
   ├─ thread reconciler: boot + every 15m → missing active = lost; stale links cleared
   ├─ leader loop: drain completion inbox → bounded state card → briefing
   └─ catalog snapshot: T3 provider cache + provenance/staleness
   │
   └─ SQLite: dataDir/foreman.db (tasks carry target_json/project_key)
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
  leader-options.mjs   FC choices + T3 catalog snapshot/provenance
  model-policy.mjs     tier targets, classification, effort vocabulary
  model-catalog.mjs    target resolution, validation, reasoning plans
  reconcile.mjs        automatic T3 thread reconciliation and orphan cleanup
  registry.mjs         canonical project identity / project_key
  server.mjs           HTTP API, auth, project-root checks
  state.mjs            bounded state card shared by every surface
  update.mjs           npm version checks + cached update status
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
- a replacement for T3 Workflows; deterministic pipelines, schedules, webhooks,
  and approvals stay in T3, while Foreman manages the dynamic queue around them
- a promise that a worker solved the semantic problem correctly; contracts are
  evidence, not proof

## Tradeoffs we accept for 1.x

- **Single SQLite writer.** Simple, debuggable, and sufficient for one control
  plane. HA and multi-control-plane coordination are out of scope for now.
- **Polling T3.** More portable than assuming a webhook/MCP event surface. The
  cost is a tick per running task; MCP events are future work.
- **Cache-backed model catalog.** T3's provider cache is the available
  capability source; Foreman records provenance and stale state instead of
  pretending it is live. A live capability/auth RPC is future work. Typed
  `modelTiers` / routes make tier choices explicit, while the catalog prevents
  unadvertised provider/model pairs from starting.
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
- Is the resolved target/identity stored as data rather than re-parsed from a
  string by each boundary?
- Does the README stay focused on onboarding, with detailed reference moved to docs?
