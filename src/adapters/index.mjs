import { MockAdapter } from "./mock.mjs";
import { T3Adapter } from "./t3.mjs";

export function createAdapter(name, config) {
  if (name === "mock") {
    return new MockAdapter({
      dataDir: config.dataDir,
      leaseMs: config.mockLeaseMs,
    });
  }
  if (name === "t3") {
    return new T3Adapter({
      t3Bin: config.t3Bin,
      projectPath: config.t3Project,
      worktree: config.t3Worktree,
      worktreeBase: config.t3WorktreeBase,
      provider: config.t3Provider,
      model: config.t3Model,
      reasoningOption: config.t3ReasoningOption,
      leaseMs: config.t3LeaseMs,
      config,
    });
  }
  throw new Error(`unknown adapter: ${name}`);
}

export function createAdapterRegistry(config) {
  const names = new Set(["mock", "t3", config.adapter]);
  const registry = {};
  for (const name of names) {
    registry[name] = createAdapter(name, config);
  }
  return registry;
}
