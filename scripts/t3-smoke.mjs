#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { createAdapter } from "../src/adapters/index.mjs";

// Requires a running T3 server with the provider configured.
// Defaults to the deterministic mock ACP provider registered by
// `npm run t3:register-mock`.

const config = loadConfig({
  adapter: "t3",
  t3Project: process.env.FOREMAN_T3_PROJECT || undefined,
  t3Provider: process.env.FOREMAN_T3_PROVIDER || undefined,
  t3Model: process.env.FOREMAN_T3_MODEL || undefined,
  t3Worktree: false,
});

const adapter = createAdapter("t3", config);
const task = {
  id: "t3-smoke",
  title: "t3 smoke",
  brief: process.env.T3_SMOKE_BRIEF || "Say T3_SMOKE_OK and finish.",
  project_path: config.t3Project,
  thread_id: null,
};

console.log(`provider=${config.t3Provider} model=${config.t3Model}`);
console.log(`project=${config.t3Project}`);

const started = await adapter.start(task);
task.thread_id = started.threadId;
console.log(`thread=${started.threadId}`);

for (let index = 0; index < 180; index += 1) {
  const outcome = await adapter.poll(task);
  if (outcome.state === "running") {
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    continue;
  }
  console.log("");
  if (outcome.state === "done") {
    console.log(`done: ${String(outcome.result || "").slice(0, 400)}`);
    process.exit(0);
  }
  console.error(
    `\nT3 worker ended in state ${outcome.state}: ${outcome.error || ""}`,
  );
  process.exit(1);
}

console.error("\nT3 smoke timed out after 180s");
process.exit(1);
