#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeEffort } from "../src/model-policy.mjs";
import { reasoningPlanForTarget } from "../src/model-catalog.mjs";
import {
  leaderConfigOptions,
  normalizeLeaderOverride,
  parseLeaderChoice,
} from "../src/leader-options.mjs";

// ACP provider that turns a T3 thread into a chat surface for the Foreman
// control plane. It does not execute tasks itself; it forwards prompts to
// POST /api/ask, where the configured Foreman leader decides and dispatches.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const sessions = new Map();
let buffer = "";

function readConfig() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(ROOT, "foreman.config.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

const config = readConfig();
const port = Number(process.env.FOREMAN_PORT || config.port || 3777);
const configuredHost = String(config.host || "127.0.0.1");
const host =
  configuredHost === "0.0.0.0" || configuredHost === "::"
    ? "127.0.0.1"
    : configuredHost;
const controlUrl = String(
  process.env.FOREMAN_CONTROL_URL || `http://${host}:${port}`,
).replace(/\/+$/, "");
const mcpEndpoint = process.env.T3_ACP_MCP_ENDPOINT || null;
const mcpAuthorization = process.env.T3_ACP_MCP_AUTHORIZATION || null;
const t3ThreadId = process.env.T3CODE_THREAD_ID || null;
let mcpSessionId = null;
let mcpInitPromise = null;
let mcpSequence = 1;

function readToken() {
  if (process.env.FOREMAN_TOKEN) return process.env.FOREMAN_TOKEN;
  const dataDir = path.resolve(ROOT, config.dataDir || ".foreman");
  for (const file of [
    process.env.FOREMAN_TOKEN_FILE,
    path.join(dataDir, "access-token"),
  ].filter(Boolean)) {
    try {
      const token = fs.readFileSync(file, "utf8").trim();
      if (token) return token;
    } catch {
      // try next
    }
  }
  return null;
}

const token = readToken();
const initialLeader = leaderConfigOptions(config).current;

function debug(direction, message) {
  if (!process.env.FOREMAN_ACP_DEBUG) return;
  try {
    fs.appendFileSync(
      process.env.FOREMAN_ACP_DEBUG,
      `${JSON.stringify({ at: new Date().toISOString(), direction, message })}\n`,
    );
  } catch {
    // debug logging must never break ACP
  }
}

function leaderOptions(session) {
  const result = leaderConfigOptions(config, session?.leader || initialLeader);
  session.leader = result.current;
  return result;
}

function sendConfigUpdate(sessionId, session) {
  const { configOptions } = leaderOptions(session);
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions,
      },
    },
  });
  return configOptions;
}

function applyModelSelection(session, value) {
  const options = leaderOptions(session);
  const parsed = parseLeaderChoice(value, options.options);
  if (!parsed?.model) return false;
  session.leader = normalizeLeaderOverride(
    {
      ...session.leader,
      ...parsed,
      provider: parsed.provider || session.leader.provider,
    },
    config,
    options.options,
  );
  return true;
}

function applyEffortSelection(session, value) {
  const effort = normalizeEffort(value);
  if (!effort) return false;
  session.leader = normalizeLeaderOverride(
    { ...session.leader, effort },
    config,
  );
  return true;
}

function sessionLeader(session, selectedModel = null) {
  if (selectedModel) applyModelSelection(session, selectedModel);
  return leaderOptions(session).current;
}

function send(message) {
  debug("out", message);
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

function stripToolPreamble(text) {
  return text.replace(
    /^\[T3 Code: this message came through T3 Code's tools, not from the user typing in this chat\.\]\s*/,
    "",
  );
}

function userRequestOf(text) {
  const messageAt = text.lastIndexOf("\n\nUser message:\n");
  if (messageAt !== -1) {
    let request = text.slice(messageAt + "\n\nUser message:\n".length);
    const close = request.indexOf("</user_request>");
    if (close !== -1) request = request.slice(0, close);
    request = request.trim();
    if (request) return request;
  }
  const open = text.lastIndexOf("<user_request>");
  const close = text.lastIndexOf("</user_request>");
  if (open !== -1 && close > open) {
    const request = text.slice(open + "<user_request>".length, close).trim();
    if (request) return request;
  }
  return text;
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

function mcpHeaders(sessionId = null) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (mcpAuthorization) {
    headers.authorization = /^Bearer\s/i.test(mcpAuthorization)
      ? mcpAuthorization
      : `Bearer ${mcpAuthorization}`;
  }
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return headers;
}

async function mcpPost(payload, sessionId = null) {
  if (!mcpEndpoint) throw new Error("T3 MCP endpoint is not available");
  const response = await fetch(mcpEndpoint, {
    method: "POST",
    headers: mcpHeaders(sessionId),
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return {
    response,
    data,
    sessionId: response.headers.get("mcp-session-id") || sessionId,
  };
}

async function ensureMcpSession() {
  if (!mcpEndpoint) throw new Error("T3 MCP endpoint is not available");
  if (mcpSessionId) return mcpSessionId;
  if (mcpInitPromise) return mcpInitPromise;
  mcpInitPromise = (async () => {
    const initialized = await mcpPost({
      jsonrpc: "2.0",
      id: mcpSequence++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "foreman", version: "0.1.0" },
      },
    });
    if (!initialized.response.ok || initialized.data.error) {
      throw new Error(
        initialized.data.error?.message ||
          `T3 MCP initialize failed (${initialized.response.status})`,
      );
    }
    mcpSessionId = initialized.sessionId;
    await mcpPost(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      mcpSessionId,
    );
    return mcpSessionId;
  })();
  try {
    return await mcpInitPromise;
  } finally {
    mcpInitPromise = null;
  }
}

async function callT3Tool(name, args) {
  const sessionId = await ensureMcpSession();
  const called = await mcpPost(
    {
      jsonrpc: "2.0",
      id: mcpSequence++,
      method: "tools/call",
      params: { name, arguments: args },
    },
    sessionId,
  );
  if (!called.response.ok) {
    mcpSessionId = null;
    throw new Error(`T3 MCP ${name} failed (${called.response.status})`);
  }
  if (called.data.error) {
    throw new Error(called.data.error.message || `T3 MCP ${name} failed`);
  }
  const result = called.data.result || {};
  const text = result.content?.find?.((item) => item.type === "text")?.text;
  if (result.isError) {
    let detail = text || "T3 tool failed";
    try {
      const parsed = JSON.parse(detail);
      detail = parsed.message || detail;
    } catch {
      // keep text
    }
    throw new Error(detail);
  }
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function controlGet(pathname) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${controlUrl}${pathname}`, { headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) throw new Error(data.error || `Foreman returned ${response.status}`);
  return data;
}

async function storedLeader() {
  if (!t3ThreadId) return null;
  try {
    const data = await controlGet(
      `/api/master/fc?threadId=${encodeURIComponent(t3ThreadId)}`,
    );
    return data?.fc || null;
  } catch {
    return null;
  }
}

async function controlPost(pathname, body) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${controlUrl}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    throw new Error(data.error || `Foreman returned ${response.status}`);
  }
  return data;
}

function webThreadLink(link) {
  if (!link) return null;
  if (/^https?:/i.test(link)) return link;
  if (link.startsWith("t3-thread://")) {
    try {
      const url = new URL(link);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "v2" && parts.length >= 3) {
        const projectId = parts[1];
        const threadId = decodeURIComponent(parts.slice(2).join("/"));
        return `https://app.t3.codes/threads/${projectId}/${encodeURIComponent(threadId)}`;
      }
    } catch {
      // fall through
    }
  }
  return link;
}

function canonicalProjectPath(value) {
  const resolved = path.resolve(String(value || ROOT));
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

async function delegatePendingTasks(applied, session) {
  const pending = (Array.isArray(applied) ? applied : []).filter(
    (entry) => entry?.type === "add_task" && entry.pending && entry.task,
  );
  if (!pending.length) return [];
  const sessionProject = canonicalProjectPath(session?.cwd || ROOT);
  const results = [];
  for (const entry of pending) {
    const task = entry.task;
    const taskProject = canonicalProjectPath(task.projectPath || sessionProject);
    if (!mcpEndpoint || taskProject !== sessionProject) {
      // T3 only lets a local delegate inherit the parent's project. A different
      // project cannot have native lineage without a linked environment, so
      // preserve the working top-level dispatch path instead.
      try {
        const {
          id: _pendingId,
          projectId: _projectId,
          provider: _provider,
          reasoningOption: _reasoningOption,
          ...fallbackTask
        } = task;
        const fallback = await controlPost("/api/tasks", {
          ...fallbackTask,
          projectPath: task.projectPath,
        });
        results.push({
          taskId: fallback.task?.id,
          link: fallback.task?.thread_link || null,
          fallback: true,
          reason:
            taskProject === sessionProject
              ? "T3 delegation unavailable"
              : "task project differs from master checkout",
        });
      } catch (error) {
        results.push({ taskId: task.id, error: error.message });
      }
      continue;
    }
    try {
      const target = {
        providerInstanceId:
          task.provider || config.t3Provider || "dim",
      };
      if (task.model) target.model = task.model;
      if (task.effort && task.effort !== "auto") {
        const reasoning = reasoningPlanForTarget(
          config,
          {
            provider: target.providerInstanceId,
            model: task.model,
            effort: task.effort,
          },
          task.reasoningOption || config.t3ReasoningOption,
        );
        if (reasoning.optionId && reasoning.value) {
          target.options = [{ id: reasoning.optionId, value: reasoning.value }];
        }
      }
      let taskText = String(task.brief || task.title || "");
      if (
        task.completionToken &&
        !taskText.includes(String(task.completionToken))
      ) {
        taskText += `\n\n完成后最后单独一行输出：${task.completionToken}`;
      }
      const child = await callT3Tool("delegate_task", {
        task: taskText,
        title: task.title,
        target,
        mode: "async",
      });
      if (!child?.childThreadId) {
        throw new Error("T3 delegate_task did not return a child thread");
      }
      const messageLink = child.link || null;
      const webLink = webThreadLink(child.link);
      const imported = await controlPost("/api/tasks/import", {
        task,
        threadId: child.childThreadId,
        threadLink: webLink,
        childRunId: child.childRunId || null,
      });
      results.push({
        taskId: imported.task?.id || task.id,
        link: webLink,
        messageLink,
        fallback: false,
      });
    } catch (error) {
      // Delegation failed before a child was confirmed; do not lose the work.
      try {
        const {
          id: _pendingId,
          projectId: _projectId,
          provider: _provider,
          reasoningOption: _reasoningOption,
          ...fallbackTask
        } = task;
        const fallback = await controlPost("/api/tasks", {
          ...fallbackTask,
          projectPath: task.projectPath,
        });
        results.push({
          taskId: fallback.task?.id,
          link: fallback.task?.thread_link || null,
          fallback: true,
          reason: error.message,
        });
      } catch (fallbackError) {
        results.push({
          taskId: task.id,
          error: `${error.message}; fallback failed: ${fallbackError.message}`,
        });
      }
    }
  }
  return results;
}

async function askForeman(
  message,
  { delegateTasks = false, leader = null, masterProject = null } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 130000);
  try {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${controlUrl}/api/ask`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message,
        delegateTasks,
        leader,
        masterProject,
        masterThreadId: t3ThreadId || null,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (!response.ok) {
      throw new Error(data.error || `Foreman returned ${response.status}`);
    }
    const applied = Array.isArray(data.applied) ? data.applied : [];
    let out = String(data.reply || "").trim();
    if (data.fallback) {
      out = `⚠️ FC 调用失败，已回退到规则汇报。\n\n${out}`;
    }
    const completedActions = applied.filter((entry) => !entry?.pending);
    if (completedActions.length && process.env.FOREMAN_ACP_SHOW_ACTIONS === "1") {
      out += `\n\n动作：${JSON.stringify(completedActions)}`;
    }
    return {
      reply: out || "(Foreman 没有返回内容)",
      applied,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function handle(message) {
  const { id, method, params } = message;
  if (!method) return;
  debug("in", message);

  if (method === "initialize") {
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { resume: {} },
      },
      agentInfo: {
        name: "foreman",
        title: "Foreman (control plane)",
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
    const stored = await storedLeader();
    const session = {
      cwd: params?.cwd || ROOT,
      createdAt: Date.now(),
      leader: stored
        ? normalizeLeaderOverride(stored, config)
        : { ...initialLeader },
    };
    sessions.set(sessionId, session);
    const selected =
      params?._meta?.selectedModel ||
      params?.model ||
      params?.config?.model ||
      null;
    if (selected) sessionLeader(session, selected);
    const { configOptions, models } = leaderOptions(session);
    reply(id, { sessionId, configOptions, models });
    return;
  }

  if (method === "session/load") {
    const sessionId = params?.sessionId || `sess_${crypto.randomUUID()}`;
    const stored = await storedLeader();
    const session = {
      cwd: params?.cwd || ROOT,
      createdAt: Date.now(),
      leader: stored
        ? normalizeLeaderOverride(stored, config)
        : { ...initialLeader },
    };
    sessions.set(sessionId, session);
    const selected = params?._meta?.selectedModel || null;
    if (selected) sessionLeader(session, selected);
    const { configOptions, models } = leaderOptions(session);
    reply(id, { configOptions, models });
    return;
  }

  if (method === "session/resume") {
    const sessionId = params?.sessionId || `sess_${crypto.randomUUID()}`;
    const stored = await storedLeader();
    const session = {
      cwd: params?.cwd || ROOT,
      createdAt: Date.now(),
      leader: stored
        ? normalizeLeaderOverride(stored, config)
        : { ...initialLeader },
    };
    sessions.set(sessionId, session);
    const selected = params?._meta?.selectedModel || null;
    if (selected) sessionLeader(session, selected);
    const { configOptions, models } = leaderOptions(session);
    reply(id, { configOptions, models });
    return;
  }

  if (method === "session/set_config_option" || method === "session/set_model") {
    const sessionId = params?.sessionId;
    const session = sessions.get(sessionId);
    if (!session) {
      fail(id, -32602, `unknown session: ${sessionId}`);
      return;
    }
    let changed = false;
    if (method === "session/set_model") {
      changed = applyModelSelection(session, params?.modelId || params?.model);
    } else if (params?.configId === "model") {
      changed = applyModelSelection(session, params?.value);
    } else if (params?.configId === "effort") {
      changed = applyEffortSelection(session, params?.value);
    } else if (params?.configId === "mode") {
      changed = true;
    }
    if (!changed) {
      fail(id, -32602, "unsupported or invalid FC configuration");
      return;
    }
    const { configOptions } = leaderOptions(session);
    sendConfigUpdate(sessionId, session);
    reply(id, { configOptions });
    return;
  }

  if (method === "session/prompt") {
    const sessionId = params?.sessionId;
    const session = sessions.get(sessionId);
    if (!session) {
      fail(id, -32602, `unknown session: ${sessionId}`);
      return;
    }
    const text = textOf(params?.prompt).trim();
    if (!text) {
      promptUpdate(sessionId, "（空消息）");
      reply(id, { stopReason: "end_turn" });
      return;
    }
    const notifyPattern =
      /^\[T3 Code: this message came through T3 Code's tools, not from the user typing in this chat\.\]\s*📣 Foreman：/;
    const request = stripToolPreamble(userRequestOf(text)).trim();
    if (notifyPattern.test(text) || request.startsWith("📣 Foreman：")) {
      reply(id, { stopReason: "end_turn" });
      return;
    }
    try {
      const currentLeader = leaderOptions(session).current;
      const result = await askForeman(request, {
        delegateTasks: Boolean(mcpEndpoint),
        masterProject: session?.cwd || null,
        leader: {
          provider: currentLeader.provider,
          model: currentLeader.model,
          effort: currentLeader.effort,
        },
      });
      const delegated = await delegatePendingTasks(result.applied, session);
      let answer = result.reply;
      const links = delegated.filter((entry) => entry.link);
      if (links.length) {
        answer += `\n\n子任务线程：\n${links
          .map(
            (entry) =>
              `- ${entry.fallback ? "（回退到顶层）" : ""}${entry.messageLink || entry.link}`,
          )
          .join("\n")}`;
      }
      const fallbacks = delegated.filter((entry) => entry.fallback);
      if (fallbacks.length) {
        answer += "\n\n（主控与任务项目不同，已回退到顶层 worker；原生 lineage 需要同项目的 Foreman 主控。）";
      }
      const errors = delegated.filter((entry) => entry.error);
      if (errors.length) {
        answer += `\n\n派发问题：${errors
          .map((entry) => `${entry.taskId || "task"}: ${entry.error}`)
          .join("；")}`;
      }
      promptUpdate(sessionId, answer);
      reply(id, { stopReason: "end_turn" });
    } catch (error) {
      promptUpdate(
        sessionId,
        `Foreman 请求失败：${error.message}\n控制面：${controlUrl}`,
      );
      reply(id, { stopReason: "end_turn" });
    }
    return;
  }

  if (method === "session/cancel") {
    if (id !== undefined) reply(id, {});
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
        process.stderr.write(`foreman-acp: ${error.stack || error.message}\n`);
      });
    } catch (error) {
      process.stderr.write(`foreman-acp: bad JSON: ${error.message}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
