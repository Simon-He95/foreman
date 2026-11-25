import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAdapter, createAdapterRegistry } from "../src/adapters/index.mjs";
import { ensureAuthToken, hashToken, tokenMatches } from "../src/auth.mjs";
import { loadConfig } from "../src/config.mjs";
import { verifyContract } from "../src/contract.mjs";
import { Daemon } from "../src/daemon.mjs";
import {
  addChat,
  addProject,
  addTask,
  appendEvent,
  appendInbox,
  backupDb,
  compactDb,
  SCHEMA_VERSION,
  schemaVersion,
  consumeInbox,
  counts,
  dashboardTasks,
  getProject,
  getTask,
  importRunningTask,
  openDb,
  queuedTasks,
  recentChat,
  recentEvents,
  setMeta,
  setWorkerStatus,
  setWorkerToken,
  unconsumedInbox,
  updateTask,
  upsertWorker,
} from "../src/db.mjs";
import { Leader, LeaderLoop } from "../src/leader.mjs";
import {
  inferUserModelPreference,
  planTaskModel,
  reasoningValue,
} from "../src/model-policy.mjs";
import { notifyMaster } from "../src/notifier.mjs";
import { resolveProjectPath, validateArtifactPath } from "../src/projects.mjs";
import { ensureDefaultProject, resolveTaskProject } from "../src/registry.mjs";
import { startServer } from "../src/server.mjs";
import { buildStateCard, ruleReply } from "../src/state.mjs";
import { claimTasksForWorker, registerWorker } from "../src/worker-broker.mjs";
import { WORKER_PROTOCOL_VERSION } from "../src/protocol.mjs";
import { WorkerRunner } from "../src/worker-runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { info() {}, warn() {}, error() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foreman-test-"));
}

function testConfig(dir, overrides = {}) {
  return loadConfig({
    cwd: ROOT,
    ignoreConfigFile: true,
    dataDir: path.join(dir, "data"),
    projectPath: dir,
    adapter: "mock",
    tickMs: 50,
    leaderTickMs: 100,
    leaderMode: "rule",
    concurrency: 3,
    ...overrides,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeout = 15000, interval = 50 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`waitFor timed out; last=${last}`);
}

test("model policy chooses by difficulty and honors explicit overrides", () => {
  const config = testConfig(tempDir(), {
    t3Provider: "dim",
    t3Model: "dim/fast",
    modelStrong: "dim/strong",
    modelCoding: "dim/coding",
  });
  const light = planTaskModel(config, {
    title: "重命名一个变量",
    brief: "单文件 typo",
    adapter: "t3",
  });
  assert.equal(light.tier, "light");
  assert.equal(light.model, "dim/fast");
  assert.equal(light.effort, "none");

  const standard = planTaskModel(config, {
    title: "整理项目目录结构",
    brief: "补充目录索引",
    adapter: "t3",
  });
  assert.equal(standard.tier, "standard");
  assert.equal(standard.effort, "auto");

  const deep = planTaskModel(config, {
    title: "调研 markstream-vue 近期流量",
    brief: "分析 npm 趋势并对比 GitHub 热度",
    adapter: "t3",
  });
  assert.equal(deep.tier, "deep");
  assert.equal(deep.model, "dim/strong");
  assert.equal(deep.effort, "max");

  const simpleResearch = planTaskModel(config, {
    title: "查 markstream-vue 的 npm 下载量与反向依赖数",
    brief:
      "用 npm registry / api.npmjs.org 查下载量，并用 GitHub 代码搜索找反向依赖，输出报告。",
    adapter: "t3",
  });
  assert.equal(simpleResearch.tier, "standard");
  assert.equal(simpleResearch.model, "dim/fast");
  assert.equal(simpleResearch.effort, "auto");

  const coding = planTaskModel(config, {
    title: "修复登录页的并发 bug",
    brief: "重构相关组件并补测试",
    adapter: "t3",
  });
  assert.equal(coding.tier, "coding");
  assert.equal(coding.model, "dim/coding");
  assert.equal(coding.effort, "max");

  const explicit = planTaskModel(config, {
    title: "随便做点",
    brief: "普通任务",
    adapter: "t3",
    model: "strong",
    effort: "max",
  });
  assert.equal(explicit.model, "dim/strong");
  assert.equal(explicit.effort, "max");

  const effortOnly = planTaskModel(config, {
    title: "普通任务",
    brief: "普通任务",
    adapter: "t3",
    effort: "max",
  });
  assert.equal(effortOnly.model, "dim/strong");
  assert.equal(effortOnly.effort, "max");

  const strongest = inferUserModelPreference(
    "这次用最强模型，思考开到最大",
    config,
  );
  assert.equal(strongest.model, "dim/strong");
  assert.equal(strongest.effort, "max");

  const cheap = inferUserModelPreference("用快模型，便宜点", config);
  assert.equal(cheap.model, "dim/fast");

  const opus = inferUserModelPreference("用 Opus 认真做", config);
  assert.equal(opus.model, "dim/coding");

  assert.equal(reasoningValue("dimcode-api-oauth/gpt-6.2-astra", "max"), "xhigh");
  assert.equal(reasoningValue("dimcode-api-oauth/gpt-6.2-astra", "none"), "low");
  assert.equal(
    reasoningValue("dimcode-api-oauth/deepseek-v4.1-flash", "max"),
    "max",
  );
});

test("T3 adapter passes the task model and reasoning effort", async () => {
  const dir = tempDir();
  try {
    const out = path.join(dir, "t3-args.txt");
    const script = path.join(dir, "fake-t3.sh");
    fs.writeFileSync(
      script,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(out)}\necho '{"threadId":"mcp:model-test","thread":{"link":"https://app.t3.codes/threads/proj/mcp%3Amodel-test"}}'\n`,
      { mode: 0o755 },
    );
    const config = testConfig(dir, {
      t3Bin: script,
      t3Provider: "dim",
      t3Model: "dim/fast",
      t3ReasoningOption: "thought_level",
      t3Worktree: false,
    });
    const adapter = createAdapter("t3", config);
    const started = await adapter.start({
      project_path: dir,
      title: "模型测试",
      brief: "普通任务",
      model: "dim/strong",
      effort: "max",
      completion_token: "TASK_DONE",
    });
    assert.equal(started.threadId, "mcp:model-test");
    assert.match(started.link, /app\.t3\.codes\/threads\/proj/);
    const args = fs.readFileSync(out, "utf8").trimEnd().split("\n");
    const modelAt = args.indexOf("--model");
    assert.equal(args[modelAt + 1], "dim/strong");
    const optionAt = args.indexOf("--option");
    assert.equal(args[optionAt + 1], "thought_level=max");
    assert.match(args.join("\n"), /完成后最后单独一行输出：TASK_DONE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("small talk gets a short reply instead of a status dump", async () => {
  const dir = tempDir();
  const config = testConfig(dir, { leaderMode: "rule" });
  const db = openDb(config.dbPath);
  try {
    const leader = new Leader({ db, config, logger: quiet });
    const greeting = await leader.turn({ message: "hi", trigger: "user" });
    assert.match(greeting.reply, /在/);
    assert.doesNotMatch(greeting.reply, /running|queued|累计|失败/);
    assert.deepEqual(greeting.actions, []);
    const thanks = await leader.turn({ message: "谢谢", trigger: "user" });
    assert.equal(thanks.reply, "收到。");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("leader can defer a t3 task and import it as a running child", async () => {
  const dir = tempDir();
  const config = testConfig(dir, {
    t3Provider: "dim",
    t3Model: "dim/fast",
    leaderMode: "rule",
  });
  const db = openDb(config.dbPath);
  try {
    const leader = new Leader({ db, config, logger: quiet });
    const applied = await leader.applyActions(
      [
        {
          type: "add_task",
          title: "委派测试",
          brief: "只回复 OK",
          adapter: "t3",
          projectPath: dir,
          model: "dim/strong",
          effort: "max",
        },
      ],
      { deferAddTasks: true },
    );
    assert.equal(applied.length, 1);
    assert.equal(applied[0].pending, true);
    assert.equal(counts(db).total, 0);
    const imported = importRunningTask(db, {
      ...applied[0].task,
      threadId: "thread:delegated-task:test",
      threadLink: "https://app.t3.codes/threads/p/thread%3Adelegated-task%3Atest",
      leaseMs: 60000,
    });
    assert.equal(imported.status, "running");
    assert.equal(imported.thread_id, "thread:delegated-task:test");
    assert.equal(imported.model, "dim/strong");
    assert.equal(imported.effort, "max");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("foreman init writes a non-interactive config", () => {
  const dir = tempDir();
  try {
    execFileSync(
      process.execPath,
      [
        path.join(ROOT, "src", "cli.mjs"),
        "init",
        "--yes",
        "--project",
        ".",
        "--adapter",
        "mock",
        "--data-dir",
        "data",
        "--port",
        "3997",
      ],
      { cwd: dir, stdio: "pipe" },
    );
    const config = JSON.parse(
      fs.readFileSync(path.join(dir, "foreman.config.json"), "utf8"),
    );
    assert.equal(config.adapter, "mock");
    assert.equal(config.leaderMode, "rule");
    assert.equal(config.port, 3997);
    assert.equal(config.dataDir, "./data");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mock fleet runs end-to-end and the leader wakes on completions", async () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    for (const [title, duration] of [
      ["task-a", 150],
      ["task-b", 250],
      ["task-c", 350],
    ]) {
      addTask(db, {
        title,
        brief: `duration=${duration}ms mock work`,
        adapter: "mock",
        projectPath: dir,
        maxAttempts: 2,
      });
    }

    const adapters = createAdapterRegistry(config);
    const daemon = new Daemon({ db, config, adapters, logger: quiet });
    const leader = new Leader({ db, config, daemon, logger: quiet });
    const loop = new LeaderLoop({ leader, db, config, logger: quiet });

    await daemon.start();
    loop.start();
    await waitFor(() => {
      const c = counts(db);
      return c.running === 0 && c.queued === 0 && c.done === 3;
    });
    await waitFor(() =>
      recentChat(db, 30).some((message) => message.role === "leader"),
    );
    await waitFor(() => unconsumedInbox(db).length === 0);
    loop.stop();
    await daemon.stop();

    const c = counts(db);
    assert.equal(c.total, 3);
    assert.equal(c.done, 3);
    assert.equal(c.failed, 0);
    assert.equal(unconsumedInbox(db).length, 0);
    const leaderMessages = recentChat(db, 30).filter(
      (message) => message.role === "leader",
    );
    assert.ok(leaderMessages.length >= 1);
    assert.match(leaderMessages.at(-1).content, /3 个任务/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("kill -9 mid-run reattaches the worker thread and finishes", async () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  const task = addTask(db, {
    title: "crash-recovery",
    brief: "duration=1500ms survive a crash",
    adapter: "mock",
    projectPath: dir,
    maxAttempts: 1,
  });
  db.close();

  const env = {
    ...process.env,
    TEST_DATA_DIR: config.dataDir,
    TEST_PROJECT: dir,
  };
  const childPath = path.join(ROOT, "test", "fixtures", "daemon-child.mjs");
  let child = spawn(process.execPath, [childPath], {
    cwd: ROOT,
    env,
    stdio: "ignore",
  });

  const reader = openDb(config.dbPath);
  try {
    await waitFor(() => {
      const current = getTask(reader, task.id);
      return current.status === "running" && current.thread_id;
    });

    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const crashed = getTask(reader, task.id);
    assert.equal(crashed.status, "running");
    assert.ok(crashed.thread_id);

    child = spawn(process.execPath, [childPath], {
      cwd: ROOT,
      env,
      stdio: "ignore",
    });

    await waitFor(
      () => {
        const current = getTask(reader, task.id);
        return (
          current.status === "done" &&
          unconsumedInbox(reader).some((item) => item.kind === "task_completed")
        );
      },
      { timeout: 20000 },
    );

    const done = getTask(reader, task.id);
    assert.equal(done.status, "done");
    assert.equal(done.attempts, 1, "must reattach, not start a second attempt");
    const inbox = unconsumedInbox(reader);
    assert.ok(inbox.some((item) => item.kind === "task_completed"));
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    reader.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("expired lease with a missing thread fails after the retry budget", async () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    const task = addTask(db, {
      title: "lost-worker",
      brief: "duration=100ms",
      adapter: "mock",
      projectPath: dir,
      maxAttempts: 1,
    });
    updateTask(db, task.id, {
      status: "running",
      attempts: 1,
      thread_id: "mock_does_not_exist",
      started_at: Date.now() - 5000,
      heartbeat_at: Date.now() - 5000,
      lease_until: Date.now() - 1000,
    });

    const adapters = createAdapterRegistry(config);
    const daemon = new Daemon({ db, config, adapters, logger: quiet });
    await daemon.recoverExpired();

    const failed = getTask(db, task.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /lease expired/);
    assert.ok(
      unconsumedInbox(db).some(
        (item) => item.kind === "task_failed" && item.task_id === task.id,
      ),
    );
    assert.equal(daemon.stats.failed, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state card and rule reply reflect the ledger, not memory", async () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    const running = addTask(db, {
      title: "running-task",
      brief: "duration=5000ms",
      adapter: "mock",
      projectPath: dir,
    });
    addTask(db, {
      title: "queued-task",
      brief: "duration=100ms",
      adapter: "mock",
      projectPath: dir,
      priority: 90,
    });
    updateTask(db, running.id, {
      status: "running",
      attempts: 1,
      thread_id: "mock_running",
      started_at: Date.now() - 3000,
      heartbeat_at: Date.now() - 1000,
      lease_until: Date.now() + 30000,
    });

    const card = buildStateCard(db, config);
    assert.match(card, /TOTALS: total=2 queued=1 running=1/);
    assert.match(card, /running-task/);
    assert.match(card, /queued-task/);
    assert.match(card, /thread=mock_running/);

    const reply = ruleReply(db, config);
    assert.match(reply, /共 2 个任务/);
    assert.match(reply, /1 个在跑/);
    assert.match(reply, /1 个排队/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codex leader backend reads the final message and applies actions", async () => {
  const dir = tempDir();
  const fakeCodex = path.join(ROOT, "test", "fixtures", "fake-codex.mjs");
  fs.chmodSync(fakeCodex, 0o755);
  const config = testConfig(dir, {
    leaderMode: "codex",
    codexBin: fakeCodex,
    codexModel: "fake-model",
  });
  const db = openDb(config.dbPath);
  try {
    addTask(db, {
      title: "existing-task",
      brief: "duration=100ms",
      adapter: "mock",
      projectPath: dir,
    });
    const leader = new Leader({ db, config, logger: quiet });
    const result = await leader.turn({ message: "现在什么情况？" });
    assert.equal(result.fallback, false);
    assert.match(result.reply, /fake codex leader reply/);
    assert.equal(result.actions.length, 1);
    assert.equal(result.applied[0].ok, true);
    assert.equal(counts(db).total, 2);
    const added = db
      .prepare("SELECT * FROM tasks WHERE title = ?")
      .get("codex-added task");
    assert.ok(added);
    assert.equal(added.priority, 10);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dim leader backend runs dim exec and applies actions", async () => {
  const dir = tempDir();
  const fakeDim = path.join(ROOT, "test", "fixtures", "fake-dim.mjs");
  fs.chmodSync(fakeDim, 0o755);
  const config = testConfig(dir, {
    leaderMode: "dim",
    dimBin: fakeDim,
  });
  const db = openDb(config.dbPath);
  try {
    addTask(db, {
      title: "existing-task",
      brief: "duration=100ms",
      adapter: "mock",
      projectPath: dir,
    });
    const leader = new Leader({ db, config, logger: quiet });
    const result = await leader.turn({ message: "现在什么情况？" });
    assert.equal(result.fallback, false);
    assert.match(result.reply, /fake dim leader reply/);
    assert.equal(result.actions.length, 1);
    assert.equal(result.applied[0].ok, true);
    assert.equal(counts(db).total, 2);
    const added = db
      .prepare("SELECT * FROM tasks WHERE title = ?")
      .get("dim-added task");
    assert.ok(added);
    assert.equal(added.priority, 11);
    assert.ok(fs.existsSync(path.join(config.dataDir, "leader-workspace")));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("completion contract checks token, artifact content, and path escape", () => {
  const dir = tempDir();
  try {
    const tokenPass = verifyContract(
      { project_path: dir, completion_token: "DONE" },
      { result: "work complete\nDONE" },
    );
    assert.equal(tokenPass.ok, true);
    const tokenFail = verifyContract(
      { project_path: dir, completion_token: "DONE" },
      { result: "I couldn't finish; not replying DONE" },
    );
    assert.equal(tokenFail.ok, false);

    fs.writeFileSync(path.join(dir, "artifact.txt"), "ARTIFACT_OK");
    const artifactPass = verifyContract(
      {
        project_path: dir,
        artifact_path: "artifact.txt",
        artifact_contains: "ARTIFACT_OK",
      },
      { result: "" },
    );
    assert.equal(artifactPass.ok, true);
    const artifactFail = verifyContract(
      { project_path: dir, artifact_path: "missing.txt" },
      { result: "" },
    );
    assert.equal(artifactFail.ok, false);
    const escapeFail = verifyContract(
      { project_path: dir, artifact_path: "../escape.txt" },
      { result: "" },
    );
    assert.equal(escapeFail.ok, false);
    const markerOnly = verifyContract(
      { project_path: dir, artifact_contains: "ARTIFACT_OK" },
      { result: "" },
    );
    assert.equal(markerOnly.ok, false);

    const outside = path.join(dir, "..", `outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, "ARTIFACT_OK");
    fs.symlinkSync(outside, path.join(dir, "link.txt"));
    const symlinkFail = verifyContract(
      { project_path: dir, artifact_path: "link.txt" },
      { result: "" },
    );
    assert.equal(symlinkFail.ok, false);
    assert.match(symlinkFail.reason, /symlink/);
    fs.rmSync(outside, { force: true });

    fs.mkdirSync(path.join(dir, "subdir"));
    const directoryFail = verifyContract(
      { project_path: dir, artifact_path: "subdir" },
      { result: "" },
    );
    assert.equal(directoryFail.ok, false);
    assert.match(directoryFail.reason, /not a file/);

    fs.writeFileSync(path.join(dir, "empty.txt"), "");
    const emptyFail = verifyContract(
      { project_path: dir, artifact_path: "empty.txt" },
      { result: "" },
    );
    assert.equal(emptyFail.ok, false);
    assert.match(emptyFail.reason, /empty/);

    const repo = tempDir();
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      const cleanDiff = verifyContract(
        { project_path: repo, require_diff: 1 },
        { result: "" },
      );
      assert.equal(cleanDiff.ok, false);
      fs.writeFileSync(path.join(repo, "change.txt"), "change");
      const dirtyDiff = verifyContract(
        { project_path: repo, require_diff: 1 },
        { result: "" },
      );
      assert.equal(dirtyDiff.ok, true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact contract passes and token contract blocks a worker that ends without DONE", async () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    fs.writeFileSync(path.join(dir, "artifact.txt"), "ARTIFACT_OK");
    const passing = addTask(db, {
      title: "artifact-contract",
      brief: "duration=100ms",
      adapter: "mock",
      projectPath: dir,
      artifactPath: "artifact.txt",
      artifactContains: "ARTIFACT_OK",
    });
    const failing = addTask(db, {
      title: "token-contract",
      brief: "duration=100ms",
      adapter: "mock",
      projectPath: dir,
      completionToken: "DONE",
    });

    const daemon = new Daemon({
      db,
      config,
      adapters: createAdapterRegistry(config),
      logger: quiet,
    });
    await daemon.start();
    await waitFor(() => {
      const a = getTask(db, passing.id);
      const b = getTask(db, failing.id);
      return a.status === "done" && b.status === "blocked";
    });
    await daemon.stop();

    assert.equal(getTask(db, passing.id).status, "done");
    const blocked = getTask(db, failing.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.error, /completion contract failed/);
    assert.match(blocked.error, /DONE/);
    assert.ok(
      unconsumedInbox(db).some(
        (item) => item.kind === "needs_human" && item.task_id === failing.id,
      ),
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("non-loopback host generates a reusable 0600 access token", () => {
  const dir = tempDir();
  try {
    const config = testConfig(dir, { host: "0.0.0.0" });
    const token = ensureAuthToken(config, quiet);
    assert.ok(token && token.length >= 40);
    assert.equal(fs.statSync(config.authTokenPath).mode & 0o777, 0o600);
    assert.equal(tokenMatches(token, token), true);
    assert.equal(tokenMatches(token, "wrong"), false);

    const restarted = testConfig(dir, { host: "0.0.0.0" });
    assert.equal(ensureAuthToken(restarted, quiet), token);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("project resolver enforces directories and real-path roots", () => {
  const dir = tempDir();
  const repo = path.join(dir, "repo");
  const outside = tempDir();
  try {
    fs.mkdirSync(repo);
    const config = testConfig(dir, {
      projectPath: repo,
      allowedProjectRoots: [dir],
    });
    assert.equal(resolveProjectPath(config, repo), repo);
    assert.throws(
      () => resolveProjectPath(config, outside),
      /outside allowed roots/,
    );
    const link = path.join(dir, "escape-link");
    fs.symlinkSync(outside, link);
    assert.throws(
      () => resolveProjectPath(config, link),
      /outside allowed roots/,
    );
    assert.equal(validateArtifactPath(repo, "ok.txt"), "ok.txt");
    assert.throws(
      () => validateArtifactPath(repo, "../escape.txt"),
      /escapes the project/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("project registry resolves tasks by name and stores project_id", () => {
  const dir = tempDir();
  const other = path.join(dir, "repo");
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    fs.mkdirSync(other);
    const defaultProject = ensureDefaultProject(db, config);
    assert.equal(defaultProject.name, "default");
    const project = addProject(db, {
      name: "repo",
      path: other,
      adapter: "mock",
    });
    assert.equal(getProject(db, "repo").id, project.id);
    assert.equal(getProject(db, project.id).name, "repo");

    const resolved = resolveTaskProject(db, config, { project: "repo" });
    assert.equal(resolved.projectPath, other);
    assert.equal(resolved.adapter, "mock");

    const task = addTask(db, {
      title: "registry-task",
      brief: "x",
      adapter: resolved.adapter,
      projectPath: resolved.projectPath,
      projectId: resolved.project.id,
    });
    assert.equal(getTask(db, task.id).project_id, project.id);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("leader add_task can use a registered project name", async () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    const project = ensureDefaultProject(db, config);
    const leader = new Leader({ db, config, logger: quiet });
    const applied = await leader.applyActions([
      {
        type: "add_task",
        title: "leader-registry",
        brief: "x",
        project: "default",
      },
    ]);
    assert.equal(applied[0].ok, true);
    assert.equal(getTask(db, applied[0].taskId).project_id, project.id);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retry refuses live or unsafe blocked tasks", () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    const task = addTask(db, {
      title: "retry-guard",
      brief: "duration=100ms",
      adapter: "mock",
      projectPath: dir,
    });
    updateTask(db, task.id, { status: "running", attempts: 1 });
    assert.throws(() => retryTask(db, config, task.id), /cannot retry a running/);

    updateTask(db, task.id, {
      status: "blocked",
      thread_id: "mock_resume",
      error:
        "lease expired; cannot confirm the old worker stopped; verify thread x manually",
    });
    assert.throws(() => retryTask(db, config, task.id), /live worker/);
    const resumed = resumeTask(db, config, task.id);
    assert.equal(resumed.status, "running");
    assert.equal(resumed.thread_id, "mock_resume");
    assert.equal(resumed.error, null);

    updateTask(db, task.id, { status: "failed", error: "boom" });
    const retried = retryTask(db, config, task.id);
    assert.equal(retried.status, "queued");
    assert.equal(retried.attempts, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("expired lease with an unstoppable worker blocks instead of duplicating", async () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    let starts = 0;
    const fake = {
      name: "fake",
      leaseMs: 100,
      async start() {
        starts += 1;
        throw new Error("must not start a second worker");
      },
      async poll() {
        return { state: "running" };
      },
      async stop() {
        return { stopped: false, unsupported: true };
      },
    };
    const task = addTask(db, {
      title: "unstoppable",
      brief: "x",
      adapter: "fake",
      projectPath: dir,
    });
    updateTask(db, task.id, {
      status: "running",
      attempts: 1,
      thread_id: "fake_1",
      started_at: Date.now() - 5000,
      heartbeat_at: Date.now() - 5000,
      lease_until: Date.now() - 1000,
    });

    const daemon = new Daemon({
      db,
      config,
      adapters: { fake },
      logger: quiet,
    });
    await daemon.recoverExpired();

    const blocked = getTask(db, task.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.thread_id, "fake_1");
    assert.match(blocked.error, /cannot confirm the old worker stopped/);
    assert.equal(starts, 0);
    assert.ok(
      unconsumedInbox(db).some(
        (item) => item.kind === "needs_human" && item.task_id === task.id,
      ),
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requeued tasks respect the retry delay", async () => {
  const dir = tempDir();
  const config = testConfig(dir, { retryDelayMs: 5000 });
  const db = openDb(config.dbPath);
  try {
    const adapters = createAdapterRegistry(config);
    const task = addTask(db, {
      title: "requeue-delay",
      brief: "duration=50ms",
      adapter: "mock",
      projectPath: dir,
    });
    await adapters.mock.start(task);
    updateTask(db, task.id, {
      status: "running",
      attempts: 1,
      thread_id: `mock_${task.id}`,
      started_at: Date.now() - 5000,
      heartbeat_at: Date.now() - 5000,
      lease_until: Date.now() - 1000,
    });

    const daemon = new Daemon({ db, config, adapters, logger: quiet });
    await daemon.recoverExpired();

    const queued = getTask(db, task.id);
    assert.equal(queued.status, "queued");
    assert.ok(queued.not_before > Date.now());
    assert.equal(queuedTasks(db, 10).length, 0);
    assert.equal(queuedTasks(db, 10, queued.not_before).length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("leader turns are serialized across devices", async () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    const leader = new Leader({ db, config, logger: quiet });
    let active = 0;
    let maxActive = 0;
    leader.runTurn = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(25);
      active -= 1;
      return { reply: "ok", actions: [] };
    };
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        leader.turn({ message: `message-${index}`, recordUser: false }),
      ),
    );
    assert.equal(maxActive, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("automatic leader turns cannot cancel or retry", async () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    const task = addTask(db, {
      title: "auto-destructive",
      brief: "x",
      adapter: "mock",
      projectPath: dir,
    });
    const leader = new Leader({ db, config, logger: quiet });
    const denied = await leader.applyActions(
      [{ type: "cancel", taskId: task.id }],
      { allowDestructive: false },
    );
    assert.equal(denied[0].ok, false);
    assert.match(denied[0].error, /user-triggered/);
    assert.equal(getTask(db, task.id).status, "queued");

    const allowed = await leader.applyActions(
      [{ type: "cancel", taskId: task.id }],
      { allowDestructive: true },
    );
    assert.equal(allowed[0].ok, true);
    assert.equal(getTask(db, task.id).status, "cancelled");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP API requires a token and enforces project roots", async () => {
  const dir = tempDir();
  const outside = tempDir();
  const config = testConfig(dir, {
    port: 0,
    host: "127.0.0.1",
    authToken: "test-token-1234567890",
  });
  const db = openDb(config.dbPath);
  const server = await startServer({ db, config, daemon: null, leader: null, logger: quiet });
  const base = `http://127.0.0.1:${server.port}`;
  const auth = { authorization: `Bearer ${config.authToken}` };
  try {
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-security-policy"), /default-src/);

    const denied = await fetch(`${base}/api/state`);
    assert.equal(denied.status, 401);

    const state = await fetch(`${base}/api/state`, { headers: auth });
    assert.equal(state.status, 200);
    const etag = state.headers.get("etag");
    assert.ok(etag);
    const body = await state.json();
    assert.equal(body.auth.required, true);
    assert.ok(body.projects.some((project) => project.name === "default"));

    const cached = await fetch(`${base}/api/state`, {
      headers: { ...auth, "if-none-match": etag },
    });
    assert.equal(cached.status, 304);

    const projects = await fetch(`${base}/api/projects`, { headers: auth });
    assert.equal(projects.status, 200);
    const projectBody = await projects.json();
    assert.ok(projectBody.projects.some((project) => project.name === "default"));

    const byName = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "by-name", project: "default" }),
    });
    assert.equal(byName.status, 201);
    const byNameBody = await byName.json();
    assert.ok(byNameBody.task.project_id);

    const inside = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "inside", projectPath: dir }),
    });
    assert.equal(inside.status, 201);

    const escaped = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "outside", projectPath: outside }),
    });
    assert.equal(escaped.status, 403);

    const badType = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { ...auth, "content-type": "text/plain" },
      body: JSON.stringify({ title: "bad-type" }),
    });
    assert.equal(badType.status, 415);
  } finally {
    server.server.closeAllConnections?.();
    await server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Foreman ACP provider forwards prompts to /api/ask", async () => {
  let received = null;
  let askCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/ask") {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      askCount += 1;
      received = JSON.parse(body);
      const payload = JSON.stringify({
        ok: true,
        reply: ["FOREMAN_ACP_TEST", "FOREMAN_ACP_SECOND", "FOREMAN_ACP_THIRD"][
          askCount - 1
        ],
        applied: [],
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "tools", "foreman-acp-agent.mjs")],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        FOREMAN_CONTROL_URL: `http://127.0.0.1:${port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let buffer = "";
  const messages = [];
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ACP timeout")), 10000);
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const index = buffer.indexOf("\n");
          if (index < 0) break;
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          messages.push(message);
          if (message.id === 1) {
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "session/new",
                params: { cwd: ROOT },
              })}\n`,
            );
          }
          if (message.id === 2) {
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "session/prompt",
                params: {
                  sessionId: message.result.sessionId,
                  prompt: [{ type: "text", text: "现在什么情况？" }],
                },
              })}\n`,
            );
          }
          if (message.id === 3) {
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 4,
                method: "session/prompt",
                params: {
                  sessionId: messages.find((item) => item.id === 2).result
                    .sessionId,
                  prompt: [
                    {
                      type: "text",
                      text: "[T3 Code: this message came through T3 Code's tools, not from the user typing in this chat.]\n\n📣 Foreman：✅ 完成：ACP 通知测试",
                    },
                  ],
                },
              })}\n`,
            );
          }
          if (message.id === 4) {
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 5,
                method: "session/prompt",
                params: {
                  sessionId: messages.find((item) => item.id === 2).result
                    .sessionId,
                  prompt: [
                    {
                      type: "text",
                      text: "历史里提到 📣 Foreman：✅ 完成：旧通知，但这是用户问题，请回答。",
                    },
                  ],
                },
              })}\n`,
            );
          }
          if (message.id === 5) {
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 6,
                method: "session/prompt",
                params: {
                  sessionId: messages.find((item) => item.id === 2).result
                    .sessionId,
                  prompt: [
                    {
                      type: "text",
                      text: "<t3_code_instructions>noise</t3_code_instructions>\n\n<user_request>\nContext handoff (full_thread_summary):\n[Historical user]\n现在什么情况？\n\nUser message:\n调查一下 markstream-vue 最近的流量怎么样\n</user_request>",
                    },
                  ],
                },
              })}\n`,
            );
          }
          if (message.id === 6) {
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 7,
                method: "session/prompt",
                params: {
                  sessionId: messages.find((item) => item.id === 2).result
                    .sessionId,
                  prompt: [
                    {
                      type: "text",
                      text: "<t3_code_instructions>noise</t3_code_instructions>\n\n<user_request>\nContext handoff (full_thread_summary):\n\nUser message:\n[T3 Code: this message came through T3 Code's tools, not from the user typing in this chat.]\n\n📣 Foreman：✅ 完成：handoff 里的通知\n</user_request>",
                    },
                  ],
                },
              })}\n`,
            );
          }
          if (message.id === 7) {
            clearTimeout(timer);
            resolve(messages);
          }
        }
      });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        })}\n`,
      );
    });
    assert.equal(askCount, 3);
    assert.equal(
      result.find((message) => message.id === 1).result.agentCapabilities
        .loadSession,
      false,
    );
    assert.deepEqual(
      result.find((message) => message.id === 1).result.agentCapabilities
        .sessionCapabilities.resume,
      {},
    );
    assert.equal(received.message, "调查一下 markstream-vue 最近的流量怎么样");
    const updates = result.filter(
      (message) => message.method === "session/update",
    );
    assert.equal(updates.length, 3);
    assert.match(updates[0].params.update.content.text, /FOREMAN_ACP_TEST/);
    assert.match(updates[1].params.update.content.text, /FOREMAN_ACP_SECOND/);
    assert.match(updates[2].params.update.content.text, /FOREMAN_ACP_THIRD/);
    assert.deepEqual(result.find((message) => message.id === 3).result, {
      stopReason: "end_turn",
    });
    assert.deepEqual(result.find((message) => message.id === 4).result, {
      stopReason: "end_turn",
    });
    assert.deepEqual(result.find((message) => message.id === 5).result, {
      stopReason: "end_turn",
    });
    assert.deepEqual(result.find((message) => message.id === 6).result, {
      stopReason: "end_turn",
    });
    assert.deepEqual(result.find((message) => message.id === 7).result, {
      stopReason: "end_turn",
    });
  } finally {
    child.kill();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("notifyMaster pushes to the bound T3 master thread", async () => {
  const dir = tempDir();
  try {
    const out = path.join(dir, "t3-args.txt");
    const script = path.join(dir, "fake-t3.sh");
    fs.writeFileSync(
      script,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(out)}\n`,
      { mode: 0o755 },
    );
    const config = testConfig(dir, { t3Bin: script });
    const db = openDb(config.dbPath);
    setMeta(db, "master_thread_id", "mcp:test-master");
    const queued = notifyMaster(db, config, "✅ 完成：通知测试");
    assert.equal(queued, true);
    await waitFor(
      () =>
        fs.existsSync(out) &&
        fs.readFileSync(out, "utf8").includes("mcp:test-master"),
    );
    const args = fs.readFileSync(out, "utf8").trimEnd().split("\n");
    assert.deepEqual(args.slice(0, 3), ["thread", "send", "mcp:test-master"]);
    assert.match(args[3], /^📣 Foreman：✅ 完成：通知测试/);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("worker registration rejects incompatible protocol versions", () => {
  const dir = tempDir();
  const config = testConfig(dir, { executionMode: "worker" });
  const db = openDb(config.dbPath);
  try {
    assert.throws(
      () => registerWorker(db, { id: "old-worker", protocolVersion: 999 }),
      (error) => error.status === 426,
    );
    const worker = registerWorker(db, {
      id: "new-worker",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      capacity: 1,
    });
    assert.equal(worker.protocol_version, WORKER_PROTOCOL_VERSION);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("worker project filters only claim matching registered projects", () => {
  const dir = tempDir();
  const config = testConfig(dir, { executionMode: "worker" });
  const db = openDb(config.dbPath);
  try {
    const web = addProject(db, { name: "web", path: dir, adapter: "mock" });
    const api = addProject(db, { name: "api", path: dir, adapter: "mock" });
    registerWorker(db, {
      id: "web-worker",
      capacity: 2,
      projects: ["web"],
      protocolVersion: WORKER_PROTOCOL_VERSION,
    });
    const webTask = addTask(db, {
      title: "web-task",
      brief: "x",
      adapter: "mock",
      projectPath: dir,
      projectId: web.id,
    });
    addTask(db, {
      title: "api-task",
      brief: "x",
      adapter: "mock",
      projectPath: dir,
      projectId: api.id,
    });

    setWorkerStatus(db, "web-worker", "draining");
    assert.equal(
      claimTasksForWorker(db, config, { workerId: "web-worker", limit: 2 }).length,
      0,
    );
    setWorkerStatus(db, "web-worker", "online");

    const claimed = claimTasksForWorker(db, config, {
      workerId: "web-worker",
      limit: 2,
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, webTask.id);
    assert.ok(claimed[0].attempt_id);
    assert.equal(claimed[0].worker_id, "web-worker");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("same-host worker claims, heartbeats, and completes a task", async () => {
  const dir = tempDir();
  const workerToken = "worker-token-1234567890";
  const config = testConfig(dir, {
    port: 0,
    host: "127.0.0.1",
    authToken: "dashboard-token-1234567890",
    executionMode: "worker",
    workerId: "local-test",
    workerCapacity: 1,
    workerPollMs: 50,
  });
  const db = openDb(config.dbPath);
  upsertWorker(db, { id: "local-test", capacity: 1, status: "offline" });
  setWorkerToken(db, "local-test", {
    hash: hashToken(workerToken),
    hint: workerToken.slice(-6),
  });
  const daemon = new Daemon({
    db,
    config,
    adapters: createAdapterRegistry(config),
    logger: quiet,
  });
  let server;
  let runner;
  try {
    server = await startServer({
      db,
      config,
      daemon,
      leader: null,
      logger: quiet,
    });
    const workerConfig = {
      ...config,
      controlUrl: `http://127.0.0.1:${server.port}`,
      workerPollMs: 50,
      workerToken,
    };
    await daemon.start();
    const task = addTask(db, {
      title: "worker-task",
      brief: "duration=100ms",
      adapter: "mock",
      projectPath: dir,
    });
    runner = new WorkerRunner({ config: workerConfig, logger: quiet });
    await runner.start();
    await waitFor(() => {
      const current = getTask(db, task.id);
      return current.status === "done" ? current : null;
    });
    const done = getTask(db, task.id);
    assert.equal(done.worker_id, "local-test");
    assert.ok(done.thread_id);
    assert.match(done.result, /mock worker finished/);
    const workers = db.prepare("SELECT * FROM workers").all();
    assert.equal(workers.length, 1);
    assert.equal(workers[0].id, "local-test");

    const base = `http://127.0.0.1:${server.port}`;
    const auth = { authorization: `Bearer ${config.authToken}` };
    let action = await fetch(`${base}/api/workers/local-test/drain`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(action.status, 200);
    assert.equal((await action.json()).worker.status, "draining");
    action = await fetch(`${base}/api/workers/local-test/resume`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(action.status, 200);
    assert.equal((await action.json()).worker.status, "online");
    action = await fetch(`${base}/api/workers/local-test/revoke`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(action.status, 200);
    assert.equal((await action.json()).worker.status, "offline");
  } finally {
    if (runner) await runner.stop();
    await daemon.stop();
    if (server) {
      server.server.closeAllConnections?.();
      await server.close();
    }
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("worker restart reattaches a running assignment", async () => {
  const dir = tempDir();
  const config = testConfig(dir, {
    port: 0,
    host: "127.0.0.1",
    executionMode: "worker",
    workerId: "restart-worker",
    workerCapacity: 1,
    workerPollMs: 50,
  });
  const db = openDb(config.dbPath);
  const daemon = new Daemon({
    db,
    config,
    adapters: createAdapterRegistry(config),
    logger: quiet,
  });
  let server;
  let first;
  let second;
  try {
    server = await startServer({ db, config, daemon, leader: null, logger: quiet });
    const workerConfig = {
      ...config,
      controlUrl: `http://127.0.0.1:${server.port}`,
      workerPollMs: 50,
    };
    await daemon.start();
    const task = addTask(db, {
      title: "reattach-task",
      brief: "duration=1500ms",
      adapter: "mock",
      projectPath: dir,
    });
    first = new WorkerRunner({ config: workerConfig, logger: quiet });
    await first.start();
    await waitFor(() => {
      const current = getTask(db, task.id);
      return current.status === "running" && current.thread_id ? current : null;
    });
    await first.stop();
    first = null;

    second = new WorkerRunner({ config: workerConfig, logger: quiet });
    await second.start();
    await waitFor(() => {
      const current = getTask(db, task.id);
      return current.status === "done" ? current : null;
    });
    const done = getTask(db, task.id);
    assert.equal(done.worker_id, "restart-worker");
    assert.equal(done.attempts, 1);
    assert.match(done.result, /mock worker finished/);
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    await daemon.stop();
    if (server) {
      server.server.closeAllConnections?.();
      await server.close();
    }
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("worker contract evidence is verified on the worker path", async () => {
  const dir = tempDir();
  const workerDir = tempDir();
  const config = testConfig(dir, {
    port: 0,
    host: "127.0.0.1",
    executionMode: "worker",
    workerId: "mapped-worker",
    workerCapacity: 1,
    workerPollMs: 50,
  });
  const db = openDb(config.dbPath);
  ensureDefaultProject(db, config);
  fs.writeFileSync(path.join(workerDir, "worker-artifact.txt"), "WORKER_OK");
  const daemon = new Daemon({
    db,
    config,
    adapters: createAdapterRegistry(config),
    logger: quiet,
  });
  let server;
  let runner;
  try {
    server = await startServer({ db, config, daemon, leader: null, logger: quiet });
    const workerConfig = {
      ...config,
      controlUrl: `http://127.0.0.1:${server.port}`,
      workerPollMs: 50,
      workerProjectMap: { default: workerDir },
    };
    await daemon.start();
    const task = addTask(db, {
      title: "mapped-contract",
      brief: "duration=100ms",
      adapter: "mock",
      projectPath: dir,
      projectId: ensureDefaultProject(db, config).id,
      artifactPath: "worker-artifact.txt",
      artifactContains: "WORKER_OK",
    });
    runner = new WorkerRunner({ config: workerConfig, logger: quiet });
    await runner.start();
    await waitFor(() => {
      const current = getTask(db, task.id);
      return current.status === "done" ? current : null;
    });
    const done = getTask(db, task.id);
    assert.equal(done.status, "done");
    assert.equal(done.worker_id, "mapped-worker");
    const event = db
      .prepare("SELECT * FROM events WHERE task_id = ? AND type = 'done' ORDER BY seq DESC LIMIT 1")
      .get(task.id);
    assert.ok(event);
    assert.match(event.payload, /WORKER_OK|artifact/);
  } finally {
    if (runner) await runner.stop();
    await daemon.stop();
    if (server) {
      server.server.closeAllConnections?.();
      await server.close();
    }
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(workerDir, { recursive: true, force: true });
  }
});

test("loopback without a token rejects a non-local Host header", async () => {
  const dir = tempDir();
  const config = testConfig(dir, { port: 0, host: "127.0.0.1" });
  const db = openDb(config.dbPath);
  const server = await startServer({ db, config, daemon: null, leader: null, logger: quiet });
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/api/state",
          headers: { host: "evil.example" },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 403);
  } finally {
    server.server.closeAllConnections?.();
    await server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboardTasks keeps active tasks even when terminal history is longer", () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    const active = addTask(db, {
      title: "active-old",
      brief: "x",
      adapter: "mock",
      projectPath: dir,
    });
    db.prepare("UPDATE tasks SET created_at = 0 WHERE id = ?").run(active.id);
    for (let index = 0; index < 205; index += 1) {
      const task = addTask(db, {
        title: `done-${index}`,
        brief: "x",
        adapter: "mock",
        projectPath: dir,
      });
      updateTask(db, task.id, {
        status: "done",
        result: "ok",
        finished_at: Date.now() + index,
      });
    }
    const rows = dashboardTasks(db, { terminalLimit: 10 });
    assert.ok(rows.some((task) => task.id === active.id));
    assert.equal(rows.filter((task) => task.status === "done").length, 10);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("schema version is recorded and migrations are idempotent", () => {
  const dir = tempDir();
  const db = openDb(path.join(dir, "ledger.db"));
  try {
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const project = addProject(db, { name: "schema", path: dir });
    const task = addTask(db, {
      title: "schema survival",
      brief: "must survive a migration",
      projectId: project.id,
      projectPath: dir,
      adapter: "mock",
    });
    db.exec("PRAGMA user_version = 0");
  } finally {
    db.close();
  }
  const reopened = openDb(path.join(dir, "ledger.db"));
  try {
    assert.equal(schemaVersion(reopened), SCHEMA_VERSION);
    assert.equal(getTask(reopened, "tsk_missing"), null);
    const rows = reopened.prepare("SELECT title FROM tasks").all();
    assert.ok(rows.some((row) => row.title === "schema survival"));
  } finally {
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup and compact preserve tasks and prune history", () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    const task = addTask(db, {
      title: "keep-me",
      brief: "x",
      adapter: "mock",
      projectPath: dir,
    });
    addChat(db, "user", "hello-1");
    addChat(db, "leader", "hello-2");
    for (let index = 0; index < 8; index += 1) {
      appendEvent(db, task.id, "noise", { index });
    }
    appendInbox(db, "task_completed", task.id, { ok: true });
    consumeInbox(
      db,
      unconsumedInbox(db).map((item) => item.seq),
    );

    const compacted = compactDb(db, {
      keepEvents: 3,
      keepChat: 1,
      consumedInboxDays: 0,
    });
    assert.ok(compacted.events >= 5);
    assert.equal(recentEvents(db, 10).length, 3);
    assert.equal(recentChat(db, 10).length, 1);
    assert.equal(unconsumedInbox(db).length, 0);
    assert.equal(getTask(db, task.id).title, "keep-me");

    const backupPath = path.join(dir, "backup.db");
    backupDb(db, backupPath);
    assert.ok(fs.existsSync(backupPath));
    const restored = openDb(backupPath);
    try {
      assert.equal(getTask(restored, task.id).title, "keep-me");
      assert.equal(Number(fs.statSync(backupPath).mode & 0o777), 0o600);
    } finally {
      restored.close();
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function retryTask(db, config, taskId) {
  const daemon = new Daemon({
    db,
    config,
    adapters: createAdapterRegistry(config),
    logger: quiet,
  });
  return daemon.retry(taskId);
}

function resumeTask(db, config, taskId) {
  const daemon = new Daemon({
    db,
    config,
    adapters: createAdapterRegistry(config),
    logger: quiet,
  });
  return daemon.resume(taskId);
}
