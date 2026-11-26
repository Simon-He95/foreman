import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EFFORT_LEVELS, normalizeEffort } from "./model-policy.mjs";

const MEDIA_MODEL = /(seedream|seedance|seed-2|image|video|tts|music|audio|embed|rerank|vision|sora)/i;
const SKIP_PROVIDERS = new Set(["foreman", "foremanMock", "mock"]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function providerMode(provider) {
  if (provider === "dim") return "dim";
  if (provider === "dima") return "dima";
  // All T3-configured providers use a T3 leader thread, so their own
  // authentication, model, and reasoning options are honored.
  return "t3";
}

function reasoningDescriptor(model) {
  const descriptors = model?.capabilities?.optionDescriptors || [];
  return (
    descriptors.find(
      (item) =>
        item.role === "reasoning" ||
        ["effort", "reasoningEffort", "thought_level"].includes(item.id),
    ) || null
  );
}

function reasoningMetadata(model) {
  const descriptor = reasoningDescriptor(model);
  if (!descriptor) return null;
  const options = (descriptor.options || [])
    .map((option) => {
      const id = String(option.id ?? option.value ?? "").trim();
      if (!id) return null;
      return {
        id,
        label: String(option.label || id),
        ...(option.isDefault ? { isDefault: true } : {}),
      };
    })
    .filter(Boolean);
  if (!options.length) return null;
  return {
    id: String(descriptor.id || "reasoning"),
    label: String(descriptor.label || descriptor.id || "Reasoning"),
    options,
    currentValue:
      descriptor.currentValue === undefined
        ? null
        : String(descriptor.currentValue),
  };
}

function canonicalEfforts(model) {
  const reasoning = reasoningMetadata(model);
  if (!reasoning) return null;
  const efforts = new Set();
  for (const option of reasoning.options) {
    const value = option.id.toLowerCase();
    if (value === "provider-default" || value === "auto") efforts.add("auto");
    else if (["max", "xhigh", "ultra", "ultrathink"].includes(value)) efforts.add("max");
    else if (["high"].includes(value)) efforts.add("high");
    else if (["none", "low", "minimal", "medium", "off"].includes(value)) efforts.add("none");
  }
  return efforts.size
    ? [...["auto", "none", "high", "max"]].filter((effort) => efforts.has(effort))
    : null;
}

export function t3Home(config = null) {
  if (config?.t3Home) return path.resolve(config.t3Home);
  return process.env.T3CODE_HOME
    ? path.resolve(process.env.T3CODE_HOME)
    : path.join(os.homedir(), ".t3");
}

function settingsProviders(config = null) {
  const data = readJson(path.join(t3Home(config), "userdata", "settings.json"));
  return data?.providerInstances || {};
}

function cacheFiles(config = null) {
  const caches = path.join(t3Home(config), "caches");
  let names = [];
  try {
    names = fs.readdirSync(caches).filter((name) => name.endsWith(".json"));
  } catch {
    return { caches, entries: [] };
  }
  const entries = names.map((name) => {
    const file = path.join(caches, name);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      // A cache file can disappear while T3 refreshes it.
    }
    return stat
      ? { name, file, mtimeMs: stat.mtimeMs, size: stat.size }
      : null;
  }).filter(Boolean);
  return { caches, entries };
}

/**
 * A catalog snapshot with provenance. The T3 provider cache is currently the
 * only stable capability source available to Foreman's control plane; it is a
 * snapshot, not a live RPC. Surfacing source/revision/staleness lets callers
 * avoid pretending otherwise.
 */
export function t3CatalogSnapshot(config = null) {
  const { caches, entries } = cacheFiles(config);
  const instances = settingsProviders(config);
  const choices = [];
  const providers = new Map();
  let observedAt = null;
  for (const entry of entries) {
    const data = readJson(entry.file);
    if (!data) continue;
    const checkedAt = data.checkedAt ? Date.parse(data.checkedAt) : NaN;
    const seenAt = Number.isFinite(checkedAt)
      ? Math.max(checkedAt, entry.mtimeMs)
      : entry.mtimeMs;
    if (Number.isFinite(seenAt)) {
      observedAt = observedAt === null ? seenAt : Math.max(observedAt, seenAt);
    }
    const provider =
      data.providerInstanceId ||
      data.instanceId ||
      path.basename(entry.name, ".json");
    if (SKIP_PROVIDERS.has(provider)) continue;
    const settings = instances[provider];
    if (
      data.enabled === false ||
      data.installed === false ||
      (settings && settings.enabled === false)
    ) {
      continue;
    }
    const displayName = data.displayName || provider;
    const models = Array.isArray(data.models) ? data.models : [];
    if (models.length && !providers.has(provider)) {
      providers.set(provider, {
        id: provider,
        displayName,
        status: data.status || null,
        auth: data.auth?.status || null,
        installed: data.installed !== false,
        enabled: data.enabled !== false,
        checkedAt: data.checkedAt || null,
      });
    }
    for (const model of models) {
      const slug = String(model.slug || model.modelId || "").trim();
      if (!slug || MEDIA_MODEL.test(slug)) continue;
      const aliases = Array.isArray(model.aliases)
        ? model.aliases.map((alias) => String(alias).trim()).filter(Boolean)
        : [];
      choices.push({
        id: `${provider}::${slug}`,
        provider,
        model: slug,
        aliases,
        label: `${displayName} / ${model.name || slug}`,
        description: `${provider} · ${slug}`,
        efforts: canonicalEfforts(model),
        reasoning: reasoningMetadata(model),
        advertised: true,
        source: "t3-catalog",
        isCustom: Boolean(model.isCustom),
        providerStatus: data.status || null,
        providerAuth: data.auth?.status || null,
        providerInstalled: data.installed !== false,
        providerEnabled: data.enabled !== false,
        cacheCheckedAt: data.checkedAt || null,
      });
    }
  }
  const revision = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        entries: entries.map((entry) => [
          entry.name,
          Math.round(entry.mtimeMs),
          entry.size,
        ]),
        models: choices.map((choice) => choice.id).sort(),
      }),
    )
    .digest("hex")
    .slice(0, 16);
  const staleAfterMs = 6 * 60 * 60 * 1000;
  const stale =
    observedAt === null ? true : Date.now() - observedAt > staleAfterMs;
  return {
    source: choices.length ? "t3-cache" : entries.length ? "t3-cache-empty" : "unavailable",
    live: false,
    cacheDir: caches,
    revision,
    observedAt,
    stale,
    staleAfterMs,
    providers: [...providers.values()],
    choices,
    fileCount: entries.length,
  };
}

function cacheChoices(config = null) {
  return t3CatalogSnapshot(config).choices;
}

function explicitChoices(config) {
  const rows = Array.isArray(config.leaderChoices)
    ? config.leaderChoices
    : [];
  return rows
    .map((row) => {
      if (typeof row === "string") {
        const at = row.indexOf("::");
        if (at < 0) return null;
        return {
          provider: row.slice(0, at),
          model: row.slice(at + 2),
          label: row,
        };
      }
      if (!row || typeof row !== "object") return null;
      const provider = String(row.provider || row.id || "").trim();
      const model = String(row.model || "").trim();
      if (!provider || !model) return null;
      return {
        provider,
        model,
        label: String(row.label || `${provider} / ${model}`),
        description: row.description ? String(row.description) : undefined,
        advertised: false,
        source: "config",
      };
    })
    .filter(Boolean)
    .map((row) => ({
      ...row,
      id: `${row.provider}::${row.model}`,
      label: row.label || `${row.provider} / ${row.model}`,
      description: row.description || `${row.provider} · ${row.model}`,
    }));
}

function defaultProvider(config) {
  if (config.leaderProvider) return String(config.leaderProvider).trim();
  const mode = String(config.leaderMode || "").trim();
  if (mode === "claude") return "claudeAgent";
  if (mode === "dima" || mode === "codex" || mode === "dim") return mode;
  return "dim";
}

/**
 * Only models T3 actually advertised in its provider cache are authoritative
 * for preflight. Explicit leaderChoices remain UI/config preferences until T3
 * confirms them.
 */
export function advertisedModelChoices(config) {
  return t3CatalogSnapshot(config).choices;
}

export function leaderChoices(config) {
  const merged = new Map();
  for (const choice of explicitChoices(config)) merged.set(choice.id, choice);
  for (const choice of cacheChoices(config)) {
    const previous = merged.get(choice.id);
    merged.set(
      choice.id,
      previous
        ? {
            ...choice,
            ...previous,
            advertised: true,
            source: "t3-catalog",
            efforts: choice.efforts || previous.efforts,
            reasoning: choice.reasoning || previous.reasoning,
          }
        : choice,
    );
  }
  const choices = [...merged.values()];
  const provider = defaultProvider(config);
  const model = String(config.leaderModel || "").trim();
  if (model) {
    const id = `${provider}::${model}`;
    if (!choices.some((choice) => choice.id === id)) {
      choices.unshift({
        id,
        provider,
        model,
        label: `${provider} / ${model}`,
        description: `${provider} · ${model}`,
      });
    }
  }
  const seen = new Set();
  const deduped = [];
  for (const choice of choices) {
    if (!choice?.id || seen.has(choice.id)) continue;
    seen.add(choice.id);
    deduped.push(choice);
  }
  if (deduped.length === 0) {
    deduped.push({
      id: `${provider}::${model || "default"}`,
      provider,
      model: model || "default",
      label: `${provider} / ${model || "default"}`,
      description: `${provider} · ${model || "default"}`,
    });
  }
  const preferred =
    deduped.find((choice) => choice.id === `${provider}::${model}`) ||
    // With no explicit model, prefer the configured provider's first
    // advertised model instead of whatever happens to be first in T3's cache.
    deduped.find((choice) => choice.provider === provider);
  return { choices: deduped, defaultChoice: preferred || deduped[0] };
}

export function parseLeaderChoice(value, options = null) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const at = raw.indexOf("::");
  if (at > 0) {
    return {
      provider: raw.slice(0, at),
      model: raw.slice(at + 2),
    };
  }
  if (options?.choices) {
    const match = options.choices.find(
      (choice) => choice.model === raw || choice.id === raw,
    );
    if (match) return { provider: match.provider, model: match.model };
  }
  return { model: raw };
}

export function normalizeLeaderOverride(input, config, options = null) {
  const opts = options || leaderChoices(config);
  const value =
    typeof input === "string" ? parseLeaderChoice(input, opts) : input;
  const choice =
    value && value.provider && value.model
      ? opts.choices.find(
          (item) =>
            item.provider === value.provider && item.model === value.model,
        )
      : null;
  const provider = String(
    value?.provider || choice?.provider || opts.defaultChoice.provider,
  ).trim();
  const model = String(
    value?.model || choice?.model || opts.defaultChoice.model,
  ).trim();
  const effort =
    normalizeEffort(value?.effort) ||
    normalizeEffort(config.leaderEffort) ||
    "auto";
  return {
    provider,
    model,
    effort,
    mode: providerMode(provider),
    label:
      choice?.label ||
      `${provider} / ${model}`,
  };
}

export function leaderConfigOptions(config, currentInput = null) {
  const options = leaderChoices(config);
  const current = normalizeLeaderOverride(currentInput, config, options);
  const choice = options.choices.find(
    (item) =>
      item.provider === current.provider && item.model === current.model,
  );
  const efforts = [
    ...new Set([
      ...(choice?.efforts || EFFORT_LEVELS),
      current.effort,
    ]),
  ];
  const models = {
    currentModelId: `${current.provider}::${current.model}`,
    availableModels: options.choices.map((choice) => {
      const efforts = choice.efforts || EFFORT_LEVELS;
      const currentEffort = efforts.includes(current.effort)
        ? current.effort
        : efforts[0] || "auto";
      return {
        modelId: choice.id,
        name: choice.label,
        description: choice.description,
        _meta: {
          reasoningEfforts: efforts.map((effort) => ({
            value: effort,
            label: effort,
          })),
          reasoningEffort: currentEffort,
        },
      };
    }),
  };
  return {
    options,
    current,
    models,
    configOptions: [
      {
        id: "model",
        name: "FC model",
        category: "model",
        type: "select",
        currentValue: `${current.provider}::${current.model}`,
        options: options.choices.map((choice) => ({
          value: choice.id,
          name: choice.label,
          description: choice.description,
        })),
      },
      {
        id: "effort",
        name: "FC reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue: current.effort,
        options: efforts.map((effort) => ({
          value: effort,
          name: effort,
        })),
      },
    ],
  };
}

export function leaderProviderSummary(config) {
  const { choices, defaultChoice } = leaderChoices(config);
  return {
    default: defaultChoice,
    choices,
  };
}
