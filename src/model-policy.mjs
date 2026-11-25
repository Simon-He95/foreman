const EFFORT_ALIASES = {
  auto: "auto",
  none: "none",
  off: "none",
  low: "none",
  medium: "high",
  high: "high",
  max: "max",
  maximum: "max",
  ultra: "max",
};

export const EFFORT_LEVELS = ["auto", "none", "high", "max"];

export function normalizeEffort(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  return EFFORT_ALIASES[raw] || null;
}

export function reasoningValue(model, effort) {
  const value = normalizeEffort(effort);
  if (!value || value === "auto") return value;
  const name = String(model || "").toLowerCase();
  // Dim's newer reasoning models expose xhigh as their maximum, while the
  // flash models use max and none. Keep the task-level vocabulary stable and
  // translate only at the provider boundary.
  if (/gpt-6\.(1|2)|claude-(opus|sonnet)-5|astra|sol/.test(name)) {
    if (value === "max") return "xhigh";
    if (value === "none") return "low";
  }
  return value;
}

export function modelCatalog(config) {
  const fast = config.modelFast || config.t3Model || null;
  const strong =
    config.modelStrong ||
    (config.t3Provider === "dim"
      ? "dimcode-api-oauth/gpt-6.2-astra"
      : fast);
  const coding =
    config.modelCoding ||
    (config.t3Provider === "dim"
      ? "dimcode-api-oauth/claude-opus-5-5"
      : fast);
  return { fast, strong, coding };
}

export function classifyTask({ title = "", brief = "" } = {}) {
  const titleText = String(title);
  const text = `${title}\n${brief}`;

  // "Implement/fix/refactor" is a code change. Do not let an API URL or the
  // word "代码" in a research brief turn a read-only lookup into a coding task.
  const editIntent =
    /(实现|修复|重构|迁移|开发|编写|写(个|一个|代码|脚本|测试)|修改|改(一下|成|为)?|新增|添加|删除|移除|补(一下|个|充)?|优化|调试|部署|升级|接入|拆分|合并|fix|implement|refactor|migrate|develop|write|edit|modify|add|remove|delete|optimi[sz]e|debug|deploy|upgrade)/i.test(
      titleText,
    );
  const codingSurface =
    /(代码|函数|接口|页面|组件|脚本|数据库|测试|bug|feature|api|cli|typescript|javascript|python|rust|go)/i.test(
      text,
    );
  const deepIntent =
    /(调研|研究|调查|盘点|收集|汇总|分析|对比|评估|审计|审查|架构|根因|方案|复杂|深度|跨模块|全面|多步|review|research|investigate|survey|collect|compare|audit|analy[sz]e)/i.test(
      titleText,
    );
  const simpleResearch =
    /(查询|查看|看看|查一下|查下|^查|列出|下载量|下载趋势|反向依赖|依赖数|最新版本|发布时间|数据来源|天气|气温|价格|汇率|新闻|统计)/i.test(
      titleText,
    );

  if (editIntent) return "coding";
  if (deepIntent) return "deep";
  // A simple lookup with an API URL is still research, not a coding task.
  if (simpleResearch) return "standard";
  if (codingSurface) return "coding";
  if (
    text.length < 1500 &&
    /(重命名|格式化|typo|文案|注释|文档|readme|小改|简单|单文件|措辞|翻译)/i.test(
      text,
    )
  ) {
    return "light";
  }
  return "standard";
}

export function planTaskModel(
  config,
  { title, brief, adapter, model, effort } = {},
) {
  if (adapter && adapter !== "t3") {
    return { model: null, effort: null, tier: "none" };
  }
  const catalog = modelCatalog(config);
  const tier = classifyTask({ title, brief });
  const base = {
    light: { model: catalog.fast, effort: "none" },
    standard: { model: catalog.fast, effort: "auto" },
    deep: { model: catalog.strong, effort: "max" },
    coding: { model: catalog.coding, effort: "max" },
  }[tier];

  let selectedModel =
    model && String(model).trim() && String(model).trim() !== "auto"
      ? String(model).trim()
      : null;
  if (selectedModel) {
    const alias = {
      fast: catalog.fast,
      strong: catalog.strong,
      coding: catalog.coding,
      default: null,
    }[selectedModel.toLowerCase()];
    if (alias !== undefined) selectedModel = alias;
  }
  let selectedEffort = normalizeEffort(effort);

  if (!selectedModel && !selectedEffort) {
    return { ...base, tier };
  }
  if (!selectedModel) {
    selectedModel = base.model;
    if (
      (selectedEffort === "max" || selectedEffort === "high") &&
      (tier === "light" || tier === "standard")
    ) {
      selectedModel = tier === "coding" ? catalog.coding : catalog.strong;
    }
  }
  if (!selectedEffort) selectedEffort = base.effort;
  if (!selectedModel) selectedModel = catalog.fast;
  return { model: selectedModel, effort: selectedEffort, tier };
}

export function modelPolicyText(config) {
  const catalog = modelCatalog(config);
  return [
    `fast=${catalog.fast || "(provider default)"}`,
    `strong=${catalog.strong || "(provider default)"}`,
    `coding=${catalog.coding || "(provider default)"}`,
    "effort=auto|none|high|max",
  ].join(" | ");
}

export function inferUserModelPreference(text, config) {
  const raw = String(text || "");
  if (!raw.trim()) return null;
  const catalog = modelCatalog(config);
  let model = null;
  if (/(claude|opus)/i.test(raw)) model = catalog.coding;
  else if (/(gpt-?6\.2|astra|gpt-?6\.1|sol)/i.test(raw)) model = catalog.strong;
  else if (/(deepseek.*(pro|v4-pro))/i.test(raw)) model = catalog.strong;
  else if (/(flash|快模型|便宜|轻量|fast)/i.test(raw)) model = catalog.fast;
  else if (/(强模型|最强|更强|高智商|strong)/i.test(raw)) model = catalog.strong;

  let effort = null;
  if (/(思考.{0,12}(最大|最高|拉满|开满)|effort\s*(max|maximum)|max\s*(thinking|effort)|最高推理|深度思考)/i.test(raw)) {
    effort = "max";
    if (!model) model = catalog.strong;
  } else if (/(思考.{0,12}高|effort\s*high)/i.test(raw)) {
    effort = "high";
  } else if (/(关闭思考|不用思考|effort\s*none)/i.test(raw)) {
    effort = "none";
  }

  if (!model && !effort) return null;
  if (!model && effort === "max") model = catalog.strong;
  return { model, effort };
}

