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
  "modelCoding": "dimcode-api-oauth/gpt-6.2-astra",
  "t3ReasoningOption": "thought_level"
}
```

## User-directed routes

Tiers are defaults, not a mandate. A user can assign different providers and
models to different kinds of work. The leader stores this as a per-master route
table, so it survives later turns and is visible in the next prompt:

```json
{
  "workerModelRoutes": {
    "default": {
      "provider": "dima",
      "model": "deepseek-v4.1-flash",
      "effort": "max"
    },
    "deep": {
      "provider": "dim",
      "model": "dimcode-api-oauth/gpt-6.2-astra",
      "effort": "max"
    },
    "coding": {
      "provider": "claudeAgent",
      "model": "claude-opus-5-5",
      "effort": "max"
    }
  }
}
```

Examples of user intent:

- “研究/探索都用 Rust DimAgent 的 DeepSeek V4.1 Flash，effort max。”
- “修复和重构用 Opus，普通查询用 DeepSeek Flash，默认跟主 Run。”
- “这次单独用 Opus，别改以后的路由。”
- “接下来所有 worker 和 subagent 都用我现在主 Run 的模型。” This must
  use `set_model_routes` with `all`, not only `default`, because existing
  category routes take precedence over `default`.

The leader implements the first two by emitting a `set_model_routes` action; it
implements a one-off request with `modelOverride: true` on `add_task`. Routes
are keyed by `default`, `light`/`fast`, `standard`, `deep`/`research`/`explore`,
and `coding`/`fix`/`repair`. A leader can also pass `category` to `add_task`
(for example `category:"deep"`) when the user clearly describes the task as
exploration or repair, so routing follows the user's intent rather than only
the title classifier. To intentionally make every category use one pair,
use the action's `all` field:

```json
{
  "type": "set_model_routes",
  "all": {
    "provider": "dima",
    "model": "deepseek-v4.1-flash",
    "effort": "max"
  }
}
```

A route always carries **provider + model** because a T3 model slug is only
unique inside its provider. `dimcode-api-oauth/deepseek-v4.1-flash` belongs to
the `dim` provider, while `deepseek-v4.1-flash` belongs to `dima`. Foreman
rejects a model namespace used as a provider id before T3 starts.

The current master thread's provider/model/effort is included in the leader
prompt as the `【当前主 Run】` section. That makes “use my current run's model”
unambiguous without forcing every worker to inherit it automatically.

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

Foreman does not choose the reasoning option id from the provider name. It
reads the model's `capabilities.optionDescriptors` from T3's provider catalog,
finds the descriptor with `role: "reasoning"`, and uses that descriptor's id
and allowed values:

- DimAgent models currently use `thought_level`; values vary by model.
- Rust DimAgent (`dima`) and Claude Agent (`claudeAgent`) use `effort`.
- Codex uses `reasoningEffort`.
- A new or custom provider can use any descriptor id without a Foreman code
  change.

Foreman's provider-neutral values (`auto`, `none`, `high`, `max`) are mapped to
the closest advertised value for that model. For example `max` becomes `max`
when advertised, `xhigh` when that is the model's ceiling, or is rejected when
the model has no higher effort value. `auto` omits the option so the provider
uses its own default. `t3ReasoningOption` is only a fallback when no catalog
descriptor is available.

If T3 rejects an option, the daemon blocks the task before start when the
catalog can detect it. Check the model's `capabilities.optionDescriptors` for
the exact id/value list.

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
- Effort values are derived from the selected provider/model where the T3
  provider exposes option descriptors; for dima DeepSeek V4.1 Flash that is
  `none`, `high`, or `max`, not the generic T3 labels.
- The Foreman ACP session advertises `availableModels[]._meta.reasoningEfforts`
  so T3 keeps a per-model effort picker instead of applying the first model's
  effort list to every model. A T3 restart is required to reload this metadata.
- Other registered providers (including Codex, Claude Agent, and custom
  providers) are executed through a T3 leader thread, so their T3 provider
  authentication, model catalog, and reasoning option id are honored.
- A provider that is unavailable or fails to answer falls back to Foreman's rule
  report rather than hanging the master thread indefinitely.
- Explicit `leaderChoices` are merged with choices discovered from enabled T3
  provider caches. This is useful when a provider's cache only advertises a
  default model (for example an alpha provider).
- The selection is persisted per T3 master thread (`meta.master_fc:<threadId>`).
  Resuming/restarting the T3 thread reuses it. Tasks created by a master carry
  its `master_thread_id`, so their start/completion/failure notifications return
  to that master. Automatic leader wakeups use the primary master's stored FC;
  use `foreman master set` to change the primary.
- Turns are queued per master thread (`masterThreadId`), so a slow FC provider
  in one master does not block another master.
- If the selected provider fails, the reply is prefixed with an explicit
  fallback warning and the task keeps the error in its chat/status.
- After adding/removing a T3 provider or model, restart T3 so its provider cache
  refreshes; then restart Foreman if `leaderChoices`/`leaderProvider` changed.

## Upstream provider/model changes

The **leader** has its own model and effort (`leaderMode`, `leaderProvider`,
`leaderModel`, `leaderEffort`). The **workers** use `t3Provider`, `t3Model`, and
the `modelFast` / `modelStrong` / `modelCoding` tiers. A task may override the
worker provider and model; `forceModel` and `forceProvider` remove that override
path when a deployment needs a fixed fleet.

Foreman reads the T3 provider cache on target resolution, so route and task
preflight notices model additions/removals without a Foreman restart. The cache
is a snapshot of T3's capability/auth state, not a live RPC: restart T3 after a
provider change to refresh it, and treat auth failures as thread-start errors.
The fast/strong/coding tier slugs remain explicit config values (`modelFast`,
`modelStrong`, `modelCoding`) or environment overrides. If T3 renames a model,
update those tier values; a live T3 capability/auth RPC is still a roadmap item.
`foreman models` shows the effective config and catalog-derived reasoning ids.
