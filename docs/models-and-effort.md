# Models and effort

Foreman plans a model and an effort for every task. The leader can choose based
on the task, and the user can override explicitly.

## Default tiers

| difficulty | examples | model | effort |
|---|---|---|---|
| light | rename, format, typo, small single-file change | fast | `none` |
| standard | simple lookup, data retrieval, weather/prices, npm stats, ordinary cleanup | fast | `auto` |
| deep | research synthesis, analysis, architecture, audit | strong | `max` |
| coding | actual edits: fix, refactor, migration, implement | coding | `max` |

`coding` is for tasks that actually change code. A read-only investigation is
not upgraded to the coding model just because its brief contains an API URL,
"代码搜索", or the word "测试". Only an edit intent in the task title/request
(e.g. 修复 / 实现 / 重构 / 迁移 / 调试) selects the coding tier.

Defaults are configuration, not hard requirements:

```json
{
  "modelFast": "dimcode-api-oauth/deepseek-v4.1-flash",
  "modelStrong": "dimcode-api-oauth/gpt-6.2-astra",
  "modelCoding": "dimcode-api-oauth/claude-opus-5-5",
  "t3ReasoningOption": "thought_level"
}
```

## Explicit overrides

In a master thread:

```text
用最强模型，思考开到最大，审查这次数据库迁移。
```

or:

```text
用快模型、便宜点，把这个 README 的错别字修一下。
```

The leader writes `model` and `effort` into the `add_task` action. The ACP agent
passes them to T3 `delegate_task` as `target.model` and a provider-specific
`target.options = [{id: "<reasoning option>", value: ...}]`.

CLI:

```bash
node src/cli.mjs add "review migration" \
  --brief "focus on locking and rollback" \
  --model dimcode-api-oauth/gpt-6.2-astra \
  --effort max
```

## Provider option names

- DimAgent: `thought_level`; values vary by model. Foreman maps the user-facing
  `max` to the model's top value (`xhigh` for newer GPT/Claude models, `max` for
  flash models).
- Rust DimAgent (`dima`), Claude Agent (`claudeAgent`): `effort`.
- Codex: `reasoningEffort`.
- `t3ReasoningOption` is only a fallback for custom providers; built-in ids map
  automatically per task, so per-task provider overrides stay valid.

If T3 rejects an option, the daemon records the error on the task. Check
`orchestrator_capabilities` in T3 for the exact id/value list for a model.

## FC selection in T3

A T3 thread whose provider is **Foreman (control plane)** is the FC. Its model
picker is populated with provider/model choices such as:

```text
dim::gpt-6.2-astra
dima::deepseek-v4.1-flash
codex::gpt-6.2-sol
claudeAgent::claude-sonnet-5-5
```

and its effort picker uses `auto|none|high|max`. The selected values are sent
with every `/api/ask` call, so different FC threads can use different
leader providers/models/efforts.

- `dim` and `dima` use their native CLI backends.
- Other registered providers (including Codex, Claude Agent, and custom
  providers) are executed through a T3 leader thread, so their T3 provider
  authentication, model catalog, and reasoning option id are honored.
- A provider that is unavailable or fails to answer falls back to Foreman's rule
  report rather than hanging the master thread indefinitely.
- Explicit `leaderChoices` are merged with choices discovered from enabled T3
  provider caches. This is useful when a provider's cache only advertises a
  default model (for example an alpha provider).
- After adding/removing a T3 provider or model, restart T3 so its provider cache
  refreshes; then restart Foreman if `leaderChoices`/`leaderProvider` changed.

## Upstream provider/model changes

The **leader** has its own model and effort (`leaderMode`, `leaderProvider`,
`leaderModel`, `leaderEffort`). The **workers** use `t3Provider`, `t3Model`, and
the `modelFast` / `modelStrong` / `modelCoding` tiers. A task may override the
worker provider and model; `forceModel` and `forceProvider` remove that override
path when a deployment needs a fixed fleet.

Foreman does **not** automatically refresh the T3 provider/model catalog. The
fast/strong/coding slugs are explicit config values (`modelFast`,
`modelStrong`, `modelCoding`) or environment overrides. If T3 adds, renames, or
removes a model, update those values and restart Foreman. `foreman models` shows
the effective catalog; `foreman doctor` does not currently validate every model
slug. Dynamic discovery from T3 `orchestrator_capabilities` is a roadmap item.
