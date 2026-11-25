#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readlinePromises from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createAdapter, createAdapterRegistry } from "./adapters/index.mjs";
import { accessUrls, hashToken, isLoopbackHost } from "./auth.mjs";
import { loadConfig, publicConfig } from "./config.mjs";
import { Daemon } from "./daemon.mjs";
import {
  addProject,
  addTask,
  backupDb,
  compactDb,
  counts,
  dashboardTasks,
  getProject,
  getMeta,
  getTask,
  openDb,
  recentChat,
  revokeWorkerToken,
  SCHEMA_VERSION,
  schemaVersion,
  setMeta,
  setWorkerStatus,
  setWorkerToken,
  updateProject,
  upsertWorker,
} from "./db.mjs";
import { Leader, LeaderLoop } from "./leader.mjs";
import { modelCatalog, planTaskModel, reasoningOptionFor } from "./model-policy.mjs";
import { notifyMaster } from "./notifier.mjs";
import { validateArtifactPath } from "./projects.mjs";
import {
  ensureDefaultProject,
  listProjectSummaries,
  projectSummary,
  resolveTaskProject,
} from "./registry.mjs";
import { startServer } from "./server.mjs";
import { buildStateCard, contractLabel, ruleReply } from "./state.mjs";
import { WorkerRunner } from "./worker-runner.mjs";
import { workerSnapshot } from "./worker-broker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}

function overridesFromFlags(flags) {
  const overrides = {};
  const map = {
    adapter: "adapter",
    concurrency: "concurrency",
    "data-dir": "dataDir",
    leader: "leaderMode",
    "leader-model": "leaderModel",
    "codex-bin": "codexBin",
    "codex-model": "codexModel",
    "dim-bin": "dimBin",
    project: "projectPath",
    "t3-project": "t3Project",
    "t3-bin": "t3Bin",
    "t3-provider": "t3Provider",
    "t3-model": "t3Model",
    "model-fast": "modelFast",
    "model-strong": "modelStrong",
    "model-coding": "modelCoding",
    "t3-reasoning-option": "t3ReasoningOption",
    "t3-worktree-base": "t3WorktreeBase",
    port: "port",
    host: "host",
    token: "authToken",
    "allowed-roots": "allowedProjectRoots",
    "allow-insecure": "allowInsecure",
    execution: "executionMode",
    "worker-id": "workerId",
    "worker-capacity": "workerCapacity",
    "worker-projects": "workerProjects",
    "worker-project-map": "workerProjectMap",
    "worker-token": "workerToken",
    "worker-token-file": "workerTokenFile",
    "worker-poll-ms": "workerPollMs",
    control: "controlUrl",
    goal: "goal",
    "leader-tick": "leaderTickMs",
    "tick-ms": "tickMs",
  };
  for (const [flag, key] of Object.entries(map)) {
    if (flags[flag] !== undefined) overrides[key] = flags[flag];
  }
  if (flags["no-worktree"]) overrides.t3Worktree = false;
  return overrides;
}

function open(options = {}) {
  const config = loadConfig(options);
  const db = openDb(config.dbPath);
  ensureDefaultProject(db, config);
  return { config, db };
}

function close(db) {
  try {
    db.close();
  } catch {
    // ignore
  }
}

function readPid(config) {
  try {
    return Number(fs.readFileSync(config.pidPath, "utf8").trim()) || null;
  } catch {
    return null;
  }
}

function removePid(config) {
  try {
    fs.unlinkSync(config.pidPath);
  } catch {
    // ignore
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquirePid(config) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(config.pidPath, `${process.pid}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = readPid(config);
      if (pid && pid !== process.pid && pidAlive(pid)) {
        throw new Error(
          `foreman is already running (pid ${pid}); stop it before starting another control plane`,
        );
      }
      try {
        fs.unlinkSync(config.pidPath);
      } catch {
        // retry once
      }
    }
  }
  throw new Error(`cannot acquire ${config.pidPath}`);
}

function makeLogger(prefix = "") {
  const stamp = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
  return {
    info: (...args) => console.log(`${stamp()} ${prefix}`, ...args),
    warn: (...args) => console.warn(`${stamp()} ${prefix}`, ...args),
    error: (...args) => console.error(`${stamp()} ${prefix}`, ...args),
  };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function printTask(task) {
  console.log(`${task.id}  ${task.status.padEnd(9)}  ${task.title}`);
  console.log(`  adapter=${task.adapter} project=${task.project_path}`);
  if (task.model || task.effort) {
    console.log(
      `  model=${task.model || "(default)"} effort=${task.effort || "(default)"}`,
    );
  }
  if (task.thread_id) console.log(`  thread=${task.thread_id}`);
  if (task.result) console.log(`  result=${task.result}`);
  if (task.error) console.log(`  error=${task.error}`);
  const contract = contractLabel(task);
  if (contract) console.log(`  contract=${contract}`);
}

function configPathFor(cwd) {
  return path.join(cwd, "foreman.config.json");
}

function displayPath(cwd, target) {
  const rel = path.relative(cwd, target);
  return rel && !rel.startsWith("..") ? `./${rel}` : target;
}

async function commandInit(flags) {
  const cwd = path.resolve(flags.cwd ? String(flags.cwd) : process.cwd());
  const interactive =
    !flags.yes &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true;
  const rl = interactive
    ? readlinePromises.createInterface({
        input: process.stdin,
        output: process.stdout,
      })
    : null;
  const ask = async (label, fallback) => {
    if (!rl) return fallback;
    const suffix = fallback === "" ? "" : ` [${fallback}]`;
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer || fallback;
  };
  const askYesNo = async (label, fallback = false) => {
    if (!rl) return fallback;
    const suffix = fallback ? " [Y/n]" : " [y/N]";
    const answer = (await rl.question(`${label}${suffix}: `))
      .trim()
      .toLowerCase();
    if (!answer) return fallback;
    return answer === "y" || answer === "yes";
  };

  try {
    const defaultProject = path.resolve(
      cwd,
      String(flags.project || "."),
    );
    const projectPath = path.resolve(
      cwd,
      await ask("Project directory", defaultProject),
    );
    const mode = String(
      flags.demo
        ? "mock"
        : flags.adapter ||
            (await ask("Adapter (mock=trial, t3=real workers)", "mock")),
    ).toLowerCase();
    if (!["mock", "t3"].includes(mode)) {
      throw new Error(`unknown adapter: ${mode}`);
    }
    const provider =
      mode === "t3"
        ? String(
            flags.provider ||
              (await ask("T3 provider (dim/dima/codex/claude)", "dim")),
          )
        : null;
    const model =
      mode === "t3"
        ? String(
            flags.model ||
              (await ask("Worker model", "dimcode-api-oauth/deepseek-v4.1-flash")),
          )
        : null;
    const leaderMode =
      mode === "t3"
        ? String(flags.leader || (await ask("Leader (rule/dim/codex/claude)", "dim")))
        : "rule";
    const leaderModel =
      mode === "t3" && leaderMode !== "rule"
        ? String(
            flags["leader-model"] ||
              (await ask(
                "Leader model (optional; e.g. gpt-6.2-astra for dim)",
                leaderMode === "dim" ? "gpt-6.2-astra" : "",
              )),
          ).trim() || null
        : null;
    const leaderEffort =
      mode === "t3" && leaderMode !== "rule"
        ? String(
            flags["leader-effort"] ||
              (await ask(
                "Leader effort (auto|none|high|max)",
                "high",
              )),
          ).trim() || null
        : null;
    const dataDir = path.resolve(
      cwd,
      String(flags["data-dir"] || (await ask("Data directory", ".foreman"))),
    );
    const port = Number(
      flags.port || (await ask("Dashboard port", "3777")),
    );
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`invalid port: ${port}`);
    }
    const output = configPathFor(cwd);
    if (fs.existsSync(output) && !flags.force) {
      throw new Error(
        `${output} already exists; re-run with --force to overwrite`,
      );
    }

    const modelFast =
      mode === "t3" ? model : null;
    const modelStrong =
      mode === "t3"
        ? provider === "dim"
          ? "dimcode-api-oauth/gpt-6.2-astra"
          : model
        : null;
    const modelCoding =
      mode === "t3"
        ? provider === "dim"
          ? "dimcode-api-oauth/claude-opus-5-5"
          : model
        : null;
    const config = {
      dataDir: displayPath(cwd, dataDir),
      adapter: mode,
      executionMode: String(flags.execution || "local"),
      projectPath: displayPath(cwd, projectPath),
      t3Project: mode === "t3" ? displayPath(cwd, projectPath) : null,
      t3Provider: mode === "t3" ? provider : null,
      t3Model: mode === "t3" ? model : null,
      modelFast,
      modelStrong,
      modelCoding,
      forceModel: flags["force-model"] ? String(flags["force-model"]).trim() : null,
      forceProvider: flags["force-provider"] ? String(flags["force-provider"]).trim() : null,
      t3ReasoningOption: mode === "t3" ? (provider === "dim" ? "thought_level" : "effort") : null,
      t3Worktree: false,
      concurrency: Number(flags.concurrency || 2),
      leaderMode,
      leaderModel,
      leaderEffort,
      leaderTickMs: 3000,
      port,
      allowedProjectRoots: [
        ...new Set([
          displayPath(cwd, cwd),
          displayPath(cwd, projectPath),
        ]),
      ],
      goal: "Dispatch pending work reliably and report exactly what is running, queued, blocked, and done.",
    };
    fs.writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(`wrote ${output}`);
    console.log(`  adapter   ${mode}`);
    console.log(`  project   ${projectPath}`);
    console.log(`  data      ${dataDir}`);
    console.log(
      `  leader    ${leaderMode}${leaderModel ? ` / ${leaderModel}` : ""}${leaderEffort ? ` / effort ${leaderEffort}` : ""}`,
    );
    if (mode === "t3") {
      console.log(`  provider  ${provider}`);
      console.log(`  model     ${model}`);
      const registerScript = path.resolve(__dirname, "..", "scripts", "setup-t3-foreman.mjs");
      const register = Boolean(
        flags.register ||
          (rl &&
            (await askYesNo("Register the Foreman provider in T3 now?", true))),
      );
      if (register && fs.existsSync(registerScript)) {
        const result = spawnSync(process.execPath, [registerScript], {
          cwd,
          stdio: "inherit",
        });
        if (result.status !== 0) {
          throw new Error("T3 provider registration failed; run npm run t3:register-foreman");
        }
      } else {
        console.log("  next      re-run with --register (source checkout: npm run t3:register-foreman), then restart T3");
      }
    }
    if (mode === "mock") {
      console.log("");
      console.log("Trial mode needs no model. Run:");
      console.log("  foreman demo --duration 20");
      console.log("  foreman up");
    }
    console.log("");
    console.log("Next:");
    console.log("  1. foreman doctor");
    console.log("  2. foreman up");
    if (mode === "t3") {
      console.log('  3. foreman master create --title "Foreman"');
      console.log("  4. open the printed T3 thread and ask for a task");
    } else {
      console.log('  3. foreman add "hello" --brief "reply OK" --adapter mock');
    }
  } finally {
    rl?.close();
  }
}

async function commandAdd(flags, positional) {
  const title = positional.join(" ").trim();
  if (!title) {
    console.error("usage: foreman add <title> [--brief text] [--priority 50] [--adapter mock|t3] [--project name|path] [--model slug] [--effort auto|none|high|max] [--done-token DONE] [--artifact path] [--artifact-contains text] [--require-diff]");
    process.exitCode = 2;
    return;
  }
  const { config, db } = open(overridesFromFlags(flags));
  const projectFlag = flags.project ? String(flags.project) : null;
  const byName = projectFlag && getProject(db, projectFlag) ? projectFlag : null;
  const resolved = resolveTaskProject(db, config, {
    project: byName,
    projectPath: byName ? null : projectFlag,
  });
  const projectPath = resolved.projectPath;
  const adapter = String(flags.adapter || resolved.adapter || config.adapter);
  createAdapter(adapter, config); // fail fast on an unknown adapter
  const brief = String(flags.brief || title);
  const plan = planTaskModel(config, {
    title,
    brief,
    adapter,
    model: flags.model,
    effort: flags.effort || flags["thought-level"] || flags.thinking,
  });
  const task = addTask(db, {
    title,
    brief,
    priority: Number(flags.priority) || 50,
    adapter,
    projectPath,
    projectId: resolved.project?.id ?? null,
    permissionMode: flags.permission || null,
    provider: config.forceProvider || flags.provider || null,
    model: plan.model,
    effort: plan.effort,
    maxAttempts: Number(flags["max-attempts"]) || config.maxAttempts,
    completionToken: flags["done-token"]
      ? String(flags["done-token"]).trim()
      : null,
    artifactPath: validateArtifactPath(
      projectPath,
      flags.artifact ? String(flags.artifact).trim() : null,
    ),
    artifactContains: flags["artifact-contains"]
      ? String(flags["artifact-contains"])
      : null,
    requireDiff: Boolean(flags["require-diff"]),
  });
  printTask(task);
  close(db);
}

async function commandModels(flags) {
  const { config, db } = open(overridesFromFlags(flags));
  try {
    const catalog = modelCatalog(config);
    const payload = {
      leader: {
        mode: config.leaderMode,
        model: config.leaderModel || null,
        effort: config.leaderEffort || null,
      },
      provider: config.t3Provider || null,
      reasoningOption: config.t3ReasoningOption || null,
      reasoningOptions: {
        dim: reasoningOptionFor("dim"),
        dima: reasoningOptionFor("dima"),
        codex: reasoningOptionFor("codex"),
        claudeAgent: reasoningOptionFor("claudeAgent"),
      },
      forceProvider: config.forceProvider || null,
      forceModel: config.forceModel || null,
      fast: catalog.fast,
      strong: catalog.strong,
      coding: catalog.coding,
      note: "Explicit config; upstream T3 model changes require a config update and restart.",
    };
    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(
      `leader            ${payload.leader.mode}${payload.leader.model ? ` / ${payload.leader.model}` : ""}${payload.leader.effort ? ` / effort ${payload.leader.effort}` : ""}`,
    );
    console.log(`provider          ${payload.provider || "(not set)"}`);
    console.log(`force             ${payload.forceProvider || "-"} / ${payload.forceModel || "-"}`);
    console.log(
      `reasoning option  ${payload.reasoningOption || "(not set)"} (fallback; dim/dima/codex/claude auto)`,
    );
    console.log(`fast              ${payload.fast || "(provider default)"}`);
    console.log(`strong            ${payload.strong || "(provider default)"}`);
    console.log(`coding            ${payload.coding || "(provider default)"}`);
    console.log("");
    console.log("source: foreman.config.json / environment; not auto-refreshed from T3");
  } finally {
    close(db);
  }
}

async function commandStatus(flags) {
  const { config, db } = open(overridesFromFlags(flags));
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          config: publicConfig(config),
          projects: listProjectSummaries(db, config),
          counts: counts(db),
          tasks: dashboardTasks(db, { terminalLimit: 200 }),
          chat: recentChat(db, 20),
        },
        null,
        2,
      ),
    );
    close(db);
    return;
  }
  const pid = readPid(config);
  console.log(
    `foreman  ${pidAlive(pid) ? `running (pid ${pid})` : "not running"}  db=${config.dbPath}`,
  );
  console.log("");
  console.log(buildStateCard(db, config));
  close(db);
}

function printProject(project, config) {
  const summary = projectSummary(project, config);
  console.log(
    `${project.id}  ${project.name.padEnd(16)}  ${summary.path}  ${project.default_adapter || "-"}  ${Number(project.enabled) ? "enabled" : "disabled"}`,
  );
}

async function commandProject(flags, positional) {
  const action = positional[0] || "list";
  const { config, db } = open(overridesFromFlags(flags));
  try {
    if (action === "list") {
      const projects = listProjectSummaries(db, config);
      if (projects.length === 0) {
        console.log("no projects");
      }
      for (const project of projects) {
        console.log(
          `${project.id}  ${project.name.padEnd(16)}  ${project.path}  ${project.adapter || "-"}  ${project.enabled ? "enabled" : "disabled"}`,
        );
      }
      return;
    }

    const name = positional[1];
    if (!name) throw new Error("usage: foreman project add|set|enable|disable <name>");
    if (action === "add") {
      const raw = flags.path || positional[2];
      if (!raw) throw new Error("usage: foreman project add <name> --path <dir> [--adapter mock|t3]");
      const localPath = path.resolve(config.cwd, String(raw));
      if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) {
        throw new Error(`project path is not a directory: ${localPath}`);
      }
      if (flags.adapter && !["mock", "t3"].includes(flags.adapter)) {
        throw new Error(`unknown adapter: ${flags.adapter}`);
      }
      const project = addProject(db, {
        name,
        path: localPath,
        adapter: flags.adapter || null,
      });
      printProject(project, config);
      return;
    }

    if (action === "set") {
      const patch = {};
      if (flags.path) {
        const localPath = path.resolve(config.cwd, String(flags.path));
        if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) {
          throw new Error(`project path is not a directory: ${localPath}`);
        }
        patch.local_path = localPath;
      }
      if (flags.adapter) {
        if (!["mock", "t3"].includes(flags.adapter)) {
          throw new Error(`unknown adapter: ${flags.adapter}`);
        }
        patch.default_adapter = flags.adapter;
      }
      const project = updateProject(db, name, patch);
      if (!project) throw new Error(`project not found: ${name}`);
      printProject(project, config);
      return;
    }

    if (action === "enable" || action === "disable") {
      const project = updateProject(db, name, { enabled: action === "enable" });
      if (!project) throw new Error(`project not found: ${name}`);
      printProject(project, config);
      return;
    }

    throw new Error(`unknown project action: ${action}`);
  } finally {
    close(db);
  }
}

async function commandAsk(flags, positional) {
  const message = positional.join(" ").trim() || "现在什么情况？";
  const { config, db } = open(overridesFromFlags(flags));
  const adapters = createAdapterRegistry(config);
  const daemon = new Daemon({
    db,
    config,
    adapters,
    logger: makeLogger("[ask]"),
  });
  const leader = new Leader({
    db,
    config,
    daemon,
    logger: makeLogger("[leader]"),
  });
  const result = await leader.turn({ message, trigger: "user" });
  console.log(result.reply);
  if (result.applied?.length) {
    console.log("");
    console.log("actions:", JSON.stringify(result.applied));
  }
  if (result.fallback) {
    console.log(
      `\n(note: ${config.leaderMode} failed, used rule fallback)`,
    );
  }
  close(db);
}

async function commandUp(flags) {
  const { config, db } = open(overridesFromFlags(flags));
  const logger = makeLogger("[foreman]");
  const adapters = createAdapterRegistry(config);
  const daemon = new Daemon({ db, config, adapters, logger });
  const leader = new Leader({ db, config, daemon, logger });
  const leaderLoop = new LeaderLoop({
    leader,
    db,
    config,
    logger,
  });

  acquirePid(config);
  let server = null;
  try {
    if (!flags["no-server"]) {
      server = await startServer({
        db,
        config,
        daemon,
        leader,
        logger,
      });
    }

    await daemon.start();
    if (flags["no-leader-loop"]) {
      logger.info("[leader] loop disabled");
    } else {
      leaderLoop.start();
    }
    logger.info(`[foreman] data=${config.dbPath}`);
    logger.info(`[foreman] adapter=${config.adapter} leader=${config.leaderMode}`);
    if (config.executionMode === "worker") {
      logger.info(
        `[foreman] execution=worker; start a worker: foreman worker --control http://127.0.0.1:${config.port}`,
      );
    }
    if (server) {
      for (const url of accessUrls(config)) {
        logger.info(`[foreman] dashboard ${url}`);
      }
      if (config.authToken) {
        logger.info(
          `[foreman] access token: ${config.authTokenPath} (append #token=<token> to the URL once)`,
        );
      }
    }
    logger.info(`[foreman] pid ${process.pid}; Ctrl-C to stop (workers keep running)`);
  } catch (error) {
    removePid(config);
    close(db);
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[foreman] ${signal}, shutting down control plane`);
    leaderLoop.stop();
    await daemon.stop();
    if (server) await server.close();
    removePid(config);
    close(db);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
}

async function commandDaemon(flags) {
  const { config, db } = open(overridesFromFlags(flags));
  const logger = makeLogger("[daemon]");
  const adapters = createAdapterRegistry(config);
  const daemon = new Daemon({ db, config, adapters, logger });
  acquirePid(config);
  try {
    await daemon.start();
  } catch (error) {
    removePid(config);
    close(db);
    throw error;
  }
  logger.info(`[daemon] data=${config.dbPath} adapter=${config.adapter}`);
  const shutdown = async (signal) => {
    logger.info(`[daemon] ${signal}, stopping loop (workers keep running)`);
    await daemon.stop();
    removePid(config);
    close(db);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function commandMaster(flags, positional = []) {
  const action = positional[0] || "show";
  const { config, db } = open(overridesFromFlags(flags));
  try {
    if (action === "show") {
      const threadId = getMeta(db, "master_thread_id");
      console.log(threadId ? `master thread: ${threadId}` : "master thread: (not set)");
      return;
    }
    if (action === "set") {
      const threadId = positional[1] || flags.thread;
      if (!threadId) throw new Error("usage: foreman master set <thread-id>");
      setMeta(db, "master_thread_id", String(threadId));
      console.log(`master thread set: ${threadId}`);
      return;
    }
    if (action === "clear") {
      setMeta(db, "master_thread_id", "");
      console.log("master thread cleared");
      return;
    }
    if (action === "test") {
      const ok = notifyMaster(
        db,
        config,
        "🔔 Foreman 通知测试：如果你看到这条，主控线程推送已接通。",
      );
      console.log(ok ? "notification queued" : "master thread is not set");
      return;
    }
    if (action === "create") {
      const project = flags.project || config.projectPath;
      const message = flags.message || "现在什么情况？";
      const title = flags.title || "Foreman 主控";
      const result = spawnSync(
        config.t3Bin,
        [
          "thread",
          "start",
          String(project),
          String(message),
          "--title",
          String(title),
          "--provider",
          String(flags.provider || "foreman"),
          "--model",
          String(flags.model || "default"),
          "--wait",
          "--json",
        ],
        {
          cwd: config.cwd,
          encoding: "utf8",
          timeout: 130000,
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `t3 thread start failed: ${(result.stderr || result.stdout || "").trim().slice(0, 500)}`,
        );
      }
      const line = String(result.stdout)
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .pop();
      const data = JSON.parse(line);
      if (!data.threadId) throw new Error("t3 did not return a threadId");
      setMeta(db, "master_thread_id", data.threadId);
      console.log(`master thread created: ${data.threadId}`);
      return;
    }
    throw new Error(`unknown master action: ${action}`);
  } finally {
    close(db);
  }
}

async function commandWorker(flags, positional = []) {
  const action = positional[0];
  if (["enroll", "list", "revoke", "drain", "resume", "service"].includes(action)) {
    return commandWorkerAdmin(flags, positional);
  }
  const config = loadConfig(overridesFromFlags(flags));
  const logger = makeLogger("[worker]");
  const runner = new WorkerRunner({ config, logger });
  await runner.start();
  logger.info(
    `[worker] id=${config.workerId} control=${config.controlUrl} capacity=${config.workerCapacity}`,
  );
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[worker] ${signal}, stopping worker loop`);
    await runner.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
}

function workerTokenPath(config, id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_.-]/g, "-");
  return path.join(config.dataDir, `worker-token-${safe}`);
}

function writeTokenFile(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
  return file;
}

async function commandWorkerAdmin(flags, positional) {
  const action = positional[0];
  const { config, db } = open(overridesFromFlags(flags));
  try {
    if (action === "list") {
      const workers = workerSnapshot(db);
      if (!workers.length) console.log("no workers");
      for (const worker of workers) {
        console.log(
          `${worker.id}  ${worker.status.padEnd(8)}  ${worker.running}/${worker.capacity}  projects=${(worker.projects || []).join(",") || "-"}  token=${worker.tokenHint || "-"}  last=${worker.last_heartbeat_at ? `${Math.round((Date.now() - worker.last_heartbeat_at) / 1000)}s` : "-"}`,
        );
      }
      return;
    }

    const id =
      positional[1] ||
      (flags["worker-id"] ? String(flags["worker-id"]) : null) ||
      config.workerId;
    if (!id) throw new Error(`usage: foreman worker ${action} <worker-id>`);

    if (action === "enroll") {
      const projects = String(flags["worker-projects"] || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const capacity = Math.max(1, Number(flags["worker-capacity"]) || 1);
      const worker = upsertWorker(db, {
        id,
        name: id,
        capacity,
        projects: projects.length ? projects : null,
        status: "offline",
      });
      const token = crypto.randomBytes(32).toString("base64url");
      setWorkerToken(db, id, {
        hash: hashToken(token),
        hint: token.slice(-6),
      });
      const tokenFile = writeTokenFile(
        flags["token-file"]
          ? path.resolve(config.cwd, String(flags["token-file"]))
          : workerTokenPath(config, id),
        token,
      );
      console.log(`worker ${worker.id} enrolled`);
      console.log(`token: ${token}`);
      console.log(`token file: ${tokenFile}`);
      console.log("store this token now; it is only printed once");
      return;
    }

    if (action === "drain" || action === "resume") {
      const worker = setWorkerStatus(
        db,
        id,
        action === "drain" ? "draining" : "online",
      );
      if (!worker) throw new Error(`worker not found: ${id}`);
      console.log(`worker ${id} ${worker.status}`);
      return;
    }

    if (action === "revoke") {
      const worker = revokeWorkerToken(db, id);
      if (!worker) throw new Error(`worker not found: ${id}`);
      try {
        fs.rmSync(
          flags["token-file"]
            ? path.resolve(config.cwd, String(flags["token-file"]))
            : workerTokenPath(config, id),
          { force: true },
        );
      } catch {
        // best effort
      }
      console.log(`worker ${id} token revoked`);
      return;
    }

    if (action === "service") {
      const worker = workerSnapshot(db).find((item) => item.id === id);
      const safe = id.replace(/[^a-zA-Z0-9_.-]/g, "-");
      const tokenFile = flags["worker-token-file"]
        ? path.resolve(config.cwd, String(flags["worker-token-file"]))
        : workerTokenPath(config, id);
      const node = process.execPath;
      const cli = path.join(__dirname, "cli.mjs");
      const projectMap = Object.entries(config.workerProjectMap || {})
        .map(([key, value]) => `${key}=${value}`)
        .join(",");
      const env = {
        FOREMAN_DATA_DIR: config.dataDir,
        FOREMAN_CONTROL_URL: config.controlUrl,
        FOREMAN_WORKER_ID: id,
        FOREMAN_WORKER_CAPACITY: String(
          worker?.capacity || config.workerCapacity || 1,
        ),
        FOREMAN_WORKER_PROJECTS: (worker?.projects || config.workerProjects || []).join(","),
        FOREMAN_WORKER_PROJECT_MAP: projectMap,
        FOREMAN_WORKER_TOKEN_FILE: tokenFile,
        FOREMAN_WORKER_POLL_MS: String(config.workerPollMs),
        FOREMAN_ADAPTER: config.adapter,
        FOREMAN_T3_BIN: config.t3Bin,
        FOREMAN_T3_PROJECT: config.t3Project,
        FOREMAN_T3_WORKTREE: String(config.t3Worktree),
        FOREMAN_T3_PROVIDER: config.t3Provider || "",
        FOREMAN_T3_MODEL: config.t3Model || "",
        FOREMAN_T3_LEASE_MS: String(config.t3LeaseMs),
        PATH: process.env.PATH || "",
      };
      const envXml = Object.entries(env)
        .filter(([, value]) => value !== "")
        .map(
          ([key, value]) =>
            `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`,
        )
        .join("\n");
      const logPath = path.join(config.dataDir, `worker-${safe}.log`);
      console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.foreman.worker.${xmlEscape(safe)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(cli)}</string>
    <string>worker</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(config.cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>`);
      console.error(
        `# install:\n#   foreman worker service ${id} > ~/Library/LaunchAgents/com.foreman.worker.${safe}.plist\n#   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.foreman.worker.${safe}.plist 2>/dev/null\n#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.foreman.worker.${safe}.plist\n#   token file: ${tokenFile}\n#   log: ${logPath}`,
      );
      return;
    }
  } finally {
    close(db);
  }
}

async function waitForSettled(db, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const c = counts(db);
    if (c.running === 0 && c.queued === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function commandDemo(flags) {
  const duration = Number(flags.duration) || 25;
  if (flags["data-dir"] && !flags.yes) {
    console.error("refusing to wipe a custom --data-dir without --yes");
    process.exitCode = 2;
    return;
  }
  const dataDir =
    flags["data-dir"] || path.join(process.cwd(), ".foreman-demo");
  fs.rmSync(dataDir, { recursive: true, force: true });
  const { config, db } = open({
    ...overridesFromFlags(flags),
    dataDir,
    adapter: "mock",
    leaderMode: "rule",
    leaderTickMs: 500,
    tickMs: 300,
    concurrency: Number(flags.concurrency) || 3,
    port: 0,
  });
  const logger = makeLogger("[demo]");
  const adapters = createAdapterRegistry(config);
  const daemon = new Daemon({ db, config, adapters, logger });
  const leader = new Leader({ db, config, daemon, logger });
  const leaderLoop = new LeaderLoop({ leader, db, config, logger });

  const tasks = [
    ["整理登录页的失败用例", "duration=1200ms 把 flaky 用例归类并给出根因"],
    ["修复 CI 的缓存失效", "duration=2200ms 定位缓存 key 变化并修复"],
    ["补一页 API 变更说明", "duration=3200ms 从 diff 生成变更说明"],
  ];
  for (const [title, brief] of tasks) {
    addTask(db, {
      title,
      brief,
      adapter: "mock",
      projectPath: config.projectPath,
      priority: 50,
      maxAttempts: config.maxAttempts,
    });
  }

  await daemon.start();
  leaderLoop.start();
  const settled = await waitForSettled(db, duration * 1000);
  await new Promise((resolve) => setTimeout(resolve, 800));
  leaderLoop.stop();
  await daemon.stop();

  console.log("");
  console.log(buildStateCard(db, config));
  console.log("");
  console.log("— leader 自动汇报 —");
  const chat = recentChat(db, 10);
  const auto = chat.filter((message) => message.role === "leader");
  console.log(auto.length ? auto[auto.length - 1].content : "(no leader briefing)");
  console.log("");
  console.log("— 问 leader：现在什么情况？ —");
  console.log(ruleReply(db, config));

  const c = counts(db);
  console.log("");
  console.log(
    `result: ${settled ? "SETTLED" : "TIMEOUT"} total=${c.total} done=${c.done} failed=${c.failed} running=${c.running} queued=${c.queued}`,
  );
  console.log(`data: ${config.dbPath}`);
  close(db);
  if (!settled) process.exitCode = 1;
}

async function commandDoctor(flags) {
  const { config, db } = open(overridesFromFlags(flags));
  const logger = makeLogger("[doctor]");
  const adapters = createAdapterRegistry(config);
  const checks = [];
  checks.push(["node", process.version, true]);
  checks.push(["node:sqlite", "available", true]);
  checks.push([
    "db schema",
    `${schemaVersion(db)} (expected ${SCHEMA_VERSION})`,
    schemaVersion(db) === SCHEMA_VERSION,
  ]);
  checks.push([
    "t3 bin",
    config.t3Bin,
    config.t3Bin !== "t3" && fs.existsSync(config.t3Bin),
  ]);
  checks.push([
    "claude bin",
    config.claudeBin,
    config.claudeBin !== "claude" && fs.existsSync(config.claudeBin),
  ]);

  const claudeAuth = spawnSync(config.claudeBin, ["auth", "status"], {
    encoding: "utf8",
    timeout: 15000,
  });
  checks.push([
    "claude auth",
    (claudeAuth.stdout || claudeAuth.stderr || "").trim().slice(0, 180) ||
      "no output",
    claudeAuth.status === 0,
  ]);

  checks.push([
    "codex bin",
    config.codexBin,
    config.codexBin !== "codex" && fs.existsSync(config.codexBin),
  ]);
  const codexLogin = spawnSync(config.codexBin, ["login", "status"], {
    encoding: "utf8",
    timeout: 15000,
  });
  checks.push([
    "codex login",
    (codexLogin.stdout || codexLogin.stderr || "").trim().slice(0, 180) ||
      "no output",
    codexLogin.status === 0,
  ]);

  checks.push([
    "dim bin",
    config.dimBin,
    config.dimBin !== "dim" && fs.existsSync(config.dimBin),
  ]);
  const dimVersion = spawnSync(config.dimBin, ["version"], {
    encoding: "utf8",
    timeout: 15000,
  });
  checks.push([
    "dim version",
    (dimVersion.stdout || dimVersion.stderr || "").trim().slice(0, 180) ||
      "no output",
    dimVersion.status === 0,
  ]);

  const t3 = adapters.t3;
  const t3Health = await t3.health();
  checks.push(["t3 server", t3Health.detail, t3Health.ok]);

  const portFree = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(config.port, config.host, () => {
      probe.close(() => resolve(true));
    });
  });
  checks.push([
    "dashboard port",
    `${config.host}:${config.port} ${portFree ? "free" : "in use"}`,
    portFree || pidAlive(readPid(config)),
  ]);

  const tokenFile = fs.existsSync(config.authTokenPath);
  const authReady =
    isLoopbackHost(config.host) ||
    Boolean(config.authToken) ||
    tokenFile ||
    config.allowInsecure;
  checks.push([
    "dashboard auth",
    isLoopbackHost(config.host)
      ? "loopback (token optional)"
      : config.authToken
        ? "token configured"
        : tokenFile
          ? `token file ${config.authTokenPath}`
          : config.allowInsecure
            ? "INSECURE (explicit)"
            : "missing token",
    authReady,
  ]);

  checks.push(["database", config.dbPath, fs.existsSync(config.dbPath)]);
  checks.push(["goal", config.goal, true]);

  let ok = true;
  for (const [name, detail, pass] of checks) {
    if (!pass) ok = false;
    console.log(`${pass ? "OK  " : "FAIL"}  ${name.padEnd(16)} ${detail}`);
  }
  console.log("");
  console.log("config:", JSON.stringify(publicConfig(config), null, 2));
  close(db);
  if (!ok) process.exitCode = 1;
}

async function commandBackup(flags) {
  const { config, db } = open(overridesFromFlags(flags));
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target =
      flags.out ||
      path.join(config.dataDir, "backups", `foreman-${stamp}.db`);
    const out = backupDb(db, target);
    console.log(`backup ${out}`);
  } finally {
    close(db);
  }
}

async function commandCompact(flags) {
  const { config, db } = open(overridesFromFlags(flags));
  try {
    const result = compactDb(db, {
      keepEvents: flags["keep-events"],
      keepChat: flags["keep-chat"],
      consumedInboxDays: flags["consumed-days"],
    });
    console.log(
      `compacted ${config.dbPath}: events-${result.events} chat-${result.chat} inbox-${result.inbox}`,
    );
  } finally {
    close(db);
  }
}

async function commandReset(flags) {
  if (!flags.yes) {
    console.error("refusing to reset without --yes");
    process.exitCode = 2;
    return;
  }
  const { config, db } = open(overridesFromFlags(flags));
  const pid = readPid(config);
  if (pidAlive(pid)) {
    close(db);
    throw new Error(`foreman is running (pid ${pid}); stop it before reset`);
  }
  close(db);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(config.dbPath + suffix);
    } catch {
      // ignore
    }
  }
  console.log(`removed ${config.dbPath}`);
}

async function commandService(flags) {
  const { config, db } = open(overridesFromFlags(flags));
  close(db);
  const node = process.execPath;
  const cli = path.join(__dirname, "cli.mjs");
  const env = {
    FOREMAN_DATA_DIR: config.dataDir,
    FOREMAN_PROJECT: config.projectPath,
    FOREMAN_ADAPTER: config.adapter,
    FOREMAN_EXECUTION_MODE: config.executionMode,
    FOREMAN_WORKER_ID: config.workerId,
    FOREMAN_WORKER_CAPACITY: String(config.workerCapacity),
    FOREMAN_CONTROL_URL: config.controlUrl,
    FOREMAN_LEADER: config.leaderMode,
    FOREMAN_CONCURRENCY: String(config.concurrency),
    FOREMAN_T3_BIN: config.t3Bin,
    FOREMAN_T3_PROJECT: config.t3Project,
    FOREMAN_T3_WORKTREE: String(config.t3Worktree),
    FOREMAN_CODEX_BIN: config.codexBin,
    FOREMAN_CODEX_MODEL: config.codexModel,
    FOREMAN_DIM_BIN: config.dimBin,
    FOREMAN_CLAUDE_BIN: config.claudeBin,
    FOREMAN_PORT: String(config.port),
    FOREMAN_HOST: config.host,
    FOREMAN_ALLOWED_ROOTS: config.allowedProjectRoots.join(","),
    FOREMAN_ALLOW_INSECURE: String(config.allowInsecure),
    PATH: process.env.PATH || "",
  };
  if (config.authToken) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(config.authTokenPath, `${config.authToken}\n`, {
      mode: 0o600,
    });
    try {
      fs.chmodSync(config.authTokenPath, 0o600);
    } catch {
      // best effort
    }
  }
  if (config.leaderModel) env.FOREMAN_LEADER_MODEL = config.leaderModel;
  if (config.t3Provider) env.FOREMAN_T3_PROVIDER = config.t3Provider;
  if (config.t3Model) env.FOREMAN_T3_MODEL = config.t3Model;
  const envXml = Object.entries(env)
    .map(
      ([key, value]) =>
        `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.foreman.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(cli)}</string>
    <string>up</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(config.cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(config.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(config.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
  console.log(plist);
  console.error(
    `# install:\n#   foreman service > ~/Library/LaunchAgents/com.foreman.agent.plist\n#   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.foreman.agent.plist 2>/dev/null\n#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.foreman.agent.plist\n#   log: ${config.logPath}`,
  );
}

function usage() {
  console.log(`foreman — a durable leader for agent fleets

usage:
  foreman init [--yes] [--project path] [--adapter mock|t3] [--provider dim] [--model slug] [--leader dim] [--leader-model slug] [--leader-effort auto|none|high|max] [--force-model slug] [--force-provider id] [--data-dir .foreman] [--port 3777] [--register] [--force]
  foreman add <title> --brief "..." [--priority 50] [--adapter mock|t3] [--project name|path]
                [--provider id] [--model slug] [--effort auto|none|high|max]
                [--done-token DONE] [--artifact path] [--artifact-contains text] [--require-diff]
  foreman project list
  foreman project add <name> --path <dir> [--adapter mock|t3]
  foreman project set <name> [--path <dir>] [--adapter mock|t3]
  foreman project enable|disable <name>
  foreman up [--port 3777] [--host 127.0.0.1] [--token secret] [--allowed-roots .] [--execution local|worker] [--adapter mock|t3] [--leader rule|claude|codex|dim] [--concurrency 3]
  foreman daemon [--host 127.0.0.1] [--token secret] [--allowed-roots .]
  foreman master create [--project path] [--title "Foreman 主控"]
  foreman master show|set <thread-id>|test|clear
  foreman worker [--control http://127.0.0.1:3777] [--worker-id local-1] [--worker-capacity 1] [--worker-projects web,api] [--worker-project-map web=/srv/web] [--worker-token token|--worker-token-file path] [--token dashboard-token]
  foreman worker enroll <id> [--worker-capacity 1] [--worker-projects web,api] [--token-file path]
  foreman worker list
  foreman worker drain|resume <id>
  foreman worker revoke <id>
  foreman worker service <id> [--control http://127.0.0.1:3777] [--worker-token-file path]
  foreman status [--json]
  foreman models [--json]
  foreman ask "现在什么情况？"
  foreman demo [--duration 25]
  foreman doctor
  foreman backup [--out path]
  foreman compact [--keep-events 20000] [--keep-chat 2000] [--consumed-days 7]
  foreman reset --yes
  foreman service > ~/Library/LaunchAgents/com.foreman.agent.plist

env:
  FOREMAN_DATA_DIR, FOREMAN_PROJECT, FOREMAN_ADAPTER, FOREMAN_LEADER,
  FOREMAN_CONCURRENCY, FOREMAN_TICK_MS, FOREMAN_LEADER_TICK_MS,
  FOREMAN_RETRY_DELAY_MS, FOREMAN_LEADER_AUTO_DESTRUCTIVE,
  FOREMAN_CODEX_BIN, FOREMAN_CODEX_MODEL, FOREMAN_DIM_BIN,
  FOREMAN_T3_PROVIDER, FOREMAN_T3_MODEL, FOREMAN_T3_BIN,
  FOREMAN_T3_PROJECT, FOREMAN_PORT, FOREMAN_HOST, FOREMAN_GOAL,
  FOREMAN_TOKEN, FOREMAN_ALLOWED_ROOTS, FOREMAN_ALLOW_INSECURE,
  FOREMAN_EXECUTION_MODE, FOREMAN_WORKER_ID, FOREMAN_WORKER_CAPACITY,
  FOREMAN_WORKER_PROJECTS, FOREMAN_WORKER_PROJECT_MAP, FOREMAN_WORKER_TOKEN,
  FOREMAN_WORKER_TOKEN_FILE, FOREMAN_CONTROL_URL
`);
}

const [command = "up", ...rest] = process.argv.slice(2);
const { flags, positional } = parseFlags(rest);

try {
  switch (command) {
    case "init":
      await commandInit(flags);
      break;
    case "add":
      await commandAdd(flags, positional);
      break;
    case "project":
      await commandProject(flags, positional);
      break;
    case "up":
      await commandUp(flags);
      break;
    case "daemon":
      await commandDaemon(flags);
      break;
    case "master":
      await commandMaster(flags, positional);
      break;
    case "worker":
      await commandWorker(flags, positional);
      break;
    case "status":
      await commandStatus(flags);
      break;
    case "models":
      await commandModels(flags);
      break;
    case "ask":
      await commandAsk(flags, positional);
      break;
    case "demo":
      await commandDemo(flags);
      break;
    case "doctor":
      await commandDoctor(flags);
      break;
    case "backup":
      await commandBackup(flags);
      break;
    case "compact":
      await commandCompact(flags);
      break;
    case "reset":
      await commandReset(flags);
      break;
    case "service":
      await commandService(flags);
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      console.error(`unknown command: ${command}`);
      usage();
      process.exitCode = 2;
  }
} catch (error) {
  console.error(`foreman: ${error.message}`);
  if (process.env.FOREMAN_DEBUG) console.error(error.stack);
  process.exitCode = 1;
}
