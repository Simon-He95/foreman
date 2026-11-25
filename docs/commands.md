# Commands

Foreman's CLI is deliberately small. Use `foreman --help` for the short usage
text; this page is the reference.

## Core

| Command | What it does |
| --- | --- |
| `foreman init` | Guided setup; writes `foreman.config.json`. |
| `foreman up` | Daemon + leader loop + dashboard. Keep this process running. |
| `foreman daemon` | Daemon only; no HTTP server. |
| `foreman add <title> --brief ...` | Enqueue a task; optional `--model` / `--effort`. |
| `foreman status [--json]` | Print the authoritative state card. |
| `foreman ask "..."` | One leader turn. |
| `foreman master create/show/set/test/clear` | Manage the bound T3 master thread. |
| `foreman models [--json]` | Show the effective fast / strong / coding catalog. |
| `foreman project list/add/set/enable/disable` | Manage the project registry. |
| `foreman worker ...` | Enroll, run, drain, resume, revoke, and install workers. |
| `foreman doctor` | Check Node, T3, providers, DB, port, and auth. |
| `foreman backup` / `foreman compact` | Online backup / prune history. |
| `foreman reset --yes` | Delete the ledger. |
| `foreman service` | Print a macOS launchd plist for 24/7 operation. |

## Task flags

`foreman add` accepts:

```text
--brief text
--priority 0..100
--project name|path
--adapter mock|t3
--model slug
--effort auto|none|high|max
--max-attempts N
--done-token DONE
--artifact path
--artifact-contains text
--require-diff
```

## Global flags

Flags override environment variables and `foreman.config.json`. The main set:

```text
--adapter mock|t3
--execution local|worker
--project name|path
--concurrency N
--leader rule|claude|codex|dim
--leader-model slug
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

## Model catalog

```bash
foreman models
foreman models --json
```

This prints the **effective** catalog after config and environment overrides. It
does not modify T3. The provider/model catalog is intentionally explicit:
upstream T3 additions or removals require updating `modelFast`, `modelStrong`,
`modelCoding`, and `t3ReasoningOption`, then restarting `foreman up`.

## Release (maintainers)

```bash
npm run release
npm run release:dry
```

`release` uses bumpp for the version prompt, publishes to npm, verifies the
registry, and commits/tags/pushes. It still requires one npm 2FA OTP.
