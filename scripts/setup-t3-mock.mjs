#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Registers the deterministic ACP worker in T3 as a local provider. This is a
// demo/test harness: it proves the T3 thread path without consuming model quota.
// Real deployments should point T3 at Claude, Codex, or any ACP agent instead.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.resolve(__dirname, "..", "tools", "acp-mock-agent.mjs");
if (!fs.existsSync(agentPath)) {
  console.error(`mock agent not found: ${agentPath}`);
  process.exit(1);
}
fs.chmodSync(agentPath, 0o755);

const t3Home = process.env.T3CODE_HOME
  ? path.resolve(process.env.T3CODE_HOME)
  : path.join(os.homedir(), ".t3");
const settingsPath = path.join(t3Home, "userdata", "settings.json");
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

let settings = {};
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, "utf8").trim();
  if (raw) {
    try {
      settings = JSON.parse(raw);
    } catch (error) {
      console.error(`refusing to overwrite invalid JSON in ${settingsPath}`);
      console.error(error.message);
      process.exit(1);
    }
  }
}

settings.providerInstances = {
  ...(settings.providerInstances || {}),
  foremanMock: {
    driver: "acpRegistry",
    displayName: "Foreman Mock ACP",
    enabled: true,
    config: {
      source: "local",
      enabled: true,
      agentId: "",
      commandPath: agentPath,
      commandArgs: [],
      distribution: "auto",
      customModels: [],
    },
  },
};

fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
  mode: 0o600,
});
fs.chmodSync(settingsPath, 0o600);

console.log(`registered provider "foremanMock" in ${settingsPath}`);
console.log(`executable: ${agentPath}`);
console.log("");
console.log("restart the T3 server, then run:");
console.log(
  "  FOREMAN_ADAPTER=t3 FOREMAN_T3_PROVIDER=foremanMock FOREMAN_T3_MODEL=default \\",
);
console.log("  foreman up --no-worktree");
console.log("");
console.log(
  "or use a real provider (codex, claudeAgent, or any ACP registry agent) in FOREMAN_T3_PROVIDER/MODEL.",
);
