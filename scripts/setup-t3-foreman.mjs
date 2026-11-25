#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Registers the Foreman ACP provider in T3. A T3 thread using this provider is
// a chat surface for the Foreman leader; it does not execute tasks itself.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.resolve(__dirname, "..", "tools", "foreman-acp-agent.mjs");
if (!fs.existsSync(agentPath)) {
  console.error(`Foreman ACP agent not found: ${agentPath}`);
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
  foreman: {
    driver: "acpRegistry",
    displayName: "Foreman (control plane)",
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

console.log(`registered provider "foreman" in ${settingsPath}`);
console.log(`executable: ${agentPath}`);
console.log("");
console.log("1. Keep Foreman running: foreman up --adapter t3 --leader dim");
console.log("2. Restart the T3 server so it reloads provider instances.");
console.log("3. In T3, create a thread and choose provider: Foreman (control plane).");
console.log("4. Talk to it there; prompts go to Foreman POST /api/ask.");
console.log("");
console.log("If Foreman requires a token, set FOREMAN_TOKEN in the T3 server environment,");
console.log("or write the token to <dataDir>/access-token.");
