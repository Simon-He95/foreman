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

export const MODEL_ROUTE_KEYS = ["default", "light", "standard", "deep", "coding"];

const MODEL_ROUTE_ALIASES = {
  default: "default",
  light: "light",
  fast: "light",
  standard: "standard",
  deep: "deep",
  research: "deep",
  explore: "deep",
  exploration: "deep",
  investigate: "deep",
  coding: "coding",
  code: "coding",
  fix: "coding",
  repair: "coding",
  implement: "coding",
};

export function normalizeModelRouteKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return MODEL_ROUTE_ALIASES[key] || null;
}

/**
 * T3 provider ids are instance ids, not model-name prefixes. A value such as
 * "dimcode-api-oauth" is part of a model slug and must never be sent as a
 * provider instance id.
 */
export function assertT3ProviderId(value, modelSlugs = []) {
  const provider = String(value || "").trim();
  if (!provider) return null;
  if (provider.includes("/") || provider.includes("::")) {
    throw new Error(
      `invalid T3 provider id "${provider}": use the provider instance id (for example dim, dima, codex, claudeAgent), not a model prefix`,
    );
  }
  const looksLikeNamespace = modelSlugs.some((slug) =>
    String(slug || "").startsWith(`${provider}/`),
  );
  if (looksLikeNamespace) {
    throw new Error(
      `invalid T3 provider id "${provider}": this is a model namespace prefix; use the provider instance id (dim, dima, codex, claudeAgent) instead`,
    );
  }
  return provider;
}

export function normalizeModelRoute(route) {
  if (route === null || route === undefined || route === "") return null;
  let value = route;
  if (typeof route === "string") {
    const at = route.indexOf("::");
    if (at <= 0 || at >= route.length - 2) {
      throw new Error(
        `invalid model route "${route}": use "provider::model" or an object with provider and model`,
      );
    }
    value = { provider: route.slice(0, at), model: route.slice(at + 2) };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model route must be an object with provider and model");
  }
  const provider = assertT3ProviderId(value.provider);
  const model = String(value.model || "").trim();
  if (!provider || !model) {
    throw new Error("model route needs both provider and model");
  }
  const rawEffort = value.effort;
  const effort = normalizeEffort(rawEffort);
  if (
    rawEffort !== undefined &&
    rawEffort !== null &&
    rawEffort !== "" &&
    !effort
  ) {
    throw new Error(`invalid effort "${rawEffort}" in model route`);
  }
  return { provider, model, ...(effort ? { effort } : {}) };
}

export function normalizeModelRoutes(routes) {
  if (routes === null || routes === undefined || routes === "") return {};
  if (typeof routes !== "object" || Array.isArray(routes)) {
    throw new Error("model routes must be an object keyed by task category");
  }
  const result = {};
  for (const [rawKey, rawRoute] of Object.entries(routes)) {
    const raw = String(rawKey || "").trim().toLowerCase();
    if (raw === "all") {
      const route = normalizeModelRoute(rawRoute);
      if (route) {
        for (const key of MODEL_ROUTE_KEYS) result[key] = route;
      }
      continue;
    }
    const key = normalizeModelRouteKey(rawKey);
    if (!key) {
      throw new Error(
        `unknown model route "${rawKey}"; use all, default, light, standard, deep, or coding`,
      );
    }
    const route = normalizeModelRoute(rawRoute);
    if (route) result[key] = route;
  }
  return result;
}

export function mergeModelRoutes(...sources) {
  const result = {};
  for (const source of sources) {
    Object.assign(result, normalizeModelRoutes(source));
  }
  return result;
}

export function assertModelRouteProviders(routes, modelSlugs = []) {
  for (const route of Object.values(normalizeModelRoutes(routes))) {
    assertT3ProviderId(route.provider, modelSlugs);
  }
  return routes;
}

export function modelRouteText(routes) {
  const entries = Object.entries(normalizeModelRoutes(routes));
  if (!entries.length) return "(none)";
  return entries
    .map(([key, route]) => {
      const effort = route.effort ? `/${route.effort}` : "";
      return `${key}=${route.provider}::${route.model}${effort}`;
    })
    .join(" | ");
}

export function normalizeEffort(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  return EFFORT_ALIASES[raw] || null;
}

/**
 * Map Foreman's provider-neutral effort vocabulary onto the option values a
 * concrete T3 model advertises. This is intentionally capability-driven: the
 * same "max" can be max, xhigh, ultra, or absent depending on the model.
 */
export function reasoningOptionValue(effort, availableValues = []) {
  const canonical = normalizeEffort(effort);
  if (!canonical || canonical === "auto") return null;
  const available = new Set(
    availableValues
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const preference = {
    none: ["none", "minimal", "low", "medium", "off"],
    high: ["high", "medium", "xhigh"],
    max: ["max", "xhigh", "ultra", "ultrathink", "high"],
  }[canonical] || [canonical];
  return preference.find((value) => available.has(value)) || null;
}

export function modelCatalog(config) {
  const fast = config.modelFast || config.t3Model || null;
  // Strong/coding are explicit deployment choices. Do not invent a model name
  // from a provider id: model inventories change independently of Foreman.
  return {
    fast,
    strong: config.modelStrong || fast,
    coding: config.modelCoding || fast,
  };
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
  {
    title,
    brief,
    adapter,
    model,
    effort,
    provider,
    category,
    routes = null,
    masterFc = null,
    modelOverride = false,
  } = {},
) {
  if (adapter && adapter !== "t3") {
    return { model: null, effort: null, tier: "none", provider: null, source: "none" };
  }
  const catalog = modelCatalog(config);
  const requestedCategory = category
    ? normalizeModelRouteKey(category)
    : null;
  if (category && !requestedCategory) {
    throw new Error(
      `invalid task category "${category}"; use light, standard, deep, or coding`,
    );
  }
  const tier =
    requestedCategory && requestedCategory !== "default"
      ? requestedCategory
      : classifyTask({ title, brief });
  const base = {
    light: { model: catalog.fast, effort: "none" },
    standard: { model: catalog.fast, effort: "auto" },
    deep: { model: catalog.strong, effort: "max" },
    coding: { model: catalog.coding, effort: "max" },
  }[tier];
  const routeMap = normalizeModelRoutes(routes);
  const tierRoute = routeMap[tier] || null;
  const defaultRoute = routeMap.default || null;
  const route = tierRoute || defaultRoute;
  const routeKey = tierRoute ? tier : defaultRoute ? "default" : null;
  const knownModels = [
    catalog.fast,
    catalog.strong,
    catalog.coding,
    config.t3Model,
    masterFc?.model,
    ...Object.values(routeMap).map((route) => route.model),
  ].filter(Boolean);
  for (const routeValue of Object.values(routeMap)) {
    assertT3ProviderId(routeValue.provider, knownModels);
  }
  const requestedModel =
    model && String(model).trim() && String(model).trim() !== "auto"
      ? String(model).trim()
      : null;
  const requestedEffort = normalizeEffort(effort);

  // A deployment-wide force remains an explicit, deliberate hard lock. It is
  // intentionally separate from the user-directed category routes below.
  const forcedModel = config.forceModel ? String(config.forceModel).trim() : null;
  if (forcedModel) {
    let forcedProvider = config.forceProvider
      ? assertT3ProviderId(config.forceProvider, knownModels)
      : assertT3ProviderId(provider, knownModels);
    if (
      !forcedProvider &&
      masterFc?.provider &&
      String(masterFc.model || "").trim() === forcedModel
    ) {
      forcedProvider = assertT3ProviderId(masterFc.provider, knownModels);
    }
    return {
      model: forcedModel,
      effort: requestedEffort || base.effort,
      tier,
      provider: forcedProvider || null,
      source: "force",
      route: null,
    };
  }

  // Routes are user-directed defaults for a task category. A specific task may
  // only bypass them when the leader marks it as an explicit user override.
  // A route's own effort is authoritative; otherwise a one-off effort wins.
  if (route && !(modelOverride && requestedModel)) {
    return {
      provider: route.provider,
      model: route.model,
      effort: route.effort || requestedEffort || base.effort,
      tier,
      source: "route",
      route: routeKey,
    };
  }

  const requestedProvider = assertT3ProviderId(provider, knownModels);
  let selectedModel = requestedModel;
  if (selectedModel) {
    const alias = {
      fast: catalog.fast,
      strong: catalog.strong,
      coding: catalog.coding,
      default: null,
    }[selectedModel.toLowerCase()];
    if (alias !== undefined) selectedModel = alias;
  }
  let selectedEffort = requestedEffort;
  let selectedProvider = requestedProvider;

  // A model slug is only unique inside a provider. When the user says "use my
  // current run's model", the leader may omit the provider; recover it from the
  // master selection instead of falling back to an unrelated t3Provider.
  if (
    selectedModel &&
    !selectedProvider &&
    masterFc?.provider &&
    String(masterFc.model || "").trim() === selectedModel
  ) {
    selectedProvider = assertT3ProviderId(masterFc.provider, knownModels);
  }
  if (
    selectedModel &&
    !selectedProvider &&
    route?.provider &&
    route.model === selectedModel
  ) {
    selectedProvider = route.provider;
  }

  if (!selectedModel && !selectedEffort) {
    return { ...base, tier, provider: selectedProvider || null, source: "tier", route: null };
  }
  if (!selectedModel) {
    selectedModel = route?.model || base.model;
    if (
      (selectedEffort === "max" || selectedEffort === "high") &&
      (tier === "light" || tier === "standard")
    ) {
      selectedModel = tier === "coding" ? catalog.coding : catalog.strong;
    }
  }
  if (!selectedEffort) selectedEffort = base.effort;
  if (!selectedModel) selectedModel = catalog.fast;
  return {
    model: selectedModel,
    effort: selectedEffort,
    tier,
    provider: selectedProvider || null,
    source: modelOverride ? "override" : "explicit",
    route: null,
  };
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

