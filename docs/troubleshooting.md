# Troubleshooting

## The master says it has no web/weather tools

That is expected: the master is a controller, not a browser. It should ask for a
missing city and create a task for a worker. Foreman workers can use shell,
network, or browser tools depending on the provider.

If the master refuses instead of delegating, check that `leaderMode` is `dim`
(or another model with the current prompt) and that the leader prompt is up to
date (`npm start`).

## `The provider could not start this turn`

Usually an ACP session resume problem. Foreman advertises `session/resume`; make
sure the provider process is the current version. Retry the turn; if it persists,
inspect:

```bash
tail -50 ~/.t3/userdata/logs/provider/events.<thread>.log
```

## No completion notification

```bash
node src/cli.mjs master show
node src/cli.mjs master test
```

If the bound master thread was deleted, `master show` still prints its id but
T3 will reject it. Create/bind a new one:

```bash
node src/cli.mjs master create --title "Foreman 主控"
```

## A task is `blocked` with “completion token was not a standalone line”

The worker did not print the token on its own line. Foreman appends an
instruction to the brief for new tasks. For an existing task, retry with a clearer
brief or remove the token contract if it is not useful.

```bash
curl -X POST http://127.0.0.1:3777/api/tasks/<id>/retry
```

## Native lineage is missing

Check:

1. master provider is `foreman`
2. master project == task project
3. the T3 MCP environment is present in the provider process
4. the task was created from the master, not `foreman add`

A Scratch master cannot delegate into `demo-repo`; use a master in the target
project.

## Model option rejected

T3 model options differ. For Dim, newer reasoning models use
`auto/low/medium/high/xhigh`; flash models use `auto/none/high/max`. Set
`modelFast/modelStrong/modelCoding` and `t3ReasoningOption` explicitly for your
provider. The task error includes the rejected option.

## `master create` fails

- Check T3 is running: `node src/cli.mjs doctor`
- Register the provider: `npm run t3:register-foreman`, restart T3
- Check `t3 thread start ... --provider foreman --model dima::deepseek-v4.1-flash` manually

## Dashboard/API is unreachable

```bash
node src/cli.mjs status
lsof -nP -iTCP:3777 -sTCP:LISTEN
```

If remote, remember the token and do not expose plain HTTP.


## FC model picker is empty or stale

The T3 provider catalog is cached by T3, not polled by Foreman. After registering
a provider or changing its models:

```bash
npm run t3:register-dima   # if using the Rust alpha
# restart T3
cd /path/to/foreman
foreman models             # inspect discovered FC choices
foreman doctor             # checks T3, FC choices, and the bound master FC
```

If a dima choice is missing, add an explicit fallback in `leaderChoices` and
restart T3 so the Foreman provider advertises it.


## Effort picker shows the wrong values

T3 caches model option descriptors at provider startup. If an effort picker
still shows generic values after changing a provider's capabilities, restart T3
and reopen the model picker. For dima DeepSeek V4.1 Flash the registered choices
are `none`, `high`, and `max`. If the FC picker still shows one shared effort
list for every model, restart T3 so it reloads the per-model `_meta` metadata.
