import { leaderChoices } from "./leader-options.mjs";
import { normalizeEffort, normalizeModelRoutes } from "./model-policy.mjs";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sameModelSuffix(choice, model) {
  const wanted = String(model || "").split("/").pop()?.toLowerCase();
  return wanted && String(choice.model || "").split("/").pop()?.toLowerCase() === wanted;
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
  const choices = leaderChoices(config).choices;
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
    (choice) => choice.provider === provider && choice.model === model,
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
      `model ${provider}::${model} is a custom T3 registration; verify the provider accepts it`,
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
  if (effort && Array.isArray(exact.efforts) && exact.efforts.length && !exact.efforts.includes(effort)) {
    return {
      ok: false,
      errors: [
        `effort ${effort} is not supported by ${provider}::${model}; supported: ${exact.efforts.join(", ")}`,
      ],
      warnings,
      suggestions: [],
    };
  }
  return {
    ok: true,
    errors: [],
    warnings,
    suggestions: [],
    choice: {
      provider: exact.provider,
      model: exact.model,
      effort: effort || "auto",
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

export function availableModelChoices(config) {
  return leaderChoices(config).choices.map((choice) => ({
    id: choice.id,
    provider: choice.provider,
    model: choice.model,
    label: choice.label,
    efforts: choice.efforts || null,
    isCustom: Boolean(choice.isCustom),
    providerStatus: choice.providerStatus || null,
    providerAuth: choice.providerAuth || null,
  }));
}
