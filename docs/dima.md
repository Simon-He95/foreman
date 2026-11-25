# DimAgent Rust (`dima`)

Foreman can use the Rust DimAgent alpha as a worker harness through T3. The
same binary has two front doors:

- `dima` — the interactive Rust TUI
- `dima acp` — the ACP gateway T3 launches for a worker thread

Foreman/T3 drive **`dima acp`**; they do not embed the TUI. Both use the same
harness, sessions, providers, and model catalog.

## Install

```bash
npm install -g dimcode-alpha@alpha
dima --version
```

`dima` keeps its state under `~/.dimcode-alpha` (Rust alpha), separate from the
older TypeScript DimAgent CLI under `~/.dimcode`. They can coexist.

## Sign in and choose models

```bash
dima login
dima models <provider> --refresh
```

If a daemon is already running an older App Server, `dima` will say so. Stop it
when no session is active, then start the new version:

```bash
dima daemon stop
dima --version
```

The Rust alpha's default model can change or be retired. Always select a model
that is present in the current catalog; the old Dep `gpt-5.6-terra` default is
not a safe assumption.

## Register the T3 provider

```bash
npm run t3:register-dima
```

This writes a provider named **DimAgent Rust (dima)** with:

```text
command: dima
args:    acp
```

Restart T3 after registering. The provider list is loaded at T3 startup.

If `dima` is not on the T3 process's `PATH`, pass an absolute binary:

```bash
DIMA_BIN=/absolute/path/to/dima npm run t3:register-dima
```

## Point Foreman at it

The provider instance id is `dima`:

```bash
foreman init --yes \
  --adapter t3 \
  --provider dima \
  --model <model-id-from-dima-models> \
  --leader rule \
  --project /path/to/your/repo
```

Then set model tiers explicitly so Foreman does not fall back to the fast model
for everything. Edit `foreman.config.json`:

```json
{
  "t3Provider": "dima",
  "t3Model": "provider/model-from-dima",
  "modelFast": "provider/fast-model",
  "modelStrong": "provider/strong-model",
  "modelCoding": "provider/coding-model",
  "t3ReasoningOption": "effort"
}
```

The exact reasoning option id is provider-specific. Use `effort` for the Rust
alpha when T3 exposes it; if T3 rejects the value, inspect the provider's
`orchestrator_capabilities` and set `t3ReasoningOption` accordingly.

## Permissions

`dima` has its own permission setting. The T3 ACP client does not always send a
permission preset. For a working worker, the Rust alpha config should allow the
intended writes:

```json
{
  "permission": "workspace-write"
}
```

or `full-access` when you intentionally want it. The file is
`~/.dimcode-alpha/config.json`. Foreman does not bypass a provider's permission
policy.

## Relationship to the old `dim` provider

| Provider | Binary | Home | Status |
| --- | --- | --- | --- |
| `dim` | old TypeScript CLI | `~/.dimcode` | existing path |
| `dima` | Rust alpha | `~/.dimcode-alpha` | new path |

You can keep both registered during migration and switch `t3Provider` in
Foreman when the Rust catalog is ready.

The TUI is useful for manual exploration, but it is not a T3 provider endpoint.
Use `dima acp` behind T3 for Foreman tasks.
