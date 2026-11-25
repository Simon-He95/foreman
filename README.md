# Foreman

**An always-on control plane for coding-agent fleets.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/Simon-He95/foreman/actions/workflows/ci.yml/badge.svg)](https://github.com/Simon-He95/foreman/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-339933.svg)](package.json)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#status)

You talk to one leader. The leader keeps a task ledger, a daemon leases work to
worker threads, and every completion wakes the leader with a state card built
from SQLite — not from model memory.

![Foreman dashboard](docs/assets/dashboard-live.png)

Foreman is the missing operations layer between you and a coding-agent UI:

- **Durable ledger** — tasks, leases, attempts, events, inbox, chat. Restarting
  the process does not forget what was running.
- **Leases, not guesses** — a silent worker is not a completed worker. Missing
  heartbeats are requeued or failed, not marked done.
- **Push completions** — terminal states land in an inbox and wake the leader;
  you do not have to keep asking "are we there yet?".
- **One answer** — counts and status come from `buildStateCard()`, shared by
  the leader, dashboard, API, and notifications.
- **Proof of work** — optional completion contracts: a token, a non-empty
  artifact, an artifact marker, or a git diff.
- **Native T3 lineage** — a Foreman master thread can delegate child tasks into
  T3's Thread details / Lineage view, instead of scattering top-level threads.

## What it is, and what it is not

Foreman is not another agent runtime. [T3 Code](https://t3.codes) is the
execution layer and worker UI; a T3 ACP provider (DimAgent, Codex, Claude, or a
compatible provider) supplies the model and tools. Foreman supplies the
control plane: queueing, leases, retries, recovery, contracts, and status.

```text
you ── chat + task board ──> Foreman leader (rule | claude | codex | dim)
                                │
                     SQLite: tasks / events / inbox / chat
                                │
                     daemon: claim → lease → poll → retry → reattach
                                │
                     adapter: mock | t3
                                │
                  T3 Code server ──> thread ──> Claude / Codex / Dim / ACP agent
                                └── worktree, diff, approvals, mobile UI
```

T3 can run without Foreman. Foreman can run without T3 in `mock` mode. Together
they give an agent fleet a durable, inspectable memory and a single source of
truth.

## Quickstart

Requirements: Node.js **>= 22.5** (Foreman uses `node:sqlite`). T3 Code is only
needed for real worker threads; the demo uses a local mock adapter.

### 1. Install from source

```bash
git clone https://github.com/Simon-He95/foreman.git
cd foreman
npm install
npm test
```

Use it as a local CLI:

```bash
npm install -g .
```

### 2. Try the mock demo (no model needed)

```bash
npm run demo -- --duration 20
```

This starts a control plane, dispatches mock tasks, wakes the leader on
completion, and prints the briefing. The demo is intentionally isolated from
your normal data directory.

### 3. Run the wizard

```bash
foreman init
```

The wizard writes `foreman.config.json` with mode `0600` and configures:

- project directory and allowed roots
- `mock` or `t3` adapter
- leader (`rule`, `dim`, `claude`, or `codex`)
- worker provider/model and fast / strong / coding model tiers
- data directory and dashboard port
- optional T3 provider registration

For scripts and CI:

```bash
foreman init --yes \
  --adapter mock \
  --leader rule \
  --project . \
  --data-dir .foreman \
  --port 3777
```

### 4. Start the control plane

```bash
foreman up
# dashboard: http://127.0.0.1:3777
```

Add work from another terminal:

```bash
foreman add "Fix the flaky login test" \
  --brief "Find the race and add a regression test" \
  --priority 80

foreman status
foreman ask "What is running, what is queued, and what is blocking?"
```

## Use with T3 Code

T3 is the worker UI. Foreman can run in front of it and keep the operational
state outside the model context.

```bash
# 1. Install T3 and add a project
npx t3@latest serve --no-browser --port 3773
npx t3@latest project add .

# 2. Register the Foreman provider and, optionally, DimAgent as a worker
npm run t3:register-foreman
npm run t3:register-dim

# 3. Restart T3, then start Foreman
foreman up --adapter t3 --leader dim

# 4. Create the T3 master thread that receives notifications
foreman master create --title "Foreman"
```

Then create a T3 thread with provider **Foreman (control plane)** and talk to
it normally. The master thread only reads state and creates/cancels/retries
tasks; work happens in worker threads.

If you already have a master thread:

```bash
foreman master set mcp:<thread-id>
foreman master show
foreman master test
```

Native lineage requires the master and the task to share the same T3 project.
A master in a different project, or a non-Foreman thread, falls back to a
top-level worker thread. See [Native lineage](docs/native-lineage.md).

## Core concepts

| Concept | What it means |
| --- | --- |
| Task ledger | SQLite rows for every task, attempt, lease, event, inbox item, and chat turn. |
| Lease + heartbeat | A running task must keep proving it is alive; silence is not success. |
| Completion inbox | Terminal states are pushed to the leader as a batch, not polled from chat memory. |
| State card | Bounded, deterministic counts and task summaries used by every surface. |
| Completion contract | Optional proof that work happened: token, artifact, marker, or diff. |
| Project registry | Names such as `web` or `api` map to local paths and adapters. |
| Worker mode | Remote or local workers claim tasks with their own revocable tokens. |
| Native lineage | Foreman master → T3 child thread with `parentThreadId` and `subagent` relationship. |

## Commands

| Command | Purpose |
| --- | --- |
| `foreman init` | Guided setup; writes `foreman.config.json`. |
| `foreman up` | Daemon + leader loop + dashboard. |
| `foreman daemon` | Daemon only. |
| `foreman add <title> --brief ...` | Enqueue a task; optional `--model` / `--effort`. |
| `foreman status [--json]` | Print the authoritative state card. |
| `foreman ask "..."` | One leader turn. |
| `foreman master create/show/set/test/clear` | Manage the bound T3 master thread. |
| `foreman project list/add/set/enable/disable` | Manage the project registry. |
| `foreman worker ...` | Enroll, run, drain, resume, revoke, and install workers. |
| `foreman doctor` | Check Node, T3, providers, DB, port, and auth. |
| `foreman backup` / `foreman compact` | Online backup / prune history. |
| `foreman service` | Print a macOS launchd plist for 24/7 operation. |

Full command and flag reference: [docs/README.md](docs/README.md) and
[Configuration](docs/configuration.md).

## Models and effort

Every task can carry its own model and reasoning effort. When omitted, the
leader chooses a tier:

| Tier | Typical work | Default |
| --- | --- | --- |
| `fast` | copy, formatting, one-file edits | fast model, effort `none` |
| `standard` | ordinary implementation and cleanup | fast model, effort `auto` |
| `deep` | research, analysis, architecture, audits | strong model, effort `max` |
| `coding` | fixes, refactors, migrations | coding model, effort `max` |

```bash
foreman add "Audit the payment callback" \
  --brief "Focus on concurrency and idempotency" \
  --model dimcode-api-oauth/gpt-6.2-astra \
  --effort max
```

See [Models and effort](docs/models-and-effort.md). Default strong/coding
slugs are DimAgent-specific; set `modelFast`, `modelStrong`, `modelCoding`, and
`t3ReasoningOption` explicitly for other providers.

## Documentation

- [Docs index](docs/README.md)
- [Quickstart](docs/quickstart.md)
- [Concepts](docs/concepts.md)
- [Configuration](docs/configuration.md)
- [Native lineage](docs/native-lineage.md)
- [Models and effort](docs/models-and-effort.md)
- [Workers](docs/workers.md)
- [Security](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- Recipes: [research](docs/recipes/research.md) ·
  [code fix](docs/recipes/code-fix.md) ·
  [review](docs/recipes/review.md) ·
  [current info](docs/recipes/current-info.md)

## Security

Foreman is local-first and privileged: it can start agents that edit code and
use the network.

- Keep `allowedProjectRoots` narrow.
- Do not expose the dashboard without TLS and a bearer token.
- Use per-worker tokens for remote workers; revoke them when done.
- Never commit `foreman.config.json`, tokens, or data directories.
- Treat leader actions as code execution. Review unattended/destructive paths.

See [SECURITY.md](SECURITY.md) and [docs/security.md](docs/security.md).

## Status

Foreman is **alpha**. The ledger, leases, retries, completion contracts, mock
adapter, T3 adapter, dashboard, worker mode, and native lineage path are
implemented and covered by the test suite (`npm test`). The real T3 + DimAgent
path has been exercised end-to-end on the maintainer's machine.

Known limits and the roadmap are tracked in
[docs/README.md](docs/README.md#status-and-limits) and
[issues](https://github.com/Simon-He95/foreman/issues). Release notes live in
[CHANGELOG.md](CHANGELOG.md). In particular:

- one control plane per SQLite ledger; no HA yet
- worker transport is HTTP; bring your own TLS
- no budget enforcement yet
- T3 completion is polled each tick; MCP events/webhooks are next
- master notifications are user-role messages in T3, not OS notifications

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md)
and run `npm test` before opening a PR.

## License

[MIT](LICENSE) © 2026 Simon He
