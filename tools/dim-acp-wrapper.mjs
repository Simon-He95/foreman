#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";

// ACP proxy for DimAgent. T3 starts Dim ACP sessions as read-only because T3's
// ACP client does not set Dim's `permission` config option. This wrapper lets
// the `session/new` response through only after switching the session to
// workspace-write (or full-access). Everything else is a transparent proxy.

const dimBin =
  process.env.FOREMAN_DIM_BIN ||
  (fs.existsSync("/Applications/DimAgent.app/Contents/Resources/runtime/cli/dim")
    ? "/Applications/DimAgent.app/Contents/Resources/runtime/cli/dim"
    : "dim");
const permission = process.env.FOREMAN_DIM_PERMISSION || "workspace-write";

const child = spawn(dimBin, ["acp"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

let t3Buffer = "";
let dimBuffer = "";
let internalSeq = 1;
const t3Pending = new Map();
const internalPending = new Map();

function sendToDim(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function sendToT3(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function setPermission(sessionId) {
  return new Promise((resolve) => {
    const id = `foreman:permission:${internalSeq++}`;
    const timer = setTimeout(() => {
      if (internalPending.delete(id)) {
        process.stderr.write(
          `foreman dim wrapper: permission switch timed out (${permission})\n`,
        );
        resolve(null);
      }
    }, 8000);
    timer.unref?.();
    internalPending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) {
        process.stderr.write(
          `foreman dim wrapper: permission switch failed: ${message.error.message}\n`,
        );
      }
      resolve(message);
    });
    sendToDim({
      jsonrpc: "2.0",
      id,
      method: "session/set_config_option",
      params: {
        sessionId,
        configId: "permission",
        type: "select",
        value: permission,
      },
    });
  });
}

function applyPermissionToResult(result) {
  if (!result || !Array.isArray(result.configOptions)) return result;
  for (const option of result.configOptions) {
    if (option.id === "permission") option.currentValue = permission;
  }
  return result;
}

async function handleDimLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id !== undefined && internalPending.has(message.id)) {
    const resolve = internalPending.get(message.id);
    internalPending.delete(message.id);
    resolve(message);
    return;
  }

  if (message.id !== undefined && t3Pending.has(message.id)) {
    const method = t3Pending.get(message.id);
    t3Pending.delete(message.id);
    if (method === "session/new" && message.result?.sessionId) {
      await setPermission(message.result.sessionId);
      applyPermissionToResult(message.result);
      sendToT3(message);
      return;
    }
  }

  sendToT3(message);
}

function handleT3Line(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && message.method) {
    t3Pending.set(message.id, message.method);
  }
  sendToDim(message);
}

function consume(chunk, target) {
  let buffer = target === "t3" ? t3Buffer : dimBuffer;
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    if (target === "t3") handleT3Line(line);
    else handleDimLine(line).catch((error) => {
      process.stderr.write(`foreman dim wrapper: ${error.message}\n`);
    });
  }
  if (target === "t3") t3Buffer = buffer;
  else dimBuffer = buffer;
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => consume(chunk, "t3"));
process.stdin.on("end", () => child.stdin.end());

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => consume(chunk, "dim"));
child.on("close", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  process.stderr.write(`foreman dim wrapper: ${error.message}\n`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  });
}
