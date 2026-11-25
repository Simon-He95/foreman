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

## Assignment targets

The control plane resolves a task's model target before a worker may claim it.
The claim response and the running-assignment response include a `target`
object:

```json
{
  "provider": "dim",
  "model": "dimcode-api-oauth/gpt-6.2-astra",
  "effort": "max",
  "reasoning": { "optionId": "thought_level", "value": "xhigh" },
  "source": "route",
  "catalogRevision": "..."
}
```

A current worker executes that plan directly. It does not re-run provider
inference against its own T3 cache, which matters when workers have different
`t3Home`/provider snapshots. Older workers that ignore the additive `target`
field fall back to the task's provider/model columns; upgrade workers to get
the full control-plane decision. Invalid targets are blocked before claim, so
an old queued task cannot start a thread.

Tasks also carry a canonical `project_key` (`project:<id>` or a real path).
Use it for cross-machine project mapping and audits; `project_name` is still
the worker project filter.

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
