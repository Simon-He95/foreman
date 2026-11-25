# Changelog

All notable changes to Foreman are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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
