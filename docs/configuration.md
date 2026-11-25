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
| `leaderMode` | `FOREMAN_LEADER` | default leader backend: `rule`, `dim`, `dima`, `codex`, `claude` |
| `leaderProvider` | `FOREMAN_LEADER_PROVIDER` | FC provider id; defaults from `leaderMode` (`claude` → `claudeAgent`) |
| `leaderModel` | `FOREMAN_LEADER_MODEL` | default FC model |
| `leaderEffort` | `FOREMAN_LEADER_EFFORT` | default FC effort |
| `leaderChoices` | `FOREMAN_LEADER_CHOICES` | optional explicit FC choices: `{provider, model, label}`; merged with T3 discovery |
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
| `t3ReasoningOption` | `FOREMAN_T3_REASONING_OPTION` | fallback reasoning option for custom providers; built-ins auto-map (`dim`→`thought_level`, `dima`/`claudeAgent`→`effort`, `codex`→`reasoningEffort`) |
| `modelFast` | `FOREMAN_MODEL_FAST` | light/standard model |
| `modelStrong` | `FOREMAN_MODEL_STRONG` | deep/research model |
| `modelCoding` | `FOREMAN_MODEL_CODING` | coding/refactor model |
| `forceModel` | `FOREMAN_FORCE_MODEL` | optional hard worker-model lock; ignores task overrides |
| `forceProvider` | `FOREMAN_FORCE_PROVIDER` | optional hard worker-provider lock; ignores task overrides |

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

To make **all** workers use one model without allowing overrides, set
`forceModel`. To use one provider without allowing per-task overrides, set
`forceProvider`. Without the force locks, `modelFast` / `modelStrong` /
`modelCoding` are the tier defaults and `t3Provider` is the default worker
provider.

Per-task overrides:

```bash
foreman add "review this PR" --provider codex --model gpt-6-astra
```

The API accepts `provider` and `model` in `POST /api/tasks`; the leader can emit
`provider` in an `add_task` action. The T3 adapter and native delegation use the
task's provider, falling back to `t3Provider`.

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

`master create` uses `t3Project`, provider `foreman`, the default FC model
choice, and binds the new thread automatically. In T3, the Foreman provider's
model picker and effort picker set the leader for that master thread.

The selection is stored in `meta.master_fc:<t3-thread-id>` and is reused when
the T3 thread resumes. Automatic leader wakeups use the primary
`master_thread_id` and its stored FC; use `foreman master set <thread-id>` to
switch the primary. T3 must be restarted after changing the provider/model
catalog or registration.

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
