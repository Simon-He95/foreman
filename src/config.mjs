import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function list(value, fallback) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (value === undefined || value === null || value === "") return fallback;
  return String(value)
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stringMap(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [String(key).trim(), String(item).trim()])
        .filter(([key, item]) => key && item),
    );
  }
  if (typeof value === "string" && value.trim()) {
    return Object.fromEntries(
      value
        .split(/[,;]/)
        .map((pair) => pair.split("="))
        .filter((parts) => parts.length === 2 && parts[0].trim() && parts[1].trim())
        .map(([key, item]) => [key.trim(), item.trim()]),
    );
  }
  return fallback;
}

function findT3Runtime() {
  const root = path.join(os.homedir(), ".t3", "runtime", "versions");
  try {
    const versions = fs
      .readdirSync(root)
      .filter((name) => !name.includes(".staging-") && !name.endsWith(".lock"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const version of versions.reverse()) {
      const bin = path.join(root, version, process.platform === "win32" ? "t3.exe" : "t3");
      if (fs.existsSync(bin)) return bin;
    }
  } catch {
    // no runtime yet
  }
  return null;
}

function which(bin) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveT3Bin(cwd, preferred) {
  if (preferred) {
    return preferred.includes(path.sep) ? path.resolve(cwd, preferred) : preferred;
  }
  const local = path.join(cwd, "node_modules", ".bin", "t3");
  if (fs.existsSync(local)) return local;
  return findT3Runtime() || which("t3") || "t3";
}

function resolveClaudeBin(cwd, preferred) {
  const candidates = [
    preferred,
    path.join(os.homedir(), ".npm-global", "bin", "claude"),
    path.join(os.homedir(), ".bun", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "claude",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate.includes(path.sep)) {
      const found = which(candidate);
      if (found) return found;
      continue;
    }
    const resolved = path.resolve(cwd, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return "claude";
}

function resolveCodexBin(cwd, preferred) {
  const candidates = [
    preferred,
    path.join(cwd, "node_modules", ".bin", "codex"),
    path.join(os.homedir(), ".npm-global", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "codex",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate.includes(path.sep)) {
      const found = which(candidate);
      if (found) return found;
      continue;
    }
    const resolved = path.resolve(cwd, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return "codex";
}

function resolveDimBin(preferred) {
  const candidates = [
    preferred,
    which("dim"),
    "/Applications/DimAgent.app/Contents/Resources/runtime/cli/dim",
    "/usr/local/bin/dim",
    "dim",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate.includes(path.sep)) {
      const found = which(candidate);
      if (found) return found;
      continue;
    }
    if (fs.existsSync(candidate)) return candidate;
  }
  return "dim";
}

export function loadConfig(overrides = {}) {
  const cwd = path.resolve(overrides.cwd || process.cwd());
  const configPath =
    process.env.FOREMAN_CONFIG || path.join(cwd, "foreman.config.json");
  let file = {};
  if (!overrides.ignoreConfigFile && fs.existsSync(configPath)) {
    file = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  const pick = (key, env, fallback) =>
    overrides[key] ?? process.env[env] ?? file[key] ?? fallback;

  const dataDir = path.resolve(
    cwd,
    pick("dataDir", "FOREMAN_DATA_DIR", ".foreman"),
  );
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch {
    // best effort; do not fail on filesystems without POSIX modes
  }

  const projectPath = path.resolve(
    cwd,
    pick("projectPath", "FOREMAN_PROJECT", "."),
  );

  const allowedProjectRoots = list(
    pick("allowedProjectRoots", "FOREMAN_ALLOWED_ROOTS", null),
    [cwd],
  );

  const authToken = String(
    pick("authToken", "FOREMAN_TOKEN", "") || "",
  ).trim();

  const t3Project = path.resolve(
    cwd,
    pick("t3Project", "FOREMAN_T3_PROJECT", projectPath),
  );

  const port = num(pick("port", "FOREMAN_PORT", 3777), 3777);

  const config = {
    cwd,
    configPath,
    dataDir,
    dbPath: path.join(dataDir, "foreman.db"),
    pidPath: path.join(dataDir, "foreman.pid"),
    logPath: path.join(dataDir, "foreman.log"),
    projectPath,
    allowedProjectRoots,
    adapter: pick("adapter", "FOREMAN_ADAPTER", "mock"),
    executionMode: pick("executionMode", "FOREMAN_EXECUTION_MODE", "local"),
    workerId: pick(
      "workerId",
      "FOREMAN_WORKER_ID",
      `${os.hostname().replace(/[^a-zA-Z0-9_.-]/g, "-")}-1`,
    ),
    workerCapacity: num(
      pick("workerCapacity", "FOREMAN_WORKER_CAPACITY", 1),
      1,
    ),
    workerProjects: list(
      pick("workerProjects", "FOREMAN_WORKER_PROJECTS", null),
      [],
    ),
    workerProjectMap: stringMap(
      pick("workerProjectMap", "FOREMAN_WORKER_PROJECT_MAP", null),
      {},
    ),
    workerToken: pick("workerToken", "FOREMAN_WORKER_TOKEN", null),
    workerTokenFile: pick(
      "workerTokenFile",
      "FOREMAN_WORKER_TOKEN_FILE",
      null,
    ),
    workerPollMs: num(
      pick("workerPollMs", "FOREMAN_WORKER_POLL_MS", 1000),
      1000,
    ),
    concurrency: num(pick("concurrency", "FOREMAN_CONCURRENCY", 3), 3),
    tickMs: num(pick("tickMs", "FOREMAN_TICK_MS", 1000), 1000),
    leaseMs: num(pick("leaseMs", "FOREMAN_LEASE_MS", 30000), 30000),
    maxAttempts: num(pick("maxAttempts", "FOREMAN_MAX_ATTEMPTS", 2), 2),
    retryDelayMs: num(
      pick("retryDelayMs", "FOREMAN_RETRY_DELAY_MS", 5000),
      5000,
    ),
    leaderMode: pick("leaderMode", "FOREMAN_LEADER", "rule"),
    leaderTickMs: num(
      pick("leaderTickMs", "FOREMAN_LEADER_TICK_MS", 20000),
      20000,
    ),
    leaderModel: pick("leaderModel", "FOREMAN_LEADER_MODEL", null),
    leaderAutoDestructive: bool(
      pick("leaderAutoDestructive", "FOREMAN_LEADER_AUTO_DESTRUCTIVE", false),
      false,
    ),
    leaderTimeoutMs: num(
      pick("leaderTimeoutMs", "FOREMAN_LEADER_TIMEOUT_MS", 120000),
      120000,
    ),
    claudeBin: resolveClaudeBin(
      cwd,
      pick("claudeBin", "FOREMAN_CLAUDE_BIN", null),
    ),
    codexBin: resolveCodexBin(
      cwd,
      pick("codexBin", "FOREMAN_CODEX_BIN", null),
    ),
    codexModel: pick("codexModel", "FOREMAN_CODEX_MODEL", "gpt-6-astra"),
    dimBin: resolveDimBin(pick("dimBin", "FOREMAN_DIM_BIN", null)),
    port,
    host: pick("host", "FOREMAN_HOST", "127.0.0.1"),
    controlUrl: pick(
      "controlUrl",
      "FOREMAN_CONTROL_URL",
      `http://127.0.0.1:${port}`,
    ),
    authToken: authToken || null,
    authTokenPath: path.join(dataDir, "access-token"),
    allowInsecure: bool(
      pick("allowInsecure", "FOREMAN_ALLOW_INSECURE", false),
      false,
    ),
    goal: pick(
      "goal",
      "FOREMAN_GOAL",
      "Dispatch pending work reliably and report exactly what is running, queued, blocked, and done.",
    ),
    t3Bin: resolveT3Bin(cwd, pick("t3Bin", "FOREMAN_T3_BIN", null)),
    t3Project,
    t3Worktree: bool(pick("t3Worktree", "FOREMAN_T3_WORKTREE", true), true),
    t3WorktreeBase: pick(
      "t3WorktreeBase",
      "FOREMAN_T3_WORKTREE_BASE",
      "HEAD",
    ),
    t3Provider: pick("t3Provider", "FOREMAN_T3_PROVIDER", null),
    t3Model: pick("t3Model", "FOREMAN_T3_MODEL", null),
    modelFast: pick("modelFast", "FOREMAN_MODEL_FAST", null),
    modelStrong: pick("modelStrong", "FOREMAN_MODEL_STRONG", null),
    modelCoding: pick("modelCoding", "FOREMAN_MODEL_CODING", null),
    t3ReasoningOption: pick(
      "t3ReasoningOption",
      "FOREMAN_T3_REASONING_OPTION",
      null,
    ),
    t3LeaseMs: num(
      pick("t3LeaseMs", "FOREMAN_T3_LEASE_MS", 600000),
      600000,
    ),
    mockLeaseMs: num(
      pick("mockLeaseMs", "FOREMAN_MOCK_LEASE_MS", 30000),
      30000,
    ),
  };

  const isDimProvider = config.t3Provider === "dim";
  config.modelFast = config.modelFast || config.t3Model || null;
  config.modelStrong =
    config.modelStrong ||
    (isDimProvider ? "dimcode-api-oauth/gpt-6.2-astra" : config.modelFast);
  config.modelCoding =
    config.modelCoding ||
    (isDimProvider ? "dimcode-api-oauth/claude-opus-5-5" : config.modelFast);
  config.t3ReasoningOption =
    config.t3ReasoningOption || (isDimProvider ? "thought_level" : "effort");

  if (!["local", "worker"].includes(config.executionMode)) {
    throw new Error(
      `unknown execution mode: ${config.executionMode} (use local or worker)`,
    );
  }

  return config;
}

export function publicConfig(config) {
  const {
    dbPath,
    pidPath,
    dataDir,
    cwd,
    configPath,
    host,
    port,
    adapter,
    executionMode,
    workerId,
    workerCapacity,
    workerProjects,
    controlUrl,
    concurrency,
    tickMs,
    leaderMode,
    leaderModel,
    leaderAutoDestructive,
    claudeBin,
    codexBin,
    codexModel,
    dimBin,
    t3Bin,
    t3Project,
    t3Worktree,
    t3WorktreeBase,
    t3Provider,
    t3Model,
    modelFast,
    modelStrong,
    modelCoding,
    t3ReasoningOption,
    goal,
    projectPath,
    allowedProjectRoots,
    authToken,
    authTokenPath,
    allowInsecure,
  } = config;
  return {
    dbPath,
    pidPath,
    dataDir,
    cwd,
    configPath,
    host,
    port,
    adapter,
    executionMode,
    workerId,
    workerCapacity,
    workerProjects,
    controlUrl,
    concurrency,
    tickMs,
    leaderMode,
    leaderModel,
    leaderAutoDestructive,
    claudeBin,
    codexBin,
    codexModel,
    dimBin,
    t3Bin,
    t3Project,
    t3Worktree,
    t3WorktreeBase,
    t3Provider,
    t3Model,
    modelFast,
    modelStrong,
    modelCoding,
    t3ReasoningOption,
    goal,
    projectPath,
    allowedProjectRoots,
    authRequired: Boolean(authToken),
    authTokenPath,
    allowInsecure,
  };
}
