#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// A deliberately small ACP v1 agent. It proves that Foreman can drive any
// ACP-compatible worker through T3, including one with no model behind it.

const sessions = new Map();
let buffer = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textOf(prompt) {
  if (!Array.isArray(prompt)) return String(prompt ?? "");
  return prompt
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function promptUpdate(sessionId, text) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: `msg_${crypto.randomUUID()}`,
        content: { type: "text", text },
      },
    },
  });
}

async function handle(message) {
  const { id, method, params } = message;
  if (!method) return;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
      agentInfo: {
        name: "foreman-mock",
        title: "Foreman Mock ACP",
        version: "0.1.0",
      },
      authMethods: [],
    });
    return;
  }

  if (method === "authenticate") {
    reply(id, {});
    return;
  }

  if (method === "session/new") {
    const sessionId = `sess_${crypto.randomUUID()}`;
    sessions.set(sessionId, {
      cwd: params?.cwd || process.cwd(),
      createdAt: Date.now(),
    });
    reply(id, { sessionId });
    return;
  }

  if (method === "session/load") {
    const sessionId = params?.sessionId || `sess_${crypto.randomUUID()}`;
    sessions.set(sessionId, {
      cwd: params?.cwd || process.cwd(),
      createdAt: Date.now(),
    });
    reply(id, {});
    return;
  }

  if (method === "session/prompt") {
    const sessionId = params?.sessionId;
    const session = sessions.get(sessionId);
    if (!session) {
      fail(id, -32602, `unknown session: ${sessionId}`);
      return;
    }
    const result = "FOREMAN_ACP_OK mock agent finished the turn";
    try {
      fs.mkdirSync(session.cwd, { recursive: true });
      fs.appendFileSync(
        path.join(session.cwd, "FOREMAN_ACP_DONE.md"),
        `- ${new Date().toISOString()} ${result}\n`,
      );
    } catch (error) {
      process.stderr.write(`mock-acp: artifact write failed: ${error.message}\n`);
    }
    setTimeout(() => {
      promptUpdate(sessionId, result);
      reply(id, { stopReason: "end_turn" });
    }, Number(process.env.ACP_MOCK_DELAY_MS || 400));
    return;
  }

  if (method === "session/cancel") {
    return;
  }

  if (method === "session/set_mode") {
    reply(id, {});
    return;
  }

  if (method === "session/close") {
    sessions.delete(params?.sessionId);
    reply(id, {});
    return;
  }

  if (typeof id === "number" || typeof id === "string") {
    fail(id, -32601, `method not implemented: ${method}`);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line)).catch((error) => {
        process.stderr.write(`mock-acp: ${error.stack || error.message}\n`);
      });
    } catch (error) {
      process.stderr.write(`mock-acp: bad JSON: ${error.message}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
