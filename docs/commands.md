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
| `foreman models [--json]` | Show tier targets, catalog provenance, and discovered provider/model choices. |
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

## Global flags

Flags override environment variables and `foreman.config.json`. The main set:

```text
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

## Release (maintainers)

```bash
npm run release
npm run release:dry
```

`release` uses bumpp for the version prompt, publishes to npm, verifies the
registry, and commits/tags/pushes. By default npm uses its browser/security-key
2FA flow (`--auth web`). For a non-interactive or authenticator fallback, pass
`--auth otp --otp <code>` or set `NPM_OTP`.
