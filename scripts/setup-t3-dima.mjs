#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Registers the Rust DimAgent alpha (`dima`) as a T3 ACP provider. The TUI and
// the ACP gateway share the same harness; T3 launches `dima acp`, not the TUI.

const configured = process.env.DIMA_BIN ? String(process.env.DIMA_BIN) : null;
const found = configured || which("dima");
if (!found) {
  console.error("dima not found. Install it with: npm install -g dimcode-alpha@alpha");
  process.exit(1);
}
const dimaBin = path.resolve(found);
if (!fs.existsSync(dimaBin)) {
  console.error(`dima binary not found: ${dimaBin}`);
  process.exit(1);
}

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
  dima: {
    driver: "acpRegistry",
    displayName: "DimAgent Rust (dima)",
    enabled: true,
    config: {
      source: "local",
      enabled: true,
      agentId: "",
      commandPath: dimaBin,
      commandArgs: ["acp"],
      distribution: "auto",
      // The Rust alpha may expose only a default placeholder model. These
      // explicit models are forwarded to the provider and are also used by
      // Foreman's dima leader/worker paths. Keep the effort choices aligned
      // with the provider's real reasoning levels.
      customModels: [
        {
          slug: "deepseek-v4.1-flash",
          name: "DeepSeek V4.1 Flash",
          capabilities: {
            optionDescriptors: [
              {
                id: "mode",
                label: "Permission mode",
                type: "select",
                currentValue: "workspace-write",
                options: [
                  { id: "read-only", label: "read-only" },
                  { id: "workspace-write", label: "workspace-write" },
                  { id: "full-access", label: "full-access" },
                ],
              },
              {
                id: "effort",
                label: "Reasoning effort",
                type: "select",
                currentValue: "high",
                role: "reasoning",
                options: [
                  { id: "none", label: "none" },
                  { id: "high", label: "high" },
                  { id: "max", label: "max" },
                ],
              },
            ],
          },
        },
      ],
    },
  },
};

fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
  mode: 0o600,
});
fs.chmodSync(settingsPath, 0o600);

console.log(`registered provider "dima" in ${settingsPath}`);
console.log(`executable: ${dimaBin} acp`);
console.log("");
console.log("1. Restart T3 so the provider list reloads.");
console.log("2. In T3, choose provider: DimAgent Rust (dima).");
console.log("3. Check or refresh its model catalog:");
console.log("   dima models <provider> --refresh");
console.log("4. In Foreman config, set t3Provider=dima, the model slugs, and t3ReasoningOption.");
console.log("");
console.log("The TUI (`dima`) and ACP mode (`dima acp`) use the same harness.");
console.log("If writes are refused, check permission in ~/.dimcode-alpha/config.json.");

function which(command) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
