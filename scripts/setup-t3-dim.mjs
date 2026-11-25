#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Registers DimAgent as a T3 ACP provider. The wrapper is required because T3
// does not set Dim's ACP `permission` config option; Dim would otherwise start
// every T3 session as read-only.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const localBin = path.join(repoRoot, "node_modules", ".bin");
const globalBin = path.join(os.homedir(), ".npm-global", "bin");
const wrapperPath = path.resolve(__dirname, "..", "tools", "dim-acp-wrapper.mjs");
if (!fs.existsSync(wrapperPath)) {
  console.error(`wrapper not found: ${wrapperPath}`);
  process.exit(1);
}
fs.chmodSync(wrapperPath, 0o755);

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
  dim: {
    driver: "acpRegistry",
    displayName: "DimAgent",
    enabled: true,
    config: {
      source: "local",
      enabled: true,
      agentId: "",
      commandPath: wrapperPath,
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

console.log(`registered provider "dim" in ${settingsPath}`);
console.log(`ACP wrapper: ${wrapperPath}`);
console.log("");
console.log("restart the T3 server with:");
console.log(`  export PATH="${localBin}:${globalBin}:$PATH"`);
console.log("  export FOREMAN_DIM_PERMISSION=full-access   # or workspace-write");
console.log("  t3 serve --no-browser --port 3773");
console.log("");
console.log("then, in this repo:");
console.log("  node src/cli.mjs init --adapter t3 --provider dim --leader dim");
console.log("  node src/cli.mjs up");
console.log("  # worker: dim / dimcode-api-oauth/deepseek-v4.1-flash");
console.log("  # leader: dim");
