# Commands

Foreman's CLI is deliberately small. Use `foreman --help` for the short usage
text; this page is the reference.

## Core

| Command | What it does |
| --- | --- |
| `foreman init` | Guided setup; writes `foreman.config.json` in the current directory (or `--cwd`). |
| `foreman up` | Daemon + leader loop + dashboard. Keep this process running. |
| `foreman daemon` | Daemon only; no HTTP server. |
| `foreman add <title> --brief ...` | Enqueue a task; optional `--model` / `--effort`. |
| `foreman status [--json]` | Print the authoritative state card. |
| `foreman ask "..."` | One leader turn. |
| `foreman master create/show/set/test/clear` | Manage the bound T3 master thread. |
| `foreman models [--json]` | Show tier targets, catalog provenance, and discovered provider/model choices. |
| `foreman project list/add/set/enable/disable` | Manage the project registry. |
| `foreman worker ...` | Enroll, run, drain, resume, revoke, and install workers. |
| `foreman doctor` | Check Node, T3, providers, DB, port, and auth. |
| `foreman doctor --reconcile-threads [--yes]` | Maintainer check for T3 thread references; normally automatic in the daemon. |
| `foreman update [--check]` | Compare the installed version with npm; never installs by itself. |
| `foreman update --apply --yes` | Install a newer global npm package; refuses while tasks are active or from a source checkout. |
| `foreman version` | Print the installed `foreman-ops` version. |
| `foreman backup` / `foreman compact` | Online backup / prune history. |
| `foreman task prune ...` | Delete terminal task records older than a cutoff; dry-run unless `--yes`. |
| `foreman reset --yes` | Delete the ledger. |
| `foreman service` | Print a macOS launchd plist for 24/7 operation. |

## Task flags

`foreman add` accepts:

```text
--brief text
--priority 0..100
--project name|path
--adapter mock|t3
--provider id
--category light|standard|deep|coding
--model slug
--effort auto|none|high|max
--max-attempts N
--done-token DONE
--artifact path
--artifact-contains text
--require-diff
```

## Working directory

`init` and `up` resolve the config, data directory, and default project from the
current directory. To operate on another directory without `cd`, pass `--cwd`:

```bash
foreman init --cwd /path/to/repo --yes --adapter t3 ...
foreman up --cwd /path/to/repo
```

`--project` changes the task project path inside that configuration; it does not
move the config itself. `foreman init --help` and `foreman up --help` print
usage and do not create files or start a process.

## Global flags

Flags override environment variables and `foreman.config.json`. The main set:

```text
--cwd dir
--adapter mock|t3
--execution local|worker
--project name|path
--concurrency N
--leader rule|claude|codex|dim|dima
--leader-provider id
--leader-model slug
--leader-effort auto|none|high|max
--force-provider id
--force-model slug
--port N
--host address
--token secret
--allowed-roots path,path
--data-dir path
--t3-project path
--t3-provider id
--t3-model slug
--model-fast slug
--model-strong slug
--model-coding slug
--t3-reasoning-option id
--no-worktree
--leader-tick ms
```

Worker flags are documented in [Workers](workers.md); every config key and
environment variable is in [Configuration](configuration.md).

## Master session

The master is the single user-facing session. Create or bind it once:

```bash
foreman master create --title "Foreman"
foreman master show
foreman master set mcp:<thread-id>
foreman master test
```

If no master is bound, the dashboard's first-run panel can also create and bind
it in one click. Talk to that thread for new work, status, task details,
failures, and follow-ups.
Worker threads are execution details. The master can request a bounded SQLite
lookup for a task's brief, result, error, and events (or `chat:<terms>` for
older conversation history), so "what happened with that task?" does not
require opening its thread.

## Thread reconciliation and task pruning

Thread reconciliation is automatic. The daemon checks T3 thread references
shortly after boot and every 15 minutes. A missing thread on an active task is
marked `lost` and its thread reference is cleared; it is **not** restarted
automatically. Terminal tasks keep their records but lose dead thread
references. The event log keeps the old thread id for audit.

Normal users do not need a maintenance button or CLI for this. The task board
shows active work plus the 20 most recent terminal tasks; **全部历史** reveals
the rest. The **数据** panel is only for history retention:

1. Choose a retention window.
2. Click **预览可清理** to see what would be removed.
3. Confirm **删除记录** to delete terminal task rows and their events/inbox.

Maintainers can run the same thread check manually:

```bash
foreman doctor --reconcile-threads        # dry-run
foreman doctor --reconcile-threads --yes  # apply
```

Terminal tasks can be pruned explicitly from the CLI too:

```bash
foreman task prune --done --failed --older-than 30d   # dry-run
foreman task prune --done --failed --older-than 30d --yes
```

`task prune` accepts `--done`, `--failed`, `--cancelled`, and `--lost`; active
statuses are rejected. It deletes the task and its events/inbox rows, but never
touches T3 threads. Use `foreman compact` for event/chat retention separately.

## T3 provider registration

```bash
npm run t3:register-foreman  # Foreman control-plane provider
npm run t3:register-dim      # old TypeScript DimAgent (optional)
npm run t3:register-dima     # Rust DimAgent alpha (optional)
```

Restart T3 after any provider registration.

## Model catalog

```bash
foreman models
foreman models --json
```

This prints the **effective** config, typed `tierTargets`, catalog provenance
(`source`, `revision`, `observedAt`, `stale`), and catalog-derived reasoning
option ids. It does not modify T3. Tier targets are explicit; FC choices are
discovered from enabled T3 providers (plus `leaderChoices`). Route and task
preflight reads the T3 provider cache, so advertised model changes are noticed
without a Foreman restart. The cache is a snapshot; restart T3 after
adding/removing a provider to refresh it. If T3 renames a model, update the
relevant `modelTiers` entry (or legacy `modelFast` / `modelStrong` /
`modelCoding` field).

The selected FC is persisted per T3 master thread. The output also shows
`worker routes` when the master or config has a category map (`light`,
`standard`, `deep`, `coding`, `default`); each route is a provider + model pair.
Each task stores the resolved `target_json`, actual reasoning option/value,
source, and catalog revision; `foreman status --json` exposes those fields.

## T3 native workflows

Deterministic multi-stage pipelines belong to T3's native **Workflows**
(`Settings → Labs → Workflows`): schedules, webhooks, approvals, typed agent
steps, checkpointing, retries, and concurrency pools are T3's responsibility.
Foreman does not recreate that engine.

The **数据 → T3 原生 Workflows** check only reports whether native workflows are
enabled and their run counts. Foreman remains the dynamic task queue around
them: ad-hoc requests, priorities, model routes, task status, recovery, and
human follow-up.

## Updates

Foreman checks npm for a newer `foreman-ops` shortly after boot and every six
hours. The result appears in the leader state card and as an **update** pill in
the dashboard header; the **数据** panel has a manual **检查更新** button.

```bash
foreman version
foreman update --check
foreman update --apply --yes
```

`update --apply` is deliberately conservative:

- it refuses while `running`, `queued`, or `blocked` tasks exist;
- it refuses from a source checkout (use `git pull` instead of replacing the
  source with a global npm install);
- it backs up the ledger before installing;
- it restarts the launchd service when that service is installed, and otherwise
  prints the command to start Foreman manually.

This is a graceful restart, not an in-process hot swap. Foreman itself is
briefly unavailable, while T3 worker threads stay alive and are reattached by
thread id. An update is not applied while active tasks are present, so a
running task is never killed by this command.

## Release (maintainers)

```bash
npm run release
npm run release:dry
```

`release` uses bumpp for the version prompt, publishes to npm, verifies the
registry, and commits/tags/pushes. By default npm uses its browser/security-key
2FA flow (`--auth web`). For a non-interactive or authenticator fallback, pass
`--auth otp --otp <code>` or set `NPM_OTP`.
