import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAdapter, createAdapterRegistry } from "../src/adapters/index.mjs";
import { T3Adapter } from "../src/adapters/t3.mjs";
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
  getMasterFc,
  getMasterProject,
  getMeta,
  getTask,
  getWorkerModelRoutes,
  importRunningTask,
  openDb,
  pruneTasks,
  queuedTasks,
  recentChat,
  recentEvents,
  setMasterFc,
  searchTasks,
  setMeta,
  setWorkerStatus,
  taskEvents,
  setWorkerToken,
  unconsumedInbox,
  updateTask,
  upsertWorker,
} from "../src/db.mjs";
import { Leader, LeaderLoop } from "../src/leader.mjs";
import { createMasterSession, masterDefaults } from "../src/master-session.mjs";
import {
  leaderChoices,
  leaderConfigOptions,
  normalizeLeaderOverride,
} from "../src/leader-options.mjs";
import {
  inferUserModelPreference,
  planTaskModel,
} from "../src/model-policy.mjs";
import {
  reasoningPlanForTarget,
  resolveModelTarget,
  resolveTargetPlan,
  validateModelTarget,
} from "../src/model-catalog.mjs";
import { notifyMaster } from "../src/notifier.mjs";
import { reconcileT3Threads } from "../src/reconcile.mjs";
import { resolveProjectPath, validateArtifactPath } from "../src/projects.mjs";
import { ensureDefaultProject, resolveTaskProject } from "../src/registry.mjs";
import { startServer } from "../src/server.mjs";
import { buildStateCard, ruleReply } from "../src/state.mjs";
import { checkForUpdate, compareVersions, readUpdateCache } from "../src/update.mjs";
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

  const forced = testConfig(tempDir(), {
    t3Provider: "dim",
    t3Model: "dim/fast",
    forceModel: "dim/locked",
    forceProvider: "dima",
  });
  const forcedPlan = planTaskModel(forced, {
    title: "修复登录页 bug",
    brief: "改代码",
    model: "dim/coding",
    effort: "max",
    adapter: "t3",
  });
  assert.equal(forcedPlan.model, "dim/locked");

  const db = openDb(forced.dbPath);
  try {
    const task = addTask(db, {
      title: "provider persisted",
      brief: "provider task",
      adapter: "t3",
      projectPath: forced.projectPath,
      provider: "dima",
      model: "dim/locked",
      effort: "max",
    });
    assert.equal(task.provider, "dima");
  } finally {
    db.close();
  }

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

});

test("typed model tiers keep provider, model, and effort together", () => {
  const config = testConfig(tempDir(), {
    t3Provider: "dim",
    t3Model: "dim/default",
    modelTiers: {
      light: { provider: "dim", model: "dim/light", effort: "none" },
      deep: { provider: "dim", model: "dim/deep", effort: "max" },
      coding: { provider: "claudeAgent", model: "claude-opus-5-5", effort: "high" },
    },
  });
  const light = planTaskModel(config, {
    title: "rename a label",
    brief: "single file",
    adapter: "t3",
    category: "light",
  });
  assert.equal(light.provider, "dim");
  assert.equal(light.model, "dim/light");
  assert.equal(light.effort, "none");
  const deep = planTaskModel(config, {
    title: "review architecture",
    brief: "deep review",
    adapter: "t3",
    category: "deep",
  });
  assert.equal(deep.provider, "dim");
  assert.equal(deep.model, "dim/deep");
  assert.equal(deep.effort, "max");
  const coding = planTaskModel(config, {
    title: "fix flaky test",
    brief: "implement a regression test",
    adapter: "t3",
    category: "coding",
  });
  assert.equal(coding.provider, "claudeAgent");
  assert.equal(coding.model, "claude-opus-5-5");
  assert.equal(coding.effort, "high");
});

test("model routes keep provider and model paired and support explicit overrides", () => {
  const config = testConfig(tempDir(), {
    t3Provider: "dim",
    t3Model: "dimcode-api-oauth/deepseek-v4.1-flash",
    modelStrong: "dimcode-api-oauth/gpt-6.2-astra",
    modelCoding: "dimcode-api-oauth/claude-opus-5-5",
  });
  const masterFc = {
    provider: "dima",
    model: "deepseek-v4.1-flash",
    effort: "max",
  };
  const routes = {
    standard: {
      provider: "dim",
      model: "dimcode-api-oauth/deepseek-v4.1-flash",
      effort: "max",
    },
    coding: {
      provider: "dim",
      model: "dimcode-api-oauth/claude-opus-5-5",
      effort: "max",
    },
  };

  const routed = planTaskModel(config, {
    title: "查实时天气",
    brief: "查询温度和湿度",
    adapter: "t3",
    model: "deepseek-v4.1-flash",
    effort: "high",
    routes,
    masterFc,
  });
  assert.equal(routed.source, "route");
  assert.equal(routed.provider, "dim");
  assert.equal(routed.model, "dimcode-api-oauth/deepseek-v4.1-flash");
  assert.equal(routed.effort, "max");

  const categoryRouted = planTaskModel(config, {
    title: "查实时天气",
    brief: "查询温度和湿度",
    adapter: "t3",
    category: "standard",
    routes,
  });
  assert.equal(categoryRouted.provider, "dim");
  assert.equal(categoryRouted.model, "dimcode-api-oauth/deepseek-v4.1-flash");
  assert.equal(categoryRouted.effort, "max");

  const notAutoInherited = planTaskModel(config, {
    title: "查实时天气",
    brief: "查询温度和湿度",
    adapter: "t3",
    routes: {},
    masterFc,
  });
  assert.equal(notAutoInherited.model, "dimcode-api-oauth/deepseek-v4.1-flash");
  assert.equal(notAutoInherited.provider, "dim");

  const inferred = planTaskModel(config, {
    title: "查实时天气",
    brief: "查询温度和湿度",
    adapter: "t3",
    model: "deepseek-v4.1-flash",
    effort: "max",
    masterFc,
  });
  assert.equal(inferred.provider, "dima");
  assert.equal(inferred.model, "deepseek-v4.1-flash");

  const overridden = planTaskModel(config, {
    title: "查实时天气",
    brief: "查询温度和湿度",
    adapter: "t3",
    provider: "dima",
    model: "deepseek-v4.1-flash",
    effort: "max",
    routes,
    masterFc,
    modelOverride: true,
  });
  assert.equal(overridden.source, "override");
  assert.equal(overridden.provider, "dima");

  assert.throws(
    () =>
      planTaskModel(config, {
        title: "查实时天气",
        brief: "查询温度和湿度",
        adapter: "t3",
        provider: "dimcode-api-oauth",
        model: "deepseek-v4.1-flash",
        routes: {},
        modelOverride: true,
      }),
    /invalid T3 provider id/,
  );
});

test("user-directed routes persist per master and drive delegated tasks", async () => {
  const dir = tempDir();
  const config = testConfig(dir, {
    adapter: "t3",
    t3Provider: "dim",
    t3Model: "dimcode-api-oauth/deepseek-v4.1-flash",
    modelStrong: "dimcode-api-oauth/gpt-6.2-astra",
    modelCoding: "dimcode-api-oauth/claude-opus-5-5",
    leaderMode: "rule",
    allowedProjectRoots: [dir],
  });
  const db = openDb(config.dbPath);
  try {
    setMasterFc(db, "mcp:route-master", {
      provider: "dima",
      model: "deepseek-v4.1-flash",
      effort: "max",
    });
    setMeta(db, "master_project:mcp:route-master", dir);
    const leader = new Leader({ db, config, logger: quiet });
    const applied = await leader.applyActions(
      [
        {
          type: "set_model_routes",
          routes: {
            standard: {
              provider: "dim",
              model: "dimcode-api-oauth/deepseek-v4.1-flash",
              effort: "max",
            },
          },
        },
        {
          type: "add_task",
          title: "查上海实时天气",
          brief: "查询温度、湿度和风速",
          adapter: "t3",
          projectPath: dir,
          model: "deepseek-v4.1-flash",
          effort: "high",
        },
      ],
      { masterThreadId: "mcp:route-master", deferAddTasks: true },
    );
    assert.equal(applied[0].ok, true);
    assert.equal(applied[1].pending, true);
    assert.equal(applied[1].task.provider, "dim");
    assert.equal(
      applied[1].task.model,
      "dimcode-api-oauth/deepseek-v4.1-flash",
    );
    assert.equal(applied[1].task.effort, "max");
    assert.equal(applied[1].task.target.source, "route");
    assert.ok(applied[1].task.target.catalogRevision);
    assert.ok(applied[1].task.projectKey);
    const stored = getWorkerModelRoutes(db, "mcp:route-master");
    assert.equal(stored.standard.provider, "dim");
    const prompt = leader.buildPrompt({
      message: "查天气",
      trigger: "user",
      events: [],
      masterThreadId: "mcp:route-master",
      currentFc: {
        provider: "dima",
        model: "deepseek-v4.1-flash",
        effort: "max",
      },
    });
    assert.match(prompt, /identity: dima::deepseek-v4\.1-flash/);
    assert.match(prompt, new RegExp(`project: ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(prompt, /worker-routes: standard=dim::dimcode-api-oauth\/deepseek-v4\.1-flash\/max/);
    const card = buildStateCard(db, config, {
      masterThreadId: "mcp:route-master",
    });
    assert.match(card, /MASTER PROJECT:/);

    const all = await leader.applyActions(
      [
        {
          type: "set_model_routes",
          all: {
            provider: "dima",
            model: "deepseek-v4.1-flash",
            effort: "max",
          },
        },
        {
          type: "add_task",
          title: "查杭州实时天气",
          brief: "查询温度、湿度和风速",
          adapter: "t3",
          projectPath: dir,
        },
      ],
      { masterThreadId: "mcp:route-master", deferAddTasks: true },
    );
    assert.equal(all[0].ok, true);
    assert.equal(all[1].task.provider, "dima");
    assert.equal(all[1].task.model, "deepseek-v4.1-flash");
    assert.equal(all[1].task.effort, "max");
    assert.equal(
      getWorkerModelRoutes(db, "mcp:route-master").coding.provider,
      "dima",
    );

    const invalid = await leader.applyActions(
      [
        {
          type: "set_model_routes",
          all: {
            provider: "dimcode-api-oauth",
            model: "deepseek-v4.1-flash",
          },
        },
      ],
      { masterThreadId: "mcp:route-master" },
    );
    assert.equal(invalid[0].ok, false);
    assert.match(invalid[0].error, /invalid T3 provider id/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("model catalog preflight validates advertised provider/model/effort pairs", () => {
  const dir = tempDir();
  const home = path.join(dir, "t3-home");
  fs.mkdirSync(path.join(home, "caches"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "caches", "dim.json"),
    JSON.stringify({
      providerInstanceId: "dim",
      displayName: "DimAgent",
      status: "ready",
      installed: true,
      enabled: true,
      models: [
        {
          slug: "dimcode-api-oauth/deepseek-v4.1-flash",
          name: "DeepSeek",
          capabilities: {
            optionDescriptors: [
              {
                id: "thought_level",
                role: "reasoning",
                type: "select",
                options: [{ id: "none" }, { id: "high" }, { id: "max" }],
              },
            ],
          },
        },
      ],
    }),
  );
  const config = testConfig(dir, { t3Home: home });
  const ok = validateModelTarget(config, {
    provider: "dim",
    model: "dimcode-api-oauth/deepseek-v4.1-flash",
    effort: "max",
  });
  assert.equal(ok.ok, true);
  const wrongModel = validateModelTarget(config, {
    provider: "dim",
    model: "deepseek-flash",
    effort: "max",
  });
  assert.equal(wrongModel.ok, false);
  assert.ok(wrongModel.suggestions.length > 0);
  // "auto" means "let the provider choose": it is valid even when the
  // provider does not advertise an explicit auto option.
  const autoEffort = validateModelTarget(config, {
    provider: "dim",
    model: "dimcode-api-oauth/deepseek-v4.1-flash",
    effort: "auto",
  });
  assert.equal(autoEffort.ok, true);
  assert.equal(autoEffort.reasoning.value, null);
});

test("resolved target plans persist the actual reasoning option", () => {
  const dir = tempDir();
  const home = path.join(dir, "t3-home");
  fs.mkdirSync(path.join(home, "caches"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "caches", "dim.json"),
    JSON.stringify({
      providerInstanceId: "dim",
      models: [
        {
          slug: "dim/designed",
          name: "Designed",
          capabilities: {
            optionDescriptors: [
              {
                id: "thought_level",
                role: "reasoning",
                type: "select",
                options: [{ id: "high" }, { id: "xhigh" }],
              },
            ],
          },
        },
      ],
    }),
  );
  const config = testConfig(dir, { t3Home: home, t3Provider: "dim" });
  const plan = resolveTargetPlan(
    config,
    { provider: "dim", model: "dim/designed", effort: "max" },
    { source: "route" },
  );
  assert.equal(plan.reasoning.optionId, "thought_level");
  assert.equal(plan.reasoning.value, "xhigh");
  assert.equal(plan.source, "route");
  assert.equal(plan.catalogSource, "t3-cache");
  assert.ok(plan.catalogRevision);
  const db = openDb(config.dbPath);
  try {
    const task = addTask(db, {
      title: "resolved target",
      adapter: "t3",
      projectPath: dir,
      provider: plan.provider,
      model: plan.model,
      effort: plan.effort,
      target: plan,
    });
    assert.equal(task.target_source, "route");
    assert.equal(task.reasoning_option, "thought_level");
    assert.equal(task.reasoning_value, "xhigh");
    assert.equal(JSON.parse(task.target_json).catalogRevision, plan.catalogRevision);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FC leader choices expose provider models and per-provider effort", () => {
  const dir = tempDir();
  const home = path.join(dir, "t3-home");
  fs.mkdirSync(path.join(home, "caches"), { recursive: true });
  fs.mkdirSync(path.join(home, "userdata"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "caches", "dim.json"),
    JSON.stringify({
      providerInstanceId: "dim",
      displayName: "DimAgent",
      models: [{ slug: "dimcode-api-oauth/deepseek-v4.1-flash", name: "DeepSeek" }],
    }),
  );
  fs.writeFileSync(
    path.join(home, "caches", "dima.json"),
    JSON.stringify({
      providerInstanceId: "dima",
      displayName: "DimAgent Rust",
      models: [
        {
          slug: "deepseek-v4.1-flash",
          name: "DeepSeek Rust",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                type: "select",
                role: "reasoning",
                options: [
                  { id: "none" },
                  { id: "high" },
                  { id: "max" },
                ],
              },
            ],
          },
        },
      ],
    }),
  );
  const config = testConfig(dir, {
    t3Home: home,
    leaderMode: "dim",
    leaderModel: "gpt-6.2-astra",
    leaderChoices: [
      {
        provider: "dima",
        model: "deepseek-v4.1-flash",
        label: "Rust DimAgent / DeepSeek",
      },
    ],
  });
  try {
    const choices = leaderChoices(config);
    assert.equal(choices.defaultChoice.provider, "dim");
    assert.ok(choices.choices.some((choice) => choice.id === "dima::deepseek-v4.1-flash"));
    const providerDefault = leaderChoices(
      testConfig(dir, { t3Home: home, leaderMode: "dima" }),
    ).defaultChoice;
    assert.equal(providerDefault.provider, "dima");
    assert.equal(providerDefault.model, "deepseek-v4.1-flash");
    const configOptions = leaderConfigOptions(config, {
      provider: "dima",
      model: "deepseek-v4.1-flash",
      effort: "max",
    });
    assert.equal(configOptions.configOptions[0].currentValue, "dima::deepseek-v4.1-flash");
    assert.equal(configOptions.configOptions[1].currentValue, "max");
    assert.deepEqual(
      configOptions.configOptions[1].options.map((option) => option.value),
      ["none", "high", "max"],
    );
    const modelMeta = configOptions.models.availableModels.find(
      (model) => model.modelId === "dima::deepseek-v4.1-flash",
    )?._meta;
    assert.deepEqual(
      modelMeta.reasoningEfforts.map((effort) => effort.value),
      ["none", "high", "max"],
    );
    const override = normalizeLeaderOverride(
      { provider: "dima", model: "deepseek-v4.1-flash", effort: "high" },
      config,
    );
    assert.equal(override.mode, "dima");
    assert.equal(override.provider, "dima");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("master FC selection persists and per-master turns do not block each other", async () => {
  const dir = tempDir();
  const config = testConfig(dir, { leaderMode: "rule" });
  const db = openDb(config.dbPath);
  try {
    setMasterFc(db, "mcp:master-a", {
      provider: "dima",
      model: "deepseek-v4.1-flash",
      effort: "high",
    });
    assert.deepEqual(
      {
        provider: getMasterFc(db, "mcp:master-a").provider,
        model: getMasterFc(db, "mcp:master-a").model,
        effort: getMasterFc(db, "mcp:master-a").effort,
      },
      { provider: "dima", model: "deepseek-v4.1-flash", effort: "high" },
    );

    const routedTask = addTask(db, {
      title: "master-routed task",
      brief: "routing",
      adapter: "mock",
      projectPath: dir,
      masterThreadId: "mcp:master-a",
    });
    assert.equal(routedTask.master_thread_id, "mcp:master-a");

    const leader = new Leader({ db, config, logger: quiet });
    let active = 0;
    let maxActive = 0;
    leader.runTurn = async ({ masterThreadId, message }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(80);
      active -= 1;
      return {
        reply: `${masterThreadId}:${message}`,
        actions: [],
        applied: [],
        fallback: false,
      };
    };
    await Promise.all([
      leader.turn({ masterThreadId: "mcp:a", message: "a" }),
      leader.turn({ masterThreadId: "mcp:b", message: "b" }),
    ]);
    assert.ok(maxActive >= 2);
    let sameKeyActive = 0;
    let sameKeyMax = 0;
    leader.runTurn = async () => {
      sameKeyActive += 1;
      sameKeyMax = Math.max(sameKeyMax, sameKeyActive);
      await sleep(30);
      sameKeyActive -= 1;
      return { reply: "ok", actions: [], applied: [], fallback: false };
    };
    await Promise.all([
      leader.turn({ masterThreadId: "mcp:same", message: "a" }),
      leader.turn({ masterThreadId: "mcp:same", message: "b" }),
    ]);
    assert.equal(sameKeyMax, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("leader override runs dima with model and effort and can use a T3 fallback provider", async () => {
  const dir = tempDir();
  const argsFile = path.join(dir, "args.txt");
  const stdinFile = path.join(dir, "stdin.txt");
  const fakeDima = path.join(dir, "fake-dima.sh");
  fs.writeFileSync(
    fakeDima,
    `#!/bin/sh\nprintf '%s\n' "$@" > ${JSON.stringify(argsFile)}\ncat > ${JSON.stringify(stdinFile)}\nprintf '%s\n' '{"reply":"fake dima leader reply","actions":[]}'\n`,
    { mode: 0o755 },
  );
  const fakeT3 = path.join(dir, "fake-t3.sh");
  fs.writeFileSync(
    fakeT3,
    `#!/bin/sh\nprintf '%s\n' "$@" > ${JSON.stringify(path.join(dir, "t3-args.txt"))}\ncat >/dev/null\nprintf '%s\n' '{"reply":"{\\"reply\\":\\"fake t3 leader reply\\",\\"actions\\":[]}"}\n'`,
    { mode: 0o755 },
  );
  const config = testConfig(dir, {
    leaderMode: "rule",
    dimaBin: fakeDima,
    t3Bin: fakeT3,
    t3Project: dir,
    t3ReasoningOption: "effort",
    leaderChoices: [
      {
        provider: "dima",
        model: "deepseek-v4.1-flash",
        label: "Rust DimAgent / DeepSeek",
      },
    ],
  });
  const db = openDb(config.dbPath);
  try {
    const leader = new Leader({ db, config, logger: quiet });
    const dima = await leader.turn({
      message: "现在什么情况？",
      trigger: "user",
      leader: { provider: "dima", model: "deepseek-v4.1-flash", effort: "max" },
    });
    assert.equal(dima.fallback, false);
    assert.equal(dima.reply, "fake dima leader reply");
    const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
    assert.equal(args[args.indexOf("--model") + 1], "deepseek-v4.1-flash");
    assert.equal(args[args.indexOf("--effort") + 1], "max");
    assert.equal(args[args.indexOf("--permission") + 1], "read-only");
    assert.match(
      fs.readFileSync(stdinFile, "utf8"),
      /不要调用任何工具/,
    );

    const t3 = await leader.turn({
      message: "现在什么情况？",
      trigger: "user",
      leader: { provider: "custom", model: "custom-model", effort: "high" },
    });
    assert.equal(t3.fallback, false);
    assert.match(t3.reply, /fake t3 leader reply/);
    const t3Args = fs.readFileSync(path.join(dir, "t3-args.txt"), "utf8").trim().split("\n");
    assert.equal(t3Args[t3Args.indexOf("--provider") + 1], "custom");
    assert.equal(t3Args[t3Args.indexOf("--model") + 1], "custom-model");
    assert.match(t3Args.join("\n"), /--option\neffort=high/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("model target resolution uses catalog identity, not model-string prefixes", () => {
  const dir = tempDir();
  const home = path.join(dir, "t3-home");
  fs.mkdirSync(path.join(home, "caches"), { recursive: true });
  const descriptor = (id, values) => ({
    capabilities: {
      optionDescriptors: [
        {
          id,
          role: "reasoning",
          type: "select",
          options: values.map((value) => ({ id: value })),
        },
      ],
    },
  });
  fs.writeFileSync(
    path.join(home, "caches", "alpha.json"),
    JSON.stringify({
      providerInstanceId: "alpha",
      models: [
        { slug: "shared-model", name: "Shared", ...descriptor("effort", ["none", "high", "max"]) },
        { slug: "alpha-only", name: "Alpha", aliases: ["alpha", "a1"], ...descriptor("thought_level", ["auto", "high", "xhigh"]) },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(home, "caches", "beta.json"),
    JSON.stringify({
      providerInstanceId: "beta",
      models: [
        { slug: "shared-model", name: "Shared", ...descriptor("reasoningEffort", ["low", "medium", "high", "max"]) },
      ],
    }),
  );
  const config = testConfig(dir, { t3Home: home, t3Provider: "alpha" });

  const ambiguous = resolveModelTarget(config, { model: "shared-model" });
  assert.equal(ambiguous.validation.ok, false);
  assert.match(ambiguous.validation.errors.join("\n"), /provider is required/);
  assert.deepEqual(
    ambiguous.validation.suggestions.map((item) => item.provider).sort(),
    ["alpha", "beta"],
  );

  const preferred = resolveModelTarget(config, { model: "shared-model" }, {
    preferredProviders: ["beta"],
  });
  assert.equal(preferred.provider, "beta");
  assert.equal(preferred.validation.ok, true);

  const alias = resolveModelTarget(
    config,
    { model: "a1", effort: "max" },
    { preferredProviders: ["alpha"] },
  );
  assert.equal(alias.provider, "alpha");
  assert.equal(alias.model, "alpha-only");
  assert.equal(alias.inferredProvider, true);
  assert.equal(alias.validation.reasoning.optionId, "thought_level");
  assert.equal(alias.validation.reasoning.value, "xhigh");
  assert.equal(
    reasoningPlanForTarget(config, {
      provider: "alpha",
      model: "shared-model",
      effort: "max",
    }).optionId,
    "effort",
  );
  assert.equal(
    reasoningPlanForTarget(config, {
      provider: "beta",
      model: "shared-model",
      effort: "max",
    }).value,
    "max",
  );

  const explicitOnlyConfig = testConfig(dir, {
    t3Home: home,
    leaderChoices: [{ provider: "gamma", model: "explicit-only" }],
  });
  const explicitOnly = validateModelTarget(explicitOnlyConfig, {
    provider: "gamma",
    model: "explicit-only",
    effort: "max",
  });
  assert.equal(explicitOnly.ok, false);
  assert.match(explicitOnly.errors.join("\n"), /not advertised/);
});

test("local daemon blocks an invalid queued target before starting a T3 thread", async () => {
  const dir = tempDir();
  const home = path.join(dir, "t3-home");
  fs.mkdirSync(path.join(home, "caches"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "caches", "dim.json"),
    JSON.stringify({
      providerInstanceId: "dim",
      models: [{ slug: "dim/valid", name: "Valid" }],
    }),
  );
  const started = path.join(dir, "started.txt");
  const script = path.join(dir, "fake-t3.sh");
  fs.writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(started)}\necho '{"threadId":"mcp:should-not-start"}'\n`,
    { mode: 0o755 },
  );
  const config = testConfig(dir, {
    adapter: "t3",
    t3Home: home,
    t3Bin: script,
    t3Provider: "dim",
    t3Model: "dim/valid",
    t3Worktree: false,
  });
  const db = openDb(config.dbPath);
  try {
    const task = addTask(db, {
      title: "invalid target",
      brief: "should not start",
      adapter: "t3",
      projectPath: dir,
      provider: "dim",
      model: "dim/not-advertised",
      effort: "max",
    });
    const daemon = new Daemon({
      db,
      config,
      adapters: createAdapterRegistry(config),
      logger: quiet,
    });
    await daemon.tick();
    const blocked = getTask(db, task.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.error, /not advertised by T3/);
    assert.equal(fs.existsSync(started), false);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("worker claim blocks an invalid target before it can start", () => {
  const dir = tempDir();
  const home = path.join(dir, "t3-home");
  fs.mkdirSync(path.join(home, "caches"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "caches", "dim.json"),
    JSON.stringify({
      providerInstanceId: "dim",
      models: [
        {
          slug: "dim/valid",
          name: "Valid",
          capabilities: {
            optionDescriptors: [
              {
                id: "thought_level",
                role: "reasoning",
                type: "select",
                options: [{ id: "high" }, { id: "max" }],
              },
            ],
          },
        },
      ],
    }),
  );
  const config = testConfig(dir, {
    adapter: "t3",
    t3Home: home,
    t3Provider: "dim",
    t3Model: "dim/valid",
    executionMode: "local",
  });
  const db = openDb(config.dbPath);
  try {
    registerWorker(db, {
      id: "worker-a",
      capacity: 1,
      protocolVersion: WORKER_PROTOCOL_VERSION,
    });
    const task = addTask(db, {
      title: "invalid worker target",
      brief: "should not be claimed",
      adapter: "t3",
      projectPath: dir,
      provider: "dim",
      model: "dim/not-advertised",
      effort: "max",
    });
    const claimed = claimTasksForWorker(db, config, {
      workerId: "worker-a",
      limit: 1,
    });
    assert.equal(claimed.length, 0);
    assert.equal(getTask(db, task.id).status, "blocked");

    const valid = addTask(db, {
      title: "valid worker target",
      brief: "should be claimed with a plan",
      adapter: "t3",
      projectPath: dir,
      provider: "dim",
      model: "dim/valid",
      effort: "max",
    });
    const claimedValid = claimTasksForWorker(db, config, {
      workerId: "worker-a",
      limit: 1,
    });
    assert.equal(claimedValid.length, 1);
    assert.equal(claimedValid[0].id, valid.id);
    assert.equal(claimedValid[0].target.provider, "dim");
    assert.equal(claimedValid[0].target.reasoning.optionId, "thought_level");
    assert.equal(claimedValid[0].target.reasoning.value, "max");
    assert.equal(getTask(db, valid.id).target_source, "claim");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("T3 adapter passes the task model and reasoning effort", async () => {
  const dir = tempDir();
  try {
    const home = path.join(dir, "t3-home");
    fs.mkdirSync(path.join(home, "caches"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "caches", "dim.json"),
      JSON.stringify({
        providerInstanceId: "dim",
        displayName: "DimAgent",
        models: [
          {
            slug: "dim/fast",
            name: "Fast",
            capabilities: {
              optionDescriptors: [
                {
                  id: "thought_level",
                  role: "reasoning",
                  type: "select",
                  options: [{ id: "none" }, { id: "high" }, { id: "max" }],
                },
              ],
            },
          },
          {
            slug: "dim/strong",
            name: "Strong",
            capabilities: {
              optionDescriptors: [
                {
                  id: "thought_level",
                  role: "reasoning",
                  type: "select",
                  options: [{ id: "none" }, { id: "high" }, { id: "xhigh" }],
                },
              ],
            },
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(home, "caches", "dima.json"),
      JSON.stringify({
        providerInstanceId: "dima",
        displayName: "DimAgent Rust",
        models: [
          {
            slug: "deepseek-v4.1-flash",
            name: "DeepSeek",
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  role: "reasoning",
                  type: "select",
                  options: [{ id: "none" }, { id: "high" }, { id: "max" }],
                },
              ],
            },
          },
        ],
      }),
    );
    const out = path.join(dir, "t3-args.txt");
    const script = path.join(dir, "fake-t3.sh");
    fs.writeFileSync(
      script,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(out)}\necho '{"threadId":"mcp:model-test","thread":{"link":"https://app.t3.codes/threads/proj/mcp%3Amodel-test"}}'\n`,
      { mode: 0o755 },
    );
    const config = testConfig(dir, {
      t3Home: home,
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
    assert.equal(args[optionAt + 1], "thought_level=xhigh");
    assert.match(args.join("\n"), /完成后最后单独一行输出：TASK_DONE/);

    await adapter.start({
      project_path: dir,
      title: "跨 provider 推理选项",
      brief: "只回复 OK",
      provider: "dima",
      model: "deepseek-v4.1-flash",
      effort: "high",
    });
    const crossProviderArgs = fs.readFileSync(out, "utf8").trimEnd().split("\n");
    assert.equal(
      crossProviderArgs[crossProviderArgs.indexOf("--provider") + 1],
      "dima",
    );
    assert.equal(
      crossProviderArgs[crossProviderArgs.indexOf("--option") + 1],
      "effort=high",
    );

    await adapter.start({
      project_path: dir,
      title: "control-plane target plan",
      brief: "use the resolved plan",
      target: {
        provider: "dim",
        model: "dim/strong",
        effort: "max",
        reasoning: { optionId: "resolved_level", value: "peak" },
        source: "route",
        catalogRevision: "test-revision",
      },
    });
    const plannedArgs = fs.readFileSync(out, "utf8").trimEnd().split("\n");
    assert.equal(plannedArgs[plannedArgs.indexOf("--option") + 1], "resolved_level=peak");
    assert.equal(plannedArgs[plannedArgs.indexOf("--model") + 1], "dim/strong");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("T3 adapter classifies authentication failures as non-retryable", async () => {
  const dir = tempDir();
  try {
    const script = path.join(dir, "fake-auth.sh");
    fs.writeFileSync(
      script,
      "#!/bin/sh\nprintf '%s\\n' 'Provider authentication is required' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    const config = testConfig(dir, {
      t3Bin: script,
      t3Provider: "dim",
      t3Model: "dim/fast",
      t3Worktree: false,
    });
    const adapter = createAdapter("t3", config);
    await assert.rejects(
      adapter.start({
        project_path: dir,
        title: "auth failure",
        brief: "should classify",
        target: {
          provider: "dim",
          model: "dim/fast",
          effort: "max",
          reasoning: { optionId: "thought_level", value: "max" },
        },
      }),
      (error) => error.code === "auth" && error.retryable === false,
    );
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
  const home = path.join(dir, "t3-home");
  fs.mkdirSync(path.join(home, "caches"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "caches", "dim.json"),
    JSON.stringify({
      providerInstanceId: "dim",
      models: [
        { slug: "dim/fast", name: "Fast" },
        { slug: "dim/strong", name: "Strong" },
      ],
    }),
  );
  const config = testConfig(dir, {
    t3Home: home,
    t3Provider: "dim",
    t3Model: "dim/fast",
    leaderMode: "rule",
    leaderChoices: [
      { provider: "dim", model: "dim/fast" },
      { provider: "dim", model: "dim/strong" },
    ],
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

test("CLI flag overrides include leader effort", () => {
  const dir = tempDir();
  try {
    const output = execFileSync(
      process.execPath,
      [
        path.join(ROOT, "src", "cli.mjs"),
        "models",
        "--json",
        "--data-dir",
        "data",
        "--leader",
        "dim",
        "--leader-model",
        "gpt-6.2-astra",
        "--leader-effort",
        "high",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    const data = JSON.parse(output);
    assert.equal(data.leader.mode, "dim");
    assert.equal(data.leader.provider, "dim");
    assert.equal(data.leader.model, "gpt-6.2-astra");
    assert.equal(data.leader.effort, "high");
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

test("expired lease with a missing thread is marked lost instead of restarted", async () => {
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

    const lost = getTask(db, task.id);
    assert.equal(lost.status, "lost");
    assert.equal(lost.thread_id, null);
    assert.match(lost.error, /T3 thread disappeared/);
    assert.equal(lost.lease_until, null);
    assert.ok(
      recentEvents(db, 20).some(
        (event) =>
          event.task_id === task.id &&
          event.type === "thread_missing" &&
          event.payload?.action === "marked_lost",
      ),
    );
    assert.equal(daemon.stats.lost, 1);
    assert.equal(
      unconsumedInbox(db).some(
        (item) => item.kind === "task_failed" && item.task_id === task.id,
      ),
      false,
    );
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
    addProject(db, { name: "t3-project", path: dir, adapter: "t3" });

    const card = buildStateCard(db, config);
    assert.match(card, /TOTALS: total=2 queued=1 running=1/);
    assert.match(card, /ADAPTER: mock \(MOCK\/SIMULATED/);
    assert.match(card, /t3-project@[^\n]*\[t3\]/);
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

test("master can look up task detail and answer without opening a worker thread", async () => {
  const dir = tempDir();
  const fakeDim = path.join(ROOT, "test", "fixtures", "fake-lookup-dim.mjs");
  fs.chmodSync(fakeDim, 0o755);
  const config = testConfig(dir, { leaderMode: "dim", dimBin: fakeDim });
  const db = openDb(config.dbPath);
  try {
    const task = addTask(db, {
      title: "修复登录缓存",
      brief: "定位登录页缓存过期问题",
      adapter: "mock",
      projectPath: dir,
    });
    updateTask(db, task.id, {
      status: "done",
      result: "登录根因是缓存过期。",
      finished_at: Date.now(),
    });
    appendEvent(db, task.id, "done", { result: "登录根因是缓存过期。" });
    addChat(db, "user", "我们之前决定周五发布登录修复。");

    const matches = searchTasks(db, "之前登录那个任务", 5);
    assert.ok(matches.some((row) => row.id === task.id));
    assert.equal(taskEvents(db, task.id, 5).at(-1).type, "done");

    const leader = new Leader({ db, config, logger: quiet });
    const detail = leader.taskLookup(task.id);
    assert.match(detail, /登录根因是缓存过期/);
    assert.match(detail, /EVENTS:/);
    assert.match(detail, /不要.*打开执行线程/);
    const chatDetail = leader.taskLookup("chat:周五");
    assert.match(chatDetail, /对话历史查询/);
    assert.match(chatDetail, /周五发布登录修复/);

    const result = await leader.turn({
      message: "刚才那个登录任务的结果是什么？",
      trigger: "user",
    });
    assert.equal(result.fallback, false);
    assert.match(result.reply, /查到详情：登录根因是缓存过期/);

    const direct = await leader.turn({
      message: `${task.id} 的结果是什么？`,
      trigger: "user",
    });
    assert.equal(direct.fallback, false);
    assert.match(direct.reply, /查到详情：登录根因是缓存过期/);
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

test("master session creation binds one T3 thread and stores its FC", async () => {
  const dir = tempDir();
  const fakeT3 = path.join(ROOT, "test", "fixtures", "fake-t3-master.mjs");
  fs.chmodSync(fakeT3, 0o755);
  const config = testConfig(dir, {
    adapter: "t3",
    leaderMode: "dim",
    leaderModel: "gpt-6.2-astra",
    leaderEffort: "high",
    t3Bin: fakeT3,
    t3Project: dir,
  });
  const stateFile = path.join(dir, "fake-t3-master-state.json");
  const previousStateFile = process.env.FOREMAN_FAKE_T3_MASTER_STATE;
  process.env.FOREMAN_FAKE_T3_MASTER_STATE = stateFile;
  const db = openDb(config.dbPath);
  try {
    const defaults = masterDefaults(config);
    assert.equal(defaults.provider, "dim");
    assert.equal(defaults.model, "gpt-6.2-astra");
    const result = await createMasterSession({ db, config });
    assert.equal(result.threadId, "mcp:fake-master");
    assert.equal(getMeta(db, "master_thread_id"), "mcp:fake-master");
    assert.equal(getMasterFc(db, "mcp:fake-master").provider, "dim");
    assert.equal(getMasterProject(db, "mcp:fake-master"), dir);

    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.argv[0], "thread");
    assert.equal(state.argv[1], "start");
    assert.match(state.argv.join(" "), /--provider foreman/);
    assert.match(state.argv.join(" "), /--model dim::gpt-6\.2-astra/);
    assert.match(state.argv.join(" "), /--option effort=high/);
  } finally {
    if (previousStateFile === undefined) {
      delete process.env.FOREMAN_FAKE_T3_MASTER_STATE;
    } else {
      process.env.FOREMAN_FAKE_T3_MASTER_STATE = previousStateFile;
    }
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("t3 leader reuses one long-lived internal session across turns", async () => {
  const dir = tempDir();
  const fakeT3 = path.join(ROOT, "test", "fixtures", "fake-t3-leader.mjs");
  fs.chmodSync(fakeT3, 0o755);
  const config = testConfig(dir, {
    leaderMode: "t3",
    leaderProvider: "claudeAgent",
    leaderModel: "claude-opus-5-5",
    t3Bin: fakeT3,
    t3Project: dir,
  });
  const stateFile = path.join(dir, "fake-t3-leader-state.json");
  const previousStateFile = process.env.FOREMAN_FAKE_T3_STATE;
  process.env.FOREMAN_FAKE_T3_STATE = stateFile;
  const db = openDb(config.dbPath);
  try {
    const leader = new Leader({ db, config, logger: quiet });
    const first = await leader.turn({ message: "第一问", trigger: "user" });
    assert.equal(first.fallback, false);
    assert.match(first.reply, /first leader reply/);
    const second = await leader.turn({ message: "第二问", trigger: "user" });
    assert.equal(second.fallback, false);
    assert.match(second.reply, /second leader reply/);

    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.starts, 1);
    assert.equal(state.sends, 1);
    assert.equal(state.lastSendThread, "mcp:fake-leader-session");
    const meta = db
      .prepare("SELECT key, value FROM meta WHERE key LIKE 't3_leader_thread:%'")
      .all();
    assert.equal(meta.length, 1);
    assert.equal(meta[0].value, "mcp:fake-leader-session");
  } finally {
    if (previousStateFile === undefined) {
      delete process.env.FOREMAN_FAKE_T3_STATE;
    } else {
      process.env.FOREMAN_FAKE_T3_STATE = previousStateFile;
    }
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
  const config = testConfig(dir, { allowedProjectRoots: [dir] });
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
    assert.equal(resolved.projectKey, `project:${project.id}`);

    const nested = path.join(dir, "special-project");
    fs.mkdirSync(nested);
    addProject(db, { name: "alias", path: nested, adapter: "mock" });
    const resolvedByDirName = resolveTaskProject(db, config, {
      project: nested,
    });
    assert.equal(resolvedByDirName.project.name, "alias");
    assert.equal(resolvedByDirName.projectPath, nested);

    const task = addTask(db, {
      title: "registry-task",
      brief: "x",
      adapter: resolved.adapter,
      projectPath: resolved.projectPath,
      projectKey: resolved.projectKey,
      projectId: resolved.project.id,
    });
    assert.equal(getTask(db, task.id).project_id, project.id);
    assert.equal(getTask(db, task.id).project_key, `project:${project.id}`);
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

    const t3Config = testConfig(dir, {
      adapter: "t3",
      t3Provider: "dim",
      t3Model: "dimcode-api-oauth/deepseek-v4.1-flash",
      modelStrong: "dimcode-api-oauth/gpt-6.2-astra",
      modelCoding: "dimcode-api-oauth/claude-opus-5-5",
      workerModelRoutes: {
        standard: {
          provider: "dim",
          model: "dimcode-api-oauth/deepseek-v4.1-flash",
          effort: "max",
        },
      },
    });
    const stale = addTask(db, {
      title: "查上海实时天气",
      brief: "查询温度",
      adapter: "t3",
      projectPath: dir,
      provider: "dima",
      model: "deepseek-v4.1-flash",
      effort: "high",
    });
    updateTask(db, stale.id, { status: "failed", error: "model rejected" });
    const t3Daemon = new Daemon({
      db,
      config: t3Config,
      adapters: createAdapterRegistry(t3Config),
      logger: quiet,
    });
    const repaired = t3Daemon.retry(stale.id);
    assert.equal(repaired.provider, "dim");
    assert.equal(repaired.model, "dimcode-api-oauth/deepseek-v4.1-flash");
    assert.equal(repaired.effort, "max");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retryVerified safely requeues a blocked task when its thread is gone", async () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    const task = addTask(db, {
      title: "stale-thread",
      brief: "review",
      adapter: "mock",
      projectPath: dir,
    });
    updateTask(db, task.id, {
      status: "blocked",
      thread_id: "thread-that-was-deleted",
      error:
        "lease expired; cannot confirm the old worker stopped; verify thread thread-that-was-deleted manually",
    });

    let stopCalls = 0;
    const fake = {
      name: "mock",
      async stop() {
        stopCalls += 1;
        return { stopped: true, missing: true };
      },
      async poll() {
        return { state: "unknown" };
      },
    };
    const daemon = new Daemon({
      db,
      config,
      adapters: { mock: fake },
      logger: quiet,
    });
    const retried = await daemon.retryVerified(task.id);
    assert.equal(stopCalls, 1);
    assert.equal(retried.status, "queued");
    assert.equal(retried.thread_id, null);
    assert.equal(retried.error, null);

    updateTask(db, task.id, {
      status: "blocked",
      thread_id: "thread-still-live",
      error:
        "lease expired; cannot confirm the old worker stopped; verify thread thread-still-live manually",
    });
    const live = {
      ...fake,
      async stop() {
        return { stopped: false, reason: "thread is still live" };
      },
    };
    const guarded = new Daemon({
      db,
      config,
      adapters: { mock: live },
      logger: quiet,
    });
    await assert.rejects(
      () => guarded.retryVerified(task.id),
      /live worker/,
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("T3 adapter reports native workflow availability", async () => {
  const dir = tempDir();
  try {
    const adapter = new T3Adapter({ t3Bin: "t3", projectPath: dir });
    adapter.call = async () => ({
      code: 1,
      stdout: "",
      stderr: "Workflows are off on this server. Turn them on in Settings → Labs.",
    });
    const off = await adapter.workflows();
    assert.equal(off.ok, false);
    assert.equal(off.enabled, false);

    adapter.call = async () => ({
      code: 1,
      stdout: "USAGE\n  t3 <subcommand>\n\nSUBCOMMANDS\n  thread\n\nERROR\n  Unrecognized flag: --json",
      stderr: "",
    });
    const unsupported = await adapter.workflows();
    assert.equal(unsupported.unsupported, true);
    assert.equal(unsupported.enabled, null);

    adapter.call = async () => ({
      code: 0,
      stdout: JSON.stringify([{ status: "running" }, { status: "waiting" }]),
      stderr: "",
    });
    const on = await adapter.workflows();
    assert.equal(on.ok, true);
    assert.equal(on.enabled, true);
    assert.equal(on.runs.length, 2);
    assert.equal(on.counts.running, 1);
    assert.equal(on.counts.waiting, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("T3 adapter treats a deleted thread as stopped and missing", async () => {
  const dir = tempDir();
  try {
    const adapter = new T3Adapter({
      t3Bin: "t3",
      projectPath: dir,
    });
    adapter.call = async () => ({
      code: 0,
      stdout: "Thread mcp:gone is no longer available.\n",
      stderr: "",
    });
    const stopped = await adapter.stop({ thread_id: "mcp:gone" });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.missing, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("non-retryable auth failures block immediately instead of consuming retries", async () => {
  const dir = tempDir();
  const config = testConfig(dir, { maxAttempts: 3 });
  const db = openDb(config.dbPath);
  try {
    const fake = {
      name: "fake",
      leaseMs: 1000,
      async start() {
        const error = new Error("Provider authentication is required");
        error.code = "auth";
        error.retryable = false;
        throw error;
      },
      async poll() {
        return { state: "running" };
      },
    };
    const daemon = new Daemon({
      db,
      config,
      adapters: { mock: fake },
      logger: quiet,
    });
    const task = addTask(db, {
      title: "auth failure",
      adapter: "mock",
      projectPath: dir,
    });
    await daemon.tick();
    const blocked = getTask(db, task.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.attempts, 1);
    assert.match(blocked.error, /auth/);
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
    const routedTask = addTask(db, {
      title: "master-routed task",
      brief: "routing",
      adapter: "mock",
      projectPath: dir,
      masterThreadId: "mcp:master-a",
    });
    assert.equal(routedTask.master_thread_id, "mcp:master-a");

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

    const setup = await fetch(`${base}/api/setup`, { headers: auth });
    assert.equal(setup.status, 200);
    const setupBody = await setup.json();
    assert.equal(setupBody.setup.master.bound, false);
    assert.equal(setupBody.setup.canCreate, false);
    assert.ok(setupBody.setup.defaults.provider);
    const createWithoutT3 = await fetch(`${base}/api/master/create`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(createWithoutT3.status, 409);

    const projects = await fetch(`${base}/api/projects`, { headers: auth });
    assert.equal(projects.status, 200);
    const projectBody = await projects.json();
    assert.ok(projectBody.projects.some((project) => project.name === "default"));

    setMasterFc(db, "mcp:http-test", {
      provider: "dima",
      model: "deepseek-v4.1-flash",
      effort: "high",
    });
    setMeta(db, "master_thread_id", "mcp:http-test");
    const boundSetup = await fetch(`${base}/api/setup`, { headers: auth });
    assert.equal(boundSetup.status, 200);
    assert.equal((await boundSetup.json()).setup.master.bound, true);
    const fc = await fetch(`${base}/api/master/fc?threadId=mcp:http-test`, {
      headers: auth,
    });
    assert.equal(fc.status, 200);
    const fcBody = await fc.json();
    assert.equal(fcBody.fc.provider, "dima");
    assert.equal(fcBody.fc.effort, "high");

    const modelRoutes = await fetch(`${base}/api/model-routes`, {
      headers: auth,
    });
    assert.equal(modelRoutes.status, 200);
    const modelRoutesBody = await modelRoutes.json();
    assert.equal(modelRoutesBody.masterThreadId, "mcp:http-test");
    assert.ok(modelRoutesBody.routes);
    assert.ok(Array.isArray(modelRoutesBody.catalog));

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

    const badJson = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{",
    });
    assert.equal(badJson.status, 400);

    const tooLarge = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "too-large", brief: "x".repeat(1024 * 1024) }),
    });
    assert.equal(tooLarge.status, 413);
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
            const newSession = message.result;
            assert.ok(Array.isArray(newSession.configOptions));
            assert.ok(newSession.configOptions.some((option) => option.id === "model"));
            assert.ok(newSession.configOptions.some((option) => option.id === "effort"));
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

    fs.rmSync(out, { force: true });
    assert.equal(
      notifyMaster(db, config, "✅ 完成：其他 master", "mcp:other-master"),
      true,
    );
    await waitFor(
      () =>
        fs.existsSync(out) &&
        fs.readFileSync(out, "utf8").includes("mcp:other-master"),
    );
    const routed = fs.readFileSync(out, "utf8").trimEnd().split("\n");
    assert.deepEqual(routed.slice(0, 3), ["thread", "send", "mcp:other-master"]);
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

test("task prune requires terminal statuses and supports dry-run", () => {
  const dir = tempDir();
  const db = openDb(path.join(dir, "prune.db"));
  try {
    const oldDone = addTask(db, {
      title: "old done",
      brief: "x",
      adapter: "mock",
      projectPath: dir,
    });
    const oldTime = Date.now() - 40 * 24 * 60 * 60 * 1000;
    updateTask(db, oldDone.id, {
      status: "done",
      finished_at: oldTime,
      updated_at: oldTime,
    });
    appendEvent(db, oldDone.id, "old-event", { keep: false });
    appendInbox(db, "task_done", oldDone.id, { keep: false });

    const recent = addTask(db, {
      title: "recent done",
      brief: "x",
      adapter: "mock",
      projectPath: dir,
    });
    updateTask(db, recent.id, {
      status: "done",
      finished_at: Date.now(),
      updated_at: Date.now(),
    });
    const active = addTask(db, {
      title: "still active",
      brief: "x",
      adapter: "mock",
      projectPath: dir,
    });
    updateTask(db, active.id, {
      status: "running",
      updated_at: oldTime,
    });

    assert.throws(
      () => pruneTasks(db, { statuses: ["running"], apply: false }),
      /terminal statuses/,
    );
    const dry = pruneTasks(db, {
      statuses: ["done"],
      olderThanMs: 30 * 24 * 60 * 60 * 1000,
      apply: false,
    });
    assert.equal(dry.candidates.length, 1);
    assert.equal(dry.deleted, 0);
    assert.ok(getTask(db, oldDone.id));

    const applied = pruneTasks(db, {
      statuses: ["done"],
      olderThanMs: 30 * 24 * 60 * 60 * 1000,
      apply: true,
    });
    assert.equal(applied.deleted, 1);
    assert.ok(applied.events >= 1);
    assert.equal(applied.inbox, 1);
    assert.equal(getTask(db, oldDone.id), null);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ?").get(oldDone.id).n,
      0,
    );
    assert.ok(getTask(db, recent.id));
    assert.ok(getTask(db, active.id));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("thread reconcile marks missing active tasks lost and clears terminal links", async () => {
  const dir = tempDir();
  const db = openDb(path.join(dir, "reconcile.db"));
  try {
    const active = addTask(db, {
      title: "active missing",
      brief: "x",
      adapter: "t3",
      projectPath: dir,
    });
    updateTask(db, active.id, {
      status: "running",
      thread_id: "thread-missing",
      thread_link: "https://example.test/missing",
      lease_until: Date.now() + 60_000,
    });
    const done = addTask(db, {
      title: "terminal missing",
      brief: "x",
      adapter: "t3",
      projectPath: dir,
    });
    updateTask(db, done.id, {
      status: "done",
      thread_id: "thread-done",
      thread_link: "https://example.test/done",
      finished_at: Date.now(),
    });
    const live = addTask(db, {
      title: "live",
      brief: "x",
      adapter: "t3",
      projectPath: dir,
    });
    updateTask(db, live.id, {
      status: "running",
      thread_id: "thread-live",
      thread_link: "https://example.test/live",
    });

    const adapter = {
      async show(task) {
        return {
          state: task.thread_id === "thread-live" ? "running" : "unknown",
          error: "thread not found",
        };
      },
    };
    const dry = await reconcileT3Threads(db, { adapter, apply: false });
    assert.equal(dry.checked, 3);
    assert.equal(dry.missing.length, 2);
    assert.equal(dry.updated, 0);
    assert.equal(getTask(db, active.id).status, "running");

    const applied = await reconcileT3Threads(db, { adapter, apply: true });
    assert.equal(applied.updated, 2);
    assert.equal(getTask(db, active.id).status, "lost");
    assert.equal(getTask(db, active.id).thread_id, null);
    assert.equal(getTask(db, active.id).thread_link, null);
    assert.equal(getTask(db, done.id).thread_id, null);
    assert.equal(getTask(db, done.id).thread_link, null);
    assert.equal(getTask(db, live.id).status, "running");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon auto thread reconcile marks missing active threads lost", async () => {
  const dir = tempDir();
  const config = testConfig(dir);
  const db = openDb(config.dbPath);
  try {
    const task = addTask(db, {
      title: "missing active thread",
      brief: "x",
      adapter: "t3",
      projectPath: dir,
    });
    updateTask(db, task.id, {
      status: "running",
      thread_id: "thread-missing",
      thread_link: "https://example.test/missing",
      lease_until: Date.now() + 60_000,
    });
    const adapter = {
      async show() {
        return { state: "unknown", error: "thread not found" };
      },
    };
    const daemon = new Daemon({
      db,
      config,
      adapters: { t3: adapter },
      logger: quiet,
    });
    await daemon.reconcileThreads("test");
    const lost = getTask(db, task.id);
    assert.equal(lost.status, "lost");
    assert.equal(lost.thread_id, null);
    assert.equal(lost.thread_link, null);
    assert.match(lost.error, /not restarted automatically/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update version comparison and cache are deterministic", () => {
  assert.equal(compareVersions("1.3.1", "1.3.0"), 1);
  assert.equal(compareVersions("v1.3.0", "1.3.0"), 0);
  assert.equal(compareVersions("1.2.9", "1.3.0"), -1);
  const dir = tempDir();
  const db = openDb(path.join(dir, "update.db"));
  try {
    setMeta(db, "update_check", JSON.stringify({
      current: "1.3.0",
      latest: "1.3.1",
      updateAvailable: true,
      checkedAt: Date.now(),
      registry: "https://registry.npmjs.org",
      source: "npm",
      error: null,
    }));
    const update = readUpdateCache(db);
    assert.equal(update.latest, "1.3.1");
    assert.equal(update.updateAvailable, true);
    assert.equal(update.stale, false);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update checker fetches npm latest and caches the result", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "foreman-ops", version: "9.9.9" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = tempDir();
  const db = openDb(path.join(dir, "update-fetch.db"));
  try {
    const { port } = server.address();
    const update = await checkForUpdate(db, {
      force: true,
      registry: `http://127.0.0.1:${port}`,
    });
    assert.equal(update.latest, "9.9.9");
    assert.equal(update.updateAvailable, true);
    assert.equal(update.error, null);
    const cached = readUpdateCache(db);
    assert.equal(cached.latest, "9.9.9");
    assert.equal(cached.updateAvailable, true);
  } finally {
    db.close();
    await new Promise((resolve) => server.close(resolve));
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
