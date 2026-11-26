# Changelog

All notable changes to Foreman are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.5.1] - 2026-11-26

### Fixed

- Mock mode is now explicit in the state card (`ADAPTER: mock`), mock
  completions are labeled `🧪 MOCK`, and the leader is forbidden from claiming
  real `gh`/web/repository work while the mock adapter is active. The dashboard
  shows a mock warning and `foreman up` warns when no config file or a stale
  mock default project is present.
- The Foreman ACP provider no longer appends raw applied-action JSON to master
  replies by default; it is available only with `FOREMAN_ACP_SHOW_ACTIONS=1`.

## [1.5.0] - 2026-11-26

### Added

- **One-session interface**: the long-lived master thread is the primary
  product surface. It receives all completions and can answer task details
  without opening worker threads.
- Master **task and conversation lookup** for details that are not in the state
  card. The leader can request a bounded SQLite lookup (task brief, result,
  error, contract, and recent events, or `chat:` history), then answer in the
  same conversation.
- Explicit `tsk_...` references in a master message preload that task's ledger
  detail, so ID-based questions do not require a second round trip.
- T3-backed leader sessions are reused per master/provider/model instead of
  creating a new internal “Foreman leader turn” thread on every message.
- Dashboard first-run panel when no master is bound: checks T3, shows the
  default FC/project, and can create and bind the master via
  `POST /api/master/create` or fall back to the CLI command.
- Dashboard interaction pass: master chat is first on narrow windows, model
  routing/results/errors collapse, tasks can be filtered and sent to the master
  with one click, and the bound session id is copyable.
- Dashboard copy and task cards now center the master session; execution thread
  links were removed from notifications and de-emphasized in the board.
- Dashboard **Data** panel for previewing and deleting old terminal task
  records with an explicit retention window and confirmation.
- Dashboard task board defaults to active work plus the 20 most recent terminal
  tasks, with an explicit **全部历史** toggle.
- Automatic T3 thread reconciliation on daemon boot and every 15 minutes:
  missing terminal thread references are cleared, and missing active threads
  are marked `lost` instead of silently starting a duplicate worker.
- Verified retry for blocked tasks with expired leases: a deleted or terminal
  T3 thread can be retried safely; a live thread is still refused.
- Clear product boundary: T3 native Workflows own deterministic pipelines,
  schedules, webhooks, and approvals; Foreman owns the dynamic task queue.
  Dashboard adds a read-only T3 Workflows status check instead of rebuilding
  the workflow engine.
- npm update checks on daemon boot and every six hours, an **update** status pill
  in the dashboard, and a **数据 → 检查更新** action. `foreman update --check`
  and guarded `--apply` refuse to replace active work or a source checkout.
- Immutable per-task target plans with provider/model, actual reasoning
  option/value, source, and catalog revision. Local daemons and worker
  assignments use the control plane's plan rather than re-resolving a
  possibly different T3 cache.
- Typed `modelTiers` configuration with per-tier provider/model/effort targets;
  legacy bare tier fields remain supported.
- Catalog provenance (`source`, `revision`, `observedAt`, `stale`) in state,
  `/api/model-routes`, `foreman models`, and the dashboard. ETags change when
  the T3 cache changes.
- Non-retryable T3 auth/model error classification; auth failures block the
  task instead of consuming retries.
- Dashboard **Model routing** panel with provider/model/effort validation
  against the T3 catalog snapshot, per-category editing, “use current Run for
  all”, and a read-only catalog-aware route summary.
- Dashboard shows catalog provenance/age, actual reasoning option values,
  per-model effort choices, actionable repair suggestions for invalid routes,
  and keeps Save disabled until the route table is dirty.
- `/api/model-routes` API for reading, validating, and updating the current
  master's routing policy.
- Model catalog preflight warnings for custom registrations and unavailable
  targets before a T3 task starts.
- Failed tasks that never got a thread are re-planned against the current
  routes on retry, instead of preserving a stale provider/model.
- Provider/model resolution, reasoning option ids, and effort values are
  catalog-driven. A bare model slug is accepted only when one advertised
  provider owns it, or when a preferred provider is known to advertise it.
- The same preflight runs before local dispatch, worker claim, retry, and the
  T3 adapter call, so an old invalid queued task cannot start a thread just
  because it bypassed the dashboard.

- User-directed worker model routes (`workerModelRoutes` / `set_model_routes`)
  keyed by `default`, `light`, `standard`, `deep`, and `coding`, with a
  `modelOverride` escape hatch for one-off requests.
- The leader prompt now includes the current master's full FC identity
  (`provider::model`, effort, routes), and the state card uses the calling
  master rather than always the primary master.

### Fixed

- The release script now uses npm's browser/security-key 2FA flow by default.
  OTP is an explicit fallback (`--auth otp` / `--otp` / `NPM_OTP`) instead of
  the default stdin prompt; staged releases are discovered through
  `npm stage list` and approved with the same auth mode.
- Provider and model are kept together when routing work. A bare model slug is
  resolved against the current master or a route instead of silently falling
  back to an unrelated provider.
- Model namespace prefixes such as `dimcode-api-oauth` are rejected as provider
  instance ids before T3 starts.
- Removed provider-name and model-name switches from the reasoning path. The
  option id and supported values come from each model's T3 descriptor; the
  `t3ReasoningOption` value is only a fallback when no catalog is readable.
- Setup no longer invents provider-specific strong/coding model names. Tier
  defaults now fall back to the selected worker model, while per-category
  routes are the explicit way to use a different provider/model.
- Project identity is persisted as a canonical `project_key` (registered
  project id or real path), and native-lineage checks compare canonical paths.

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
