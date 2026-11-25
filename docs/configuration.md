# Configuration

Foreman reads `foreman.config.json` from the current directory, then applies
environment variables and CLI flags.

Start with:

```bash
cp foreman.config.example.json foreman.config.json
# or
node src/cli.mjs init
```

## Core

| key | env | meaning |
|---|---|---|
| `dataDir` | `FOREMAN_DATA_DIR` | SQLite, pid, logs, master metadata |
| `projectPath` | `FOREMAN_PROJECT` | default project for new tasks |
| `allowedProjectRoots` | `FOREMAN_ALLOWED_ROOTS` | roots a task may use |
| `adapter` | `FOREMAN_ADAPTER` | default `mock` or `t3` |
| `executionMode` | `FOREMAN_EXECUTION_MODE` | `local` or `worker` |
| `concurrency` | `FOREMAN_CONCURRENCY` | daemon task concurrency |
| `maxAttempts` | `FOREMAN_MAX_ATTEMPTS` | retry budget |
| `port` / `host` | `FOREMAN_PORT` / `FOREMAN_HOST` | dashboard bind |
| `authToken` | `FOREMAN_TOKEN` | dashboard/API bearer token |
| `leaderMode` | `FOREMAN_LEADER` | `rule`, `dim`, `codex`, `claude` |
| `leaderModel` | `FOREMAN_LEADER_MODEL` | optional leader model (bare id for legacy `dim`) |
| `leaderTickMs` | `FOREMAN_LEADER_TICK_MS` | automatic wake interval |

## T3

| key | env | meaning |
|---|---|---|
| `t3Bin` | `FOREMAN_T3_BIN` | T3 CLI path |
| `t3Project` | `FOREMAN_T3_PROJECT` | project to create worker threads in |
| `t3Provider` | `FOREMAN_T3_PROVIDER` | worker provider id, e.g. `dim`, `dima`, `codex`, `claudeAgent` |
| `t3Model` | `FOREMAN_T3_MODEL` | default worker model |
| `t3Worktree` | `FOREMAN_T3_WORKTREE` | create a worktree per thread |
| `t3WorktreeBase` | `FOREMAN_T3_WORKTREE_BASE` | worktree base ref |
| `t3ReasoningOption` | `FOREMAN_T3_REASONING_OPTION` | `thought_level` for Dim, `effort` for others |
| `modelFast` | `FOREMAN_MODEL_FAST` | light/standard model |
| `modelStrong` | `FOREMAN_MODEL_STRONG` | deep/research model |
| `modelCoding` | `FOREMAN_MODEL_CODING` | coding/refactor model |

The leader model is independent from workers. For example, a smart leader and
cheaper workers:

```json
{
  "leaderMode": "dim",
  "leaderModel": "gpt-6.2-astra",
  "t3Provider": "codex",
  "t3Model": "gpt-6-astra",
  "modelFast": "gpt-6-astra",
  "modelStrong": "gpt-6-astra",
  "modelCoding": "gpt-6-astra"
}
```

To make **all** workers use one model, set `modelFast`, `modelStrong`, and
`modelCoding` to the same slug. Explicit task/leader overrides can still choose
another model. There is not yet a per-task provider field; `t3Provider` applies
to all worker threads.

## Native lineage

For user-triggered tasks from a master, the ACP agent calls T3
`delegate_task`. This only works when:

- the master thread's project == the task project
- the T3 MCP endpoint is available in the provider environment
- the master is currently processing a run

Otherwise Foreman falls back to top-level `t3 thread start`; work still runs,
but T3 Lineage will not show the parent relationship.

## Master

The active notification target is stored in the Foreman DB (`meta.master_thread_id`),
not in `foreman.config.json`.

```bash
node src/cli.mjs master create --title "Foreman 主控"
node src/cli.mjs master show
node src/cli.mjs master set <thread-id>
node src/cli.mjs master test
```

`master create` uses `t3Project`, provider `foreman`, model `default`, and binds
the new thread automatically.

## Task-level flags

```bash
node src/cli.mjs add "fix login" \
  --brief "reproduce and fix the flaky login test" \
  --model dimcode-api-oauth/gpt-6.2-astra \
  --effort max \
  --done-token DONE
```

- `--model`: model slug
- `--effort`: `auto|none|high|max`
- `--done-token`: optional completion contract

## Worker mode

In `worker` mode the daemon only schedules. A worker connects to the control
plane and claims tasks:

```bash
node src/cli.mjs worker \
  --control http://control-host:3777 \
  --worker-id box-1 \
  --worker-capacity 2 \
  --worker-token-file /path/to/token
```

See [Workers](workers.md) and [Security](security.md).
