# Security

Foreman is local-first. The default bind is `127.0.0.1`; do not expose the
dashboard directly to the internet.

## Tokens

- Dashboard/API token: `FOREMAN_TOKEN` or `<dataDir>/access-token`.
- Worker token: issued by `foreman worker enroll`; scoped to worker endpoints.
- Never commit tokens, `foreman.config.json` secrets, or `<dataDir>` to git.

If a token is configured, every `/api/*` request needs
`Authorization: Bearer <token>` or `X-Foreman-Token`.

## Remote access

Prefer:

- Tailscale Serve / private Tailnet
- Caddy or nginx with TLS
- Cloudflare Access (or equivalent)

Do not expose plain HTTP with `--host 0.0.0.0` to an untrusted network.

## Project roots

`allowedProjectRoots` limits which directories a task may use. Keep it narrow.
Worker project maps allow a logical project name to map to a path on the worker.
Artifact/diff contracts are checked against the resolved project path.

## Untrusted content

Task titles, briefs, results, web pages, and model output are untrusted. The
leader prompt treats them as data, not instructions, but prompt injection is
still possible. The leader can create/cancel/retry tasks; review the action
policy for your threat model.

## Data

The ledger contains task titles, briefs, results, and worker thread ids. It is
local SQLite. There is no telemetry. Model providers receive the prompts you
delegate to them. Back up with:

```bash
node src/cli.mjs backup --out foreman-backup.db
```

and prune with `foreman compact`.


## FC model allowlist

`/api/ask` accepts an optional `leader` override from authenticated clients. In
shared or exposed installations, restrict the accepted FC providers/models to
the `leaderChoices` list at the reverse proxy or add a dedicated allowlist; the
T3 picker is a UI convenience, not an authorization boundary. `forceModel` and
`forceProvider` currently apply to workers, not to the FC leader.
