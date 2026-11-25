# Quickstart

## 0. Prerequisites

- macOS or Linux, Node **22.5+**
- [T3 Code](https://t3.codes) running for the real (non-mock) path
- At least one ACP provider enabled in T3:
  - DimAgent (`dim`) is the tested path in this repo
  - Codex / Claude are supported by T3 and can be used with config changes
- A project directory to work on

## 1. Trial mode (no model, no T3)

```bash
npm install
npm run demo -- --duration 20
```

This starts a mock-ledger demo. To run the real dashboard and mock tasks:

```bash
node src/cli.mjs doctor
npm start
```

Open `http://127.0.0.1:3777`, then submit a mock task from the dashboard. No
model quota is used.

## 2. Configure a real project

```bash
node src/cli.mjs init
```

The wizard asks for:

- project directory
- adapter (`mock` for trial, `t3` for real workers)
- provider and worker model (for `t3`)
- leader backend (`dim` for the tested real path)
- data directory and dashboard port
- whether to register the `foreman` provider in T3

It writes `foreman.config.json` in the current directory. For non-interactive
setup:

```bash
node src/cli.mjs init --yes \
  --project /path/to/project \
  --adapter t3 \
  --provider dim \
  --model dimcode-api-oauth/deepseek-v4.1-flash \
  --leader dim
```

Register the T3 provider once:

```bash
npm run t3:register-foreman
```

Then restart T3 so the **Foreman (control plane)** provider appears.

## 3. Start the control plane

```bash
node src/cli.mjs doctor
npm start
```

The control plane listens on `127.0.0.1:3777` by default and opens the
dashboard. Keep this process running; it owns the task ledger and the daemon.

## 4. Create the master thread

Use a T3 thread **in the same project** whose provider is **Foreman (control
plane)** and model is `default`.

Or create/bind it from the CLI:

```bash
node src/cli.mjs master create --title "Foreman 主控"
```

The printed thread is the notification target. Pin it in T3.

> Native lineage requires the master and worker task to be in the same T3
> project. A Scratch master can still chat, but its tasks fall back to top-level
> threads.

## 5. Run the first task

In the master thread:

```text
调研这个仓库最近一个月的提交趋势，输出一份简报。
```

or explicitly select a model/effort:

```text
用最强模型，思考开到最大，审查支付回调的并发和幂等。
```

Expected result:

1. the master creates a child T3 thread (`relationship=subagent`)
2. Foreman records it as a running task
3. the child completes
4. the master receives a completion notification with a thread link

## 6. Verify

```bash
node src/cli.mjs status
node src/cli.mjs master show
```

The dashboard and `status` are authoritative. If a provider/model is wrong,
`doctor` and the T3 provider log are the first places to look.

## Troubleshooting

- **No Foreman provider in T3** — run `npm run t3:register-foreman`, restart T3.
- **Provider could not start / cannot resume** — make sure `npm start` is healthy
  and retry; Foreman advertises `session/resume`.
- **Task blocked on completion contract** — the worker must print the token on
  its own line; Foreman appends that instruction when creating a task.
- **No notification** — run `node src/cli.mjs master show`; if the bound thread
  was deleted, create a new master with `master create`.

See [Troubleshooting](troubleshooting.md) for details.
