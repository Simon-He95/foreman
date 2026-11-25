# Quickstart

Foreman is a control plane for coding-agent fleets. It is **not** an agent
runtime and **does not install T3 Code or a model for you**. Pick the path that
matches what you want.

| Path | What you get | Needs | Time |
| --- | --- | --- | --- |
| A. See it | mock tasks, dashboard, ledger, completion wakeups | Node.js >= 22.5 | ~2 min |
| B. Mock control plane | persistent dashboard/API with mock workers | Node.js >= 22.5 | ~5 min |
| C. Real agents | T3 threads that edit a real project | Node + T3 Code + authenticated ACP provider | 10–20 min |
| D. T3 master | chat with Foreman inside T3 and receive notifications | C + registered Foreman provider | +5 min |

## Dependencies

| Dependency | Required for | Notes |
| --- | --- | --- |
| Node.js **>= 22.5** | everything | Foreman uses `node:sqlite` |
| T3 Code `0.1.x` | real workers and the T3 master | separate app/server; tested with `0.1.11` |
| ACP provider + authentication | real workers | DimAgent is the reference path; Codex/Claude work through T3 |
| A project directory | real workers | use a Git repo; native lineage requires one T3 project |
| macOS or Linux | tested platforms | Windows is untested; macOS launchd service is macOS-only |
| Port `3773` | T3 Code | change it if occupied |
| Port `3777` | Foreman dashboard | change it if occupied |

There is currently **no one-click desktop installer**, but the CLI is published
on npm as `foreman-ops`:

```bash
npm install -g foreman-ops
foreman --help
```

For contributors or unreleased changes, use a source checkout:

```bash
git clone https://github.com/Simon-He95/foreman.git
cd foreman
npm install
npm test
npm install -g .
```

## A. See it in 2 minutes (no T3, no model)

```bash
foreman demo --duration 20
```

From a source checkout, use `npm run demo -- --duration 20` instead.

The demo runs a mock fleet, claims tasks, wakes the leader on completion, and
prints the briefing. This proves the queue, leases, retries, inbox, and state
card without a model or T3. It does **not** edit your code.

## B. Persistent mock control plane (no T3, no model)

```bash
foreman init --yes \
  --adapter mock \
  --leader rule \
  --project . \
  --data-dir .foreman \
  --port 3777

foreman up
```

Open `http://127.0.0.1:3777`, click **+ 新任务**, and use the dashboard. This is
useful for evaluating the UI/API and for developing against the ledger. Mock
tasks are simulated and do not run a real coding agent.

If you installed from a source checkout without a global CLI, substitute
`node src/cli.mjs` for `foreman`.

## C. Real agents with T3 Code

You need three separate pieces:

1. **Node.js** for Foreman.
2. **T3 Code** as the execution layer and worker UI.
3. **An ACP provider** configured and authenticated inside T3, such as DimAgent,
   Codex, or Claude. Foreman does not supply the model.

### C1. Start T3 and add the project

Use the desktop app, or run the T3 server:

```bash
npx t3@latest --version
npx t3@latest serve --no-browser --port 3773
npx t3@latest project add /path/to/your/repo
```

Keep T3 running. In T3, confirm the project exists and your provider is
authenticated before involving Foreman.

### C2. Configure and register Foreman

The npm CLI can write the config and register its T3 provider in one step:

```bash
foreman init --yes \
  --adapter t3 \
  --project /path/to/your/repo \
  --provider dim \
  --model dimcode-api-oauth/deepseek-v4.1-flash \
  --leader dim \
  --register
```

The model above is a DimAgent example; replace provider/model for Codex or
Claude. If you omit `--yes`, the wizard asks the same questions and offers to
register the provider.

From a source checkout, `npm run t3:register-foreman` is equivalent to the
registration part. If you use DimAgent as the worker, also run
`npm run t3:register-dim` from a source checkout, or add its ACP wrapper through
T3's provider settings.

**Restart T3 after registration.** A new provider is not visible in an already
running T3 process. The new T3 thread will show **Foreman (control plane)**.

### C3. Start Foreman

```bash
foreman doctor
foreman up
```

The dashboard is at `http://127.0.0.1:3777`. T3 stays on `:3773`.

### C4. Use it

From the dashboard or CLI:

```bash
foreman add "Fix the flaky login test" \
  --brief "Find the race and add a regression test" \
  --priority 80

foreman status
foreman ask "What is running and what is blocked?"
```

Foreman asks T3 to create the worker thread, then polls it, enforces the lease
and optional completion contract, and records the result.

## D. Talk to Foreman inside T3

The T3 master is optional. It gives you a T3 chat thread with Foreman and
completion/failure notifications; the dashboard remains the authoritative ops
surface.

```bash
foreman master create --title "Foreman"
```

Then in T3:

1. Create a new thread.
2. Choose provider **Foreman (control plane)** and model `default`.
3. Ask for work in natural language.
4. Foreman creates child T3 threads for tasks and reports completions.

Native lineage requires the master thread and the task to be in the **same T3
project**. A master in another project, or a Scratch thread, still chats but
falls back to top-level worker threads.

If you already have a master:

```bash
foreman master set mcp:<thread-id>
foreman master show
foreman master test
```

## Daily use: keep two processes alive

After the one-time setup, normal operation is:

```bash
# terminal 1: T3 must stay running
npx t3@latest serve --no-browser --port 3773
# or keep the T3 Code desktop app open

# terminal 2: Foreman daemon + leader + dashboard
cd /path/to/your/repo
foreman up
```

`foreman up` blocks on purpose. Do not close that terminal while work is
running; use tmux or `foreman service` if you need it to survive logout. T3 must
also stay running. The dashboard at `http://127.0.0.1:3777` is optional.

Then either:

- open the T3 master thread (`foreman master show`) and ask for work there, or
- add work from another terminal with `foreman add "..." --brief "..."`.

If you restart Foreman, running T3 tasks are reattached by thread id; do not run
two `foreman up` processes against the same data directory. If you restart T3,
start T3 first, then `foreman up`.

## Verify the install

```bash
foreman doctor
foreman status
foreman master show
```

- `doctor` checks Node, T3, provider CLIs, database, port, and auth.
- `status` is the authoritative task card.
- `master show` confirms the notification target.

## What is genuinely one-click?

Only the mock demo is close:

```bash
npm install && npm run demo -- --duration 20
```

Real agents are not one-click because T3 must be installed, a provider must be
authenticated, T3 must be restarted after provider registration, and the master
must be in the same project for native lineage. Expect **10–20 minutes** for the
first real setup and much less afterwards.

## First-run troubleshooting

| Symptom | Check |
| --- | --- |
| No **Foreman (control plane)** provider | Run `npm run t3:register-foreman`, then fully restart T3. |
| T3 is running but Foreman cannot start threads | Check `foreman doctor`, the T3 port, and the provider/model in `foreman.config.json`. |
| Task runs at top level instead of under the master | Master and task are in different T3 projects, or the master is a Scratch provider. |
| No completion notification | `foreman master show`; rebind with `foreman master set mcp:<id>` if the thread was deleted. |
| Dashboard port is busy | Change `port` in `foreman.config.json` or pass `--port`. |
| `foreman: command not found` | Run `npm install -g .` or use `node src/cli.mjs` from the checkout. |
| npm install fails on old Node | Upgrade to Node 22.5+; `node:sqlite` is required. |

For deeper setup, see [Configuration](configuration.md), [Workers](workers.md),
and [Troubleshooting](troubleshooting.md).
