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
passes them to T3 `delegate_task` as `target.model` and
`target.options = [{id: "thought_level", value: ...}]`.

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
- Other providers: set `t3ReasoningOption` to the option id they expose
  (often `effort`).

If T3 rejects an option, the daemon records the error on the task. Check
`orchestrator_capabilities` in T3 for the exact id/value list for a model.

## Upstream provider/model changes

Foreman does **not** automatically refresh the T3 provider/model catalog. The
fast/strong/coding slugs are explicit config values (`modelFast`,
`modelStrong`, `modelCoding`) or environment overrides. If T3 adds, renames, or
removes a model, update those values and restart Foreman; `foreman doctor` does
not currently validate every model slug. Dynamic discovery from T3
`orchestrator_capabilities` is a roadmap item.
