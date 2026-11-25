# Workers

Foreman has two execution modes.

## Local (default)

The daemon starts tasks itself through the configured adapter (`t3` in real use,
`mock` for trials). No separate worker process is needed.

```json
{ "executionMode": "local", "adapter": "t3" }
```

## Remote worker

Use worker mode when the control plane and the machine doing work are different.

```bash
# on the control plane
node src/cli.mjs up --execution worker --host 0.0.0.0 --token "$DASHBOARD_TOKEN"

# issue a worker token (once)
node src/cli.mjs worker enroll box-1 \
  --worker-capacity 2 \
  --worker-projects web,api \
  --token-file box-1.token

# on the worker machine
node src/cli.mjs worker \
  --control http://control-host:3777 \
  --worker-id box-1 \
  --worker-token-file box-1.token
```

Worker tokens are scoped to `/api/worker/*`; they are not dashboard tokens.
Project filters are enforced at claim time. Use TLS termination (Tailscale
Serve, Caddy, Cloudflare Access, etc.) for anything beyond loopback.

## Worktree behavior

For artifact/diff completion contracts, Foreman disables the T3 worktree so the
contract is checked against the real project path. Otherwise configure
`t3Worktree` as needed.

## Drain / revoke

```bash
node src/cli.mjs worker drain box-1
node src/cli.mjs worker resume box-1
node src/cli.mjs worker revoke box-1
```

Draining stops new claims without killing running work.
