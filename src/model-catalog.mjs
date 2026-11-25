import {
  advertisedModelChoices,
  leaderChoices,
  t3CatalogSnapshot,
} from "./leader-options.mjs";
import {
  normalizeEffort,
  normalizeModelRoutes,
  reasoningOptionValue,
} from "./model-policy.mjs";

function catalogFields(snapshot) {
  return {
    catalogRevision: snapshot.revision || null,
    catalogSource: snapshot.source || "unknown",
    catalogObservedAt: snapshot.observedAt || null,
    catalogStale: Boolean(snapshot.stale),
  };
}

function sameModelSuffix(choice, model) {
  const wanted = String(model || "").split("/").pop()?.toLowerCase();
  return wanted && String(choice.model || "").split("/").pop()?.toLowerCase() === wanted;
}

function modelMatches(choice, model) {
  const wanted = String(model || "").trim();
  if (!wanted) return false;
  if (choice.model === wanted) return true;
  return (
    Array.isArray(choice.aliases) &&
    choice.aliases.some((alias) => String(alias).trim() === wanted)
  );
}

function findModelChoice(config, { provider = null, model = null } = {}) {
  const choices = advertisedModelChoices(config);
  const candidates = choices.filter(
    (choice) =>
      (!provider || choice.provider === provider) &&
      modelMatches(choice, model),
  );
  if (candidates.length === 0) return null;
  if (provider) return candidates[0];
  return candidates.length === 1 ? candidates[0] : null;
}

function providerChoices(config, model, provider = null) {
  return advertisedModelChoices(config).filter(
    (choice) => (!provider || choice.provider === provider) && modelMatches(choice, model),
  );
}

export function inferProviderForModel(config, model, preferredProviders = []) {
  const wanted = String(model || "").trim();
  if (!wanted) return { provider: null, candidates: [], ambiguous: false };
  const choices = providerChoices(config, wanted);
  const providers = [...new Set(choices.map((choice) => choice.provider))];
  for (const preferred of preferredProviders) {
    if (preferred && providers.includes(String(preferred))) {
      return { provider: String(preferred), candidates: choices, ambiguous: false };
    }
  }
  if (providers.length === 1) {
    return { provider: providers[0], candidates: choices, ambiguous: false };
  }
  return {
    provider: null,
    candidates: choices,
    ambiguous: providers.length > 1,
    providers,
  };
}

/**
 * Resolve a task target from the provider/model pair, using the T3 catalog to
 * disambiguate bare model slugs. A bare slug is only safe when exactly one
 * advertised provider owns it, or when a preferred provider is explicitly
 * known to advertise it. This is the part the leader prompt cannot enforce.
 */
export function resolveModelTarget(
  config,
  target,
  { preferredProviders = [] } = {},
) {
  const inputProvider = String(target?.provider || "").trim() || null;
  const inputModel = String(target?.model || "").trim() || null;
  const effort = normalizeEffort(target?.effort);
  const snapshot = t3CatalogSnapshot(config);
  const choices = snapshot.choices;

  if (!inputModel) {
    const fallbackProvider =
      inputProvider ||
      preferredProviders.map((value) => String(value || "").trim()).find(Boolean) ||
      null;
    return {
      provider: fallbackProvider,
      model: null,
      effort,
      inferredProvider: false,
      validation: {
        ok: true,
        errors: [],
        warnings: [],
        suggestions: [],
      },
      ...catalogFields(snapshot),
    };
  }

  if (choices.length === 0) {
    const fallbackProvider =
      inputProvider ||
      preferredProviders.map((value) => String(value || "").trim()).find(Boolean) ||
      null;
    return {
      provider: fallbackProvider,
      model: inputModel,
      effort,
      inferredProvider: false,
      validation: {
        ok: true,
        errors: [],
        warnings: ["T3 provider catalog is unavailable; target was not preflighted"],
        suggestions: [],
      },
      ...catalogFields(snapshot),
    };
  }

  const inference = inputProvider
    ? { provider: inputProvider, candidates: providerChoices(config, inputModel, inputProvider), ambiguous: false }
    : inferProviderForModel(config, inputModel, preferredProviders);

  if (!inference.provider) {
    const advertised = inference.candidates.slice(0, 8).map(
      (choice) => `${choice.provider}::${choice.model}`,
    );
    const message = inference.ambiguous
      ? `provider is required: model ${inputModel} is advertised by ${inference.providers.join(", ")}`
      : `model ${inputModel} is not advertised by T3`;
    return {
      provider: null,
      model: inputModel,
      effort,
      inferredProvider: false,
      validation: {
        ok: false,
        errors: [message],
        warnings: [],
        suggestions: inference.candidates.slice(0, 8).map((choice) => ({
          provider: choice.provider,
          model: choice.model,
          label: choice.label,
        })),
        advertised,
      },
    };
  }

  const choice = inference.candidates.find(
    (item) =>
      item.provider === inference.provider && modelMatches(item, inputModel),
  );
  const model = choice?.model || inputModel;
  const validation = validateModelTarget(config, {
    provider: inference.provider,
    model,
    effort,
  });
  return {
    provider: inference.provider,
    model,
    effort,
    inferredProvider: !inputProvider,
    validation,
    ...catalogFields(snapshot),
  };
}

/**
 * The immutable plan persisted with a task. The task's provider/model/effort
 * remain queryable columns for compatibility; targetPlan is the audit trail of
 * how the target was resolved and what actual reasoning option will be sent.
 */
export function targetPlanFromResolution(
  resolution,
  { source = "unknown", requested = null } = {},
) {
  const validation = resolution?.validation || {};
  const reasoning = validation.reasoning || resolution?.reasoning || null;
  return {
    provider: resolution?.provider || null,
    model: resolution?.model || null,
    effort: resolution?.effort || null,
    reasoning,
    source: source || "unknown",
    requested: requested
      ? {
          provider: requested.provider || null,
          model: requested.model || null,
          effort: requested.effort || null,
        }
      : null,
    catalogRevision: resolution?.catalogRevision || null,
    catalogSource: resolution?.catalogSource || null,
    catalogObservedAt: resolution?.catalogObservedAt || null,
    catalogStale: Boolean(resolution?.catalogStale),
    validation: {
      ok: validation.ok !== false,
      errors: validation.errors || [],
      warnings: validation.warnings || [],
      suggestions: validation.suggestions || [],
    },
  };
}

export function parseTargetJson(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveTargetPlan(
  config,
  target,
  { preferredProviders = [], source = "unknown" } = {},
) {
  const resolution = resolveModelTarget(config, target, { preferredProviders });
  return targetPlanFromResolution(resolution, {
    source,
    requested: target,
  });
}

export function reasoningPlanForTarget(config, target, fallbackOption = null) {
  const provider = String(target?.provider || "").trim() || null;
  const model = String(target?.model || "").trim() || null;
  const effort = normalizeEffort(target?.effort);
  const choice = model ? findModelChoice(config, { provider, model }) : null;
  if (choice?.reasoning?.id) {
    const values = (choice.reasoning.options || []).map((option) => option.id);
    return {
      optionId: choice.reasoning.id,
      value:
        effort && effort !== "auto"
          ? reasoningOptionValue(effort, values)
          : null,
      source: "catalog",
      supportedValues: values,
    };
  }
  if (!choice) {
    // Do not guess a provider-specific option id when the catalog cannot
    // identify the model. An explicit fallback is safer than a wrong option.
    return {
      optionId: fallbackOption || null,
      value: effort && effort !== "auto" ? effort : null,
      source: fallbackOption ? "config" : "none",
      supportedValues: null,
    };
  }
  return {
    optionId: fallbackOption || null,
    value: effort && effort !== "auto" ? effort : null,
    source: fallbackOption ? "config" : "none",
    supportedValues: choice.efforts || null,
  };
}

function catalogFailure(message, choices, provider) {
  const providerChoices = choices.filter((choice) => choice.provider === provider);
  const candidates = providerChoices.length ? providerChoices : choices;
  return {
    ok: false,
    errors: [message],
    warnings: [],
    suggestions: candidates.slice(0, 8).map((choice) => ({
      provider: choice.provider,
      model: choice.model,
      label: choice.label,
    })),
  };
}

/**
 * Validate a provider/model target against the catalog T3 has advertised.
 * T3's cache is a snapshot, not a live RPC, so warnings are surfaced without
 * pretending that an unauthenticated or custom registration is guaranteed.
 */
export function validateModelTarget(config, target) {
  const provider = String(target?.provider || "").trim();
  const model = String(target?.model || "").trim();
  const effort = normalizeEffort(target?.effort);
  const choices = advertisedModelChoices(config);
  if (!provider || !model) {
    return {
      ok: false,
      errors: ["provider and model are required"],
      warnings: [],
      suggestions: [],
    };
  }
  if (choices.length === 0) {
    return {
      ok: true,
      errors: [],
      warnings: ["T3 provider catalog is unavailable; target was not preflighted"],
      suggestions: [],
    };
  }
  const exact = choices.find(
    (choice) =>
      choice.provider === provider && modelMatches(choice, model),
  );
  if (!exact) {
    const suffixMatches = choices.filter((choice) => sameModelSuffix(choice, model));
    return catalogFailure(
      `model ${provider}::${model} is not advertised by T3`,
      suffixMatches.length ? suffixMatches : choices,
      provider,
    );
  }
  const warnings = [];
  if (exact.isCustom) {
    warnings.push(
      `model ${provider}::${exact.model} is a custom T3 registration; verify the provider accepts it`,
    );
  }
  if (exact.providerStatus && !["ready", "ok"].includes(String(exact.providerStatus).toLowerCase())) {
    warnings.push(`provider ${provider} status is ${exact.providerStatus}`);
  }
  if (exact.providerInstalled === false) {
    warnings.push(`provider ${provider} is not installed`);
  }
  if (exact.providerEnabled === false) {
    warnings.push(`provider ${provider} is disabled`);
  }
  if (String(exact.providerAuth || "").toLowerCase() === "unauthenticated") {
    warnings.push(`provider ${provider} needs authentication`);
  }
  if (effort && effort !== "auto" && !exact.reasoning) {
    warnings.push(
      `model ${provider}::${exact.model} does not advertise reasoning options; effort ${effort} will use the configured fallback`,
    );
  }
  const reasoning = reasoningPlanForTarget(
    config,
    { provider, model: exact.model, effort },
    null,
  );
  if (
    effort &&
    effort !== "auto" &&
    exact.reasoning &&
    !reasoning.value
  ) {
    const supported = exact.efforts?.length
      ? exact.efforts.join(", ")
      : exact.reasoning.options.map((option) => option.id).join(", ");
    return {
      ok: false,
      errors: [
        `effort ${effort} is not supported by ${provider}::${exact.model}; supported: ${supported}`,
      ],
      warnings,
      suggestions: [],
      reasoning,
    };
  }
  if (
    effort &&
    effort !== "auto" &&
    !exact.reasoning &&
    Array.isArray(exact.efforts) &&
    exact.efforts.length &&
    !exact.efforts.includes(effort)
  ) {
    return {
      ok: false,
      errors: [
        `effort ${effort} is not supported by ${provider}::${exact.model}; supported: ${exact.efforts.join(", ")}`,
      ],
      warnings,
      suggestions: [],
      reasoning,
    };
  }
  return {
    ok: true,
    errors: [],
    warnings,
    suggestions: [],
    reasoning,
    choice: {
      provider: exact.provider,
      model: exact.model,
      effort: effort || "auto",
      reasoningOption: reasoning.optionId,
      reasoningValue: reasoning.value,
      label: exact.label,
    },
  };
}

export function validateModelRoutes(config, routes) {
  const normalized = normalizeModelRoutes(routes);
  const results = [];
  for (const [category, route] of Object.entries(normalized)) {
    const result = validateModelTarget(config, route);
    results.push({ category, route, ...result });
  }
  return {
    routes: normalized,
    results,
    ok: results.every((result) => result.ok),
    errors: results.flatMap((result) =>
      result.errors.map((error) => `${result.category}: ${error}`),
    ),
    warnings: results.flatMap((result) =>
      result.warnings.map((warning) => `${result.category}: ${warning}`),
    ),
  };
}

export function modelCatalogSnapshot(config) {
  const snapshot = t3CatalogSnapshot(config);
  return {
    source: snapshot.source,
    live: snapshot.live,
    revision: snapshot.revision,
    observedAt: snapshot.observedAt,
    stale: snapshot.stale,
    staleAfterMs: snapshot.staleAfterMs,
    providers: snapshot.providers,
    fileCount: snapshot.fileCount,
  };
}

export function availableModelChoices(config) {
  const advertised = advertisedModelChoices(config);
  const choices = advertised.length
    ? advertised
    : leaderChoices(config).choices;
  return choices.map((choice) => ({
    id: choice.id,
    provider: choice.provider,
    model: choice.model,
    aliases: choice.aliases || [],
    label: choice.label,
    efforts: choice.efforts || null,
    reasoning: choice.reasoning || null,
    advertised: Boolean(choice.advertised),
    source: choice.source || "unknown",
    isCustom: Boolean(choice.isCustom),
    providerStatus: choice.providerStatus || null,
    providerAuth: choice.providerAuth || null,
  }));
}
