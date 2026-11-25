#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(__dirname, "acp-mock-agent.mjs");
const cwd = process.env.ACP_SMOKE_CWD || process.cwd();

const child = spawn(process.execPath, [agentPath], {
  cwd,
  stdio: ["pipe", "pipe", "inherit"],
});
let buffer = "";
const pending = new Map();
let nextId = 1;

function request(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return promise;
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    } else {
      console.log("notification:", JSON.stringify(message).slice(0, 400));
    }
  }
});

const timeout = setTimeout(() => {
  console.error("smoke: timed out");
  child.kill("SIGKILL");
  process.exit(1);
}, 15000);

const init = await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: {},
  clientInfo: { name: "foreman-smoke", version: "0.1.0" },
});
console.log("initialize:", JSON.stringify(init));

const session = await request("session/new", { cwd, mcpServers: [] });
console.log("session:", JSON.stringify(session));

const result = await request("session/prompt", {
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "do the mock work" }],
});
console.log("prompt:", JSON.stringify(result));

clearTimeout(timeout);
child.kill("SIGTERM");
console.log("smoke: OK");
