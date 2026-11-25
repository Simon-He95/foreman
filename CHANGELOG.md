# Changelog

All notable changes to Foreman are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Dashboard **Model routing** panel with provider/model/effort validation
  against the T3 catalog snapshot, per-category editing, “use current Run for
  all”, and a read-only catalog-aware route summary.
- `/api/model-routes` API for reading, validating, and updating the current
  master's routing policy.
- Model catalog preflight warnings for custom registrations and unavailable
  targets before a T3 task starts.
- Failed tasks that never got a thread are re-planned against the current
  routes on retry, instead of preserving a stale provider/model.

- User-directed worker model routes (`workerModelRoutes` / `set_model_routes`)
  keyed by `default`, `light`, `standard`, `deep`, and `coding`, with a
  `modelOverride` escape hatch for one-off requests.
- The leader prompt now includes the current master's full FC identity
  (`provider::model`, effort, routes), and the state card uses the calling
  master rather than always the primary master.

### Fixed

- Provider and model are kept together when routing work. A bare model slug is
  resolved against the current master or a route instead of silently falling
  back to an unrelated provider.
- Model namespace prefixes such as `dimcode-api-oauth` are rejected as provider
  instance ids before T3 starts.

## [1.2.1] - 2026-11-25

### Fixed

- Dima `deepseek-v4.1-flash` advertises its real reasoning choices
  (`none`, `high`, `max`) instead of generic T3 effort labels.
- Foreman FC effort options are derived from the selected provider/model
  capabilities instead of always exposing the global effort vocabulary.
- Foreman advertises per-model reasoning-effort metadata in ACP so T3 updates
  the effort picker when switching FC models.
- Restarting T3 refreshes the provider/model option descriptors.

## [1.2.0] - 2026-11-25

### Added

- `leaderModel` and `leaderEffort` are passed to the legacy `dim exec` leader
  backend; `foreman init --leader-model/--leader-effort` and `foreman models`
  expose the master/leader policy separately from worker tiers.
- T3 FC model/effort selection: the Foreman ACP provider advertises configured
  provider/model choices and effort options; each master thread can choose its
  own leader provider, model, and effort at creation time.
- `leaderProvider` / `leaderChoices` and a native `dima` leader backend.
- FC selection is persisted per T3 master thread, per-master turn queues avoid
  cross-master blocking, task notifications route to the creating master, and
  fallback replies are visibly marked.
- Per-task `provider` selection through CLI `--provider`, `POST /api/tasks`,
  task cards, and leader `add_task` actions. Reasoning option ids are selected
  per provider (`thought_level`, `effort`, `reasoningEffort`), including when a
  task overrides the default provider.
- `forceModel` / `forceProvider` hard locks for deployments that require every
  worker thread to use one model/provider.
- T3 provider registration for the Rust DimAgent alpha (`dima`) and a dedicated
  guide (`docs/dima.md`).

### Notes

- `t3Provider` remains the default worker provider; per-task provider overrides
  are used by the T3 adapter and native lineage.
- The T3 master thread's model selector does not control the Foreman leader;
  configure `leaderModel` / `leaderEffort` in Foreman.
- `forceModel` / `forceProvider` intentionally ignore explicit task overrides.

## [1.1.0] - 2026-11-25

### Added

- Rust DimAgent alpha (`dima`) integration through `dima acp`.
- `npm run t3:register-dima` writes the **DimAgent Rust (dima)** T3 provider.
- `docs/dima.md` covers TUI vs ACP, model catalog refresh, permissions, and
  switching Foreman from `dim` to `dima`.

### Notes

- The TUI (`dima`) and ACP gateway (`dima acp`) use the same harness; T3 launches
  the ACP gateway.
- Dima's model catalog and authentication are separate from the old `dim` CLI.
  Refresh models and set explicit `modelFast` / `modelStrong` / `modelCoding`
  before switching Foreman to `dima`.

## [1.0.0] - 2026-11-25

### Added

- Design rationale (`DESIGN.md`), command reference (`docs/commands.md`), and
  a macOS CI job.
- `foreman models` for the effective model catalog.
- SQLite schema versioning and additive migrations (`PRAGMA user_version`).
- One-command release flow with bumpp and npm publishing.

### Changed

- Read-only research lookups use the fast model; only actual code edits use the
  coding/Opus tier.
- README/Quickstart now lead with npm installation and the T3 dependency matrix.

### Known limits

- T3 completion is still polled; MCP events/webhooks are future work.
- The T3 provider/model catalog is explicit config, not auto-discovered.
- One control plane per SQLite ledger; no HA.
- Worker transport is HTTP; TLS is external.

## [0.1.3] - 2026-11-25

### Added

- `npm run release` one-command release flow with a bumpp version prompt.

### Fixed

- Simple read-only research with API URLs or "代码搜索" in its brief is now
  `standard` (fast model) instead of `coding` (Opus). Only tasks with an actual
  edit intent select the coding model.

## [0.1.2] - 2026-11-25

### Fixed

- Pass the leader prompt to `dim exec` over stdin instead of argv. Large
  structured prompts can otherwise be rejected as an unknown argument.

## [0.1.1] - 2026-11-25

### Changed

- Publish the CLI as `foreman-ops` on npm.
- Lead the README/Quickstart with the npm install path and spell out the
  Node/T3/provider dependency matrix.
- Replace the dashboard's dark gradient/pill/left-border theme with the light
  editorial ledger UI.
- Refresh dashboard and social-preview screenshots.
- Make setup helper output use the installed `foreman` command.

## [0.1.0] - 2026-11-25

### Added

- Durable SQLite task ledger, leases, heartbeats, retries, and restart reattach.
- `mock` and `t3` adapters; T3 ACP provider bridge.
- Rule, DimAgent, Claude, and Codex leader backends.
- `foreman init` interactive/non-interactive setup wizard.
- Completion contracts: token, artifact, artifact marker, and git diff.
- Dashboard, REST API, ETag polling, bearer auth, and allowed project roots.
- Project registry and per-task model / reasoning-effort selection.
- Worker mode with per-worker tokens, project filters, attempt fencing,
  worker-side contract evidence, drain/resume/revoke, and launchd service.
- Native T3 lineage: Foreman master -> T3 child thread via MCP `delegate_task`.
- Documentation set, recipes, dashboard screenshot, CI, and community files.

### Known limits

- One control plane per SQLite ledger; no HA.
- Worker transport is HTTP; terminate TLS externally.
- T3 completion is polled; MCP events/webhooks are future work.
- No token/cost budget enforcement yet.
