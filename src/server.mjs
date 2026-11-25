import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAuthToken, hashToken, isLoopbackHost, tokenFromRequest, tokenMatches } from "./auth.mjs";
import {
  addTask,
  counts,
  dashboardTasks,
  getMasterFc,
  getMeta,
  getTask,
  getWorkerByTokenHash,
  getWorkerModelRoutes,
  importRunningTask,
  recentChat,
  recentEvents,
  revokeWorkerToken,
  setMasterFc,
  setMasterProject,
  setMeta,
  setWorkerStatus,
  stateVersion,
  touchWorker,
} from "./db.mjs";
import {
  claimTasksForWorker,
  registerWorker,
  releaseWorkerTask,
  touchWorkerTask,
  workerAssignments,
  workerSnapshot,
} from "./worker-broker.mjs";
import { validateArtifactPath } from "./projects.mjs";
import {
  assertT3ProviderId,
  mergeModelRoutes,
  planTaskModel,
} from "./model-policy.mjs";
import { WORKER_PROTOCOL_VERSION } from "./protocol.mjs";
import {
  ensureDefaultProject,
  listProjectSummaries,
  projectNameMap,
  resolveTaskProject,
} from "./registry.mjs";
import { buildStateCard, contractLabel, formatDuration, shortPath, STATUS_LABEL } from "./state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "..", "public", "index.html");

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function hostnameFromHeader(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 0 ? raw.slice(1, end) : raw;
  }
  return raw.split(":")[0];
}

function hostAllowed(req, config) {
  if (config.authToken) return true;
  if (!isLoopbackHost(config.host)) return true;
  const hostname = hostnameFromHeader(req.headers.host);
  return LOOPBACK_HOSTS.has(hostname);
}

function originAllowed(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.authToken) return true;
  if (!isLoopbackHost(config.host)) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function requireJson(req) {
  const type = String(req.headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (type !== "application/json") {
    throw httpError(415, "content-type must be application/json");
  }
}

function requireWorkerMode(config) {
  if (config.executionMode !== "worker") {
    throw httpError(409, "worker mode is disabled; start with --execution worker");
  }
}

function resolveWorkerId(req, body = {}) {
  const authId = req.workerAuth?.id || null;
  const bodyId = String(body.workerId || body.id || "").trim();
  if (authId && bodyId && authId !== bodyId) {
    throw httpError(403, "worker token does not match workerId");
  }
  const id = authId || bodyId;
  if (!id) throw httpError(400, "workerId is required");
  return id;
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError(400, "invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function decorateTask(task, config, projectNames = null) {
  const ts = Date.now();
  const elapsedMs =
    task.status === "running"
      ? ts - (task.started_at || task.created_at)
      : task.status === "queued"
        ? ts - task.created_at
        : task.status === "blocked"
          ? (task.heartbeat_at || task.updated_at || ts) -
            (task.started_at || task.created_at)
          : (task.finished_at || ts) - (task.started_at || task.created_at);
  return {
    ...task,
    statusLabel: STATUS_LABEL[task.status] || task.status,
    elapsed: formatDuration(elapsedMs),
    elapsedMs,
    heartbeatAge: task.heartbeat_at
      ? formatDuration(ts - task.heartbeat_at)
      : null,
    projectShort: shortPath(config, task.project_path),
    projectName: projectNames?.get(task.project_id) || null,
    contractLabel: contractLabel(task),
  };
}

function buildState({ db, config, daemon, leader }) {
  const names = projectNameMap(db);
  const masterThreadId = getMeta(db, "master_thread_id");
  const masterFc = masterThreadId ? getMasterFc(db, masterThreadId) : null;
  return {
    ok: true,
    now: Date.now(),
    goal: config.goal,
    counts: counts(db),
    projects: listProjectSummaries(db, config),
    workers: workerSnapshot(db),
    tasks: dashboardTasks(db, { terminalLimit: 180 }).map((task) =>
      decorateTask(task, config, names),
    ),
    events: recentEvents(db, 40),
    chat: recentChat(db, 60),
    leader: {
      mode: config.leaderMode,
      provider: config.leaderProvider || null,
      model: config.leaderModel,
      effort: config.leaderEffort || null,
      masterThreadId: masterThreadId || null,
      masterFc,
    },
    daemon: daemon ? daemon.snapshot() : null,
    stateCard: buildStateCard(db, config),
    auth: { required: Boolean(config.authToken) },
    config: {
      adapter: config.adapter,
      executionMode: config.executionMode,
      concurrency: config.concurrency,
      tickMs: config.tickMs,
      leaderMode: config.leaderMode,
      t3Bin: config.t3Bin,
      t3Project: config.t3Project,
      projectPath: config.projectPath,
      allowedProjectRoots: config.allowedProjectRoots,
    },
  };
}

export function startServer({ db, config, daemon, leader, logger = console }) {
  let htmlCache = null;
  let htmlMtime = 0;

  ensureDefaultProject(db, config);
  ensureAuthToken(config, logger);
  if (config.authToken) {
    logger.info(
      `[server] auth enabled (${isLoopbackHost(config.host) ? "token" : `token file ${config.authTokenPath}`})`,
    );
  } else if (!isLoopbackHost(config.host)) {
    logger.warn(
      "[server] auth disabled by FOREMAN_ALLOW_INSECURE; do not expose this port to an untrusted network",
    );
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const pathname = url.pathname;

      if (!hostAllowed(req, config)) {
        json(res, 403, { ok: false, error: "host not allowed" });
        return;
      }
      if (!originAllowed(req, config)) {
        json(res, 403, { ok: false, error: "origin not allowed" });
        return;
      }

      if (pathname.startsWith("/api/") && config.authToken) {
        const provided = tokenFromRequest(req);
        const dashboardAuth = tokenMatches(config.authToken, provided);
        const isWorkerPath = pathname.startsWith("/api/worker/");
        const workerAuth =
          !dashboardAuth && isWorkerPath
            ? getWorkerByTokenHash(db, hashToken(provided))
            : null;
        if (!dashboardAuth && !workerAuth) {
          res.writeHead(401, {
            ...SECURITY_HEADERS,
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "www-authenticate": 'Bearer realm="foreman"',
          });
          res.end(
            JSON.stringify({
              ok: false,
              error: "unauthorized",
              authRequired: true,
            }),
          );
          return;
        }
        if (workerAuth) req.workerAuth = workerAuth;
      }

      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const stat = fs.statSync(HTML_PATH);
        if (!htmlCache || stat.mtimeMs !== htmlMtime) {
          htmlCache = fs.readFileSync(HTML_PATH);
          htmlMtime = stat.mtimeMs;
        }
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(htmlCache);
        return;
      }

      if (req.method === "GET" && pathname === "/api/state") {
        const etag = `W/"${stateVersion(db)}"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, {
            ...SECURITY_HEADERS,
            etag,
            "cache-control": "no-store",
          });
          res.end();
          return;
        }
        json(res, 200, buildState({ db, config, daemon, leader }), { etag });
        return;
      }

      if (req.method === "GET" && pathname === "/api/master/fc") {
        const threadId = url.searchParams.get("threadId");
        const masterThreadId = getMeta(db, "master_thread_id");
        const selectedId = threadId || masterThreadId;
        json(res, 200, {
          ok: true,
          threadId: selectedId || null,
          fc: selectedId ? getMasterFc(db, selectedId) : null,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/health") {
        json(res, 200, {
          ok: true,
          pid: process.pid,
          uptimeMs: daemon ? Date.now() - daemon.startedAt : null,
          counts: counts(db),
          db: config.dbPath,
          adapter: config.adapter,
          executionMode: config.executionMode,
          leaderMode: config.leaderMode,
          workerProtocolVersion: WORKER_PROTOCOL_VERSION,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/projects") {
        json(res, 200, {
          ok: true,
          projects: listProjectSummaries(db, config),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/workers") {
        json(res, 200, { ok: true, workers: workerSnapshot(db) });
        return;
      }

      const workerActionMatch = pathname.match(
        /^\/api\/workers\/([^/]+)\/(drain|resume|revoke)$/,
      );
      if (req.method === "POST" && workerActionMatch) {
        const id = decodeURIComponent(workerActionMatch[1]);
        const action = workerActionMatch[2];
        let worker;
        if (action === "drain") {
          worker = setWorkerStatus(db, id, "draining");
        } else if (action === "resume") {
          worker = setWorkerStatus(db, id, "online");
        } else {
          worker = revokeWorkerToken(db, id);
          if (worker) worker = setWorkerStatus(db, id, "offline");
        }
        if (!worker) throw httpError(404, `worker not found: ${id}`);
        const view = workerSnapshot(db).find((item) => item.id === id);
        json(res, 200, { ok: true, worker: view });
        return;
      }

      if (req.method === "POST" && pathname === "/api/worker/register") {
        requireWorkerMode(config);
        requireJson(req);
        const body = await readBody(req);
        const workerId = resolveWorkerId(req, body);
        const worker = registerWorker(db, { ...body, id: workerId });
        const view = workerSnapshot(db).find((item) => item.id === worker.id);
        json(res, 200, { ok: true, worker: view });
        return;
      }

      if (req.method === "POST" && pathname === "/api/worker/heartbeat") {
        requireWorkerMode(config);
        requireJson(req);
        const body = await readBody(req);
        const workerId = resolveWorkerId(req, body);
        const worker = touchWorker(db, workerId, {
          running: Number(body.running) || 0,
        });
        if (!worker) throw httpError(404, `unknown worker: ${workerId}`);
        const view = workerSnapshot(db).find((item) => item.id === worker.id);
        json(res, 200, { ok: true, worker: view });
        return;
      }

      if (req.method === "POST" && pathname === "/api/worker/claim") {
        requireWorkerMode(config);
        requireJson(req);
        const body = await readBody(req);
        const workerId = resolveWorkerId(req, body);
        const tasks = claimTasksForWorker(db, config, {
          workerId,
          limit: Number(body.limit) || undefined,
        });
        json(res, 200, { ok: true, tasks });
        return;
      }

      if (req.method === "POST" && pathname === "/api/worker/assignments") {
        requireWorkerMode(config);
        requireJson(req);
        const body = await readBody(req);
        const workerId = resolveWorkerId(req, body);
        json(res, 200, {
          ok: true,
          tasks: workerAssignments(db, workerId),
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/worker/report") {
        requireWorkerMode(config);
        requireJson(req);
        const body = await readBody(req);
        const workerId = resolveWorkerId(req, body);
        const taskId = String(body.taskId || "").trim();
        const state = String(body.state || "").trim();
        const attemptId = body.attemptId
          ? String(body.attemptId).slice(0, 200)
          : null;
        if (!taskId) throw httpError(400, "taskId is required");
        if (state === "running") {
          const task = touchWorkerTask(db, config, {
            workerId,
            taskId,
            attemptId,
            threadId: body.threadId,
          });
          json(res, 200, { ok: true, task });
          return;
        }
        if (!["done", "failed", "blocked", "cancelled"].includes(state)) {
          throw httpError(400, `unknown worker state: ${state}`);
        }
        if (!daemon) throw httpError(503, "daemon is not running");
        const task = getTask(db, taskId);
        if (!task) throw httpError(404, `task not found: ${taskId}`);
        if (task.worker_id !== workerId) {
          throw httpError(409, `task ${taskId} is not assigned to ${workerId}`);
        }
        if (task.attempt_id && task.attempt_id !== attemptId) {
          throw httpError(409, `stale attempt for ${taskId}`);
        }
        if (["done", "failed", "cancelled"].includes(task.status)) {
          json(res, 200, { ok: true, task });
          return;
        }
        await daemon.finalize(task, {
          state,
          result: body.result,
          error: body.error,
          contract: body.contract,
        });
        releaseWorkerTask(db, workerId);
        json(res, 200, { ok: true, task: getTask(db, taskId) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/tasks/import") {
        requireJson(req);
        const body = await readBody(req);
        const input = body.task && typeof body.task === "object"
          ? body.task
          : body;
        const title = String(input.title || "").trim();
        const threadId = String(body.threadId || input.threadId || "").trim();
        if (!title) throw httpError(400, "title is required");
        if (!threadId) throw httpError(400, "threadId is required");
        if (String(input.adapter || "t3") !== "t3") {
          throw httpError(400, "imported tasks must use the t3 adapter");
        }
        const resolved = resolveTaskProject(db, config, {
          project: input.projectId,
          projectPath: input.projectPath,
        });
        const task = importRunningTask(db, {
          ...input,
          title,
          adapter: "t3",
          projectPath: resolved.projectPath,
          projectId: resolved.project?.id ?? null,
          threadId,
          threadLink: body.threadLink || input.threadLink || null,
          childRunId: body.childRunId || input.childRunId || null,
          leaseMs: config.t3LeaseMs,
        });
        json(res, 201, { ok: true, task });
        return;
      }

      if (req.method === "POST" && pathname === "/api/tasks") {
        requireJson(req);
        const body = await readBody(req);
        const title = String(body.title || "").trim();
        if (!title) throw httpError(400, "title is required");
        const resolvedProject = resolveTaskProject(db, config, {
          project: body.projectId || body.project,
          projectPath: body.projectPath,
        });
        const projectPath = resolvedProject.projectPath;
        const adapter = String(
          body.adapter || resolvedProject.adapter || config.adapter,
        );
        if (!["mock", "t3"].includes(adapter)) {
          throw httpError(400, `unknown adapter: ${adapter}`);
        }
        const completionToken = body.completionToken
          ? String(body.completionToken).trim().slice(0, 200)
          : null;
        const artifactPath = body.artifactPath
          ? String(body.artifactPath).trim().slice(0, 500)
          : null;
        const safeArtifactPath = validateArtifactPath(projectPath, artifactPath);
        const artifactContains = body.artifactContains
          ? String(body.artifactContains).slice(0, 4000)
          : null;
        const requireDiff = body.requireDiff === true;
        const workerId = body.workerId
          ? String(body.workerId).trim().slice(0, 200)
          : null;
        const provider = body.provider
          ? String(body.provider).trim().slice(0, 120)
          : null;
        const masterThreadId = body.masterThreadId
          ? String(body.masterThreadId).slice(0, 300)
          : null;
        const masterFc = masterThreadId ? getMasterFc(db, masterThreadId) : null;
        const routes = mergeModelRoutes(
          config.workerModelRoutes,
          getWorkerModelRoutes(db, null),
          getWorkerModelRoutes(db, masterThreadId),
        );
        const brief = String(body.brief || title);
        const plan = planTaskModel(config, {
          title,
          brief,
          adapter,
          provider,
          category: body.category,
          model: body.model,
          effort: body.effort || body.thoughtLevel,
          routes,
          masterFc,
          modelOverride: body.modelOverride === true || Boolean(body.model),
        });
        let taskProvider;
        try {
          taskProvider = assertT3ProviderId(
            plan.provider || config.forceProvider || provider || null,
          );
        } catch (error) {
          throw httpError(400, error.message);
        }
        const task = addTask(db, {
          title,
          brief,
          priority: Number(body.priority) || 50,
          adapter,
          projectPath,
          projectId: resolvedProject.project?.id ?? null,
          workerId,
          masterThreadId,
          provider: taskProvider,
          model: plan.model,
          effort: plan.effort,
          maxAttempts: Number(body.maxAttempts) || config.maxAttempts,
          completionToken,
          artifactPath: safeArtifactPath,
          artifactContains,
          requireDiff,
        });
        json(res, 201, { ok: true, task });
        return;
      }

      const actionMatch = pathname.match(
        /^\/api\/tasks\/([^/]+)\/(cancel|retry|resume)$/,
      );
      if (req.method === "POST" && actionMatch) {
        if (!daemon) throw httpError(503, "daemon is not running");
        const id = decodeURIComponent(actionMatch[1]);
        const action = actionMatch[2];
        if (action === "cancel") {
          const task = await daemon.cancel(id, "cancelled from dashboard");
          json(res, 200, { ok: true, task });
        } else if (action === "resume") {
          const task = daemon.resume(id);
          json(res, 200, { ok: true, task });
        } else {
          const task = daemon.retry(id);
          json(res, 200, { ok: true, task });
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/ask") {
        requireJson(req);
        const body = await readBody(req);
        const message = String(body.message || "").trim().slice(0, 8000);
        if (!message) throw httpError(400, "message is required");
        const masterThreadId = body.masterThreadId
          ? String(body.masterThreadId).slice(0, 300)
          : null;
        if (masterThreadId && body.masterProject) {
          setMasterProject(
            db,
            masterThreadId,
            String(body.masterProject).slice(0, 1000),
          );
        }
        let leaderOverride =
          body.leader && typeof body.leader === "object"
            ? {
                provider: body.leader.provider
                  ? String(body.leader.provider).slice(0, 120)
                  : undefined,
                model: body.leader.model
                  ? String(body.leader.model).slice(0, 240)
                  : undefined,
                effort: body.leader.effort
                  ? String(body.leader.effort).slice(0, 40)
                  : undefined,
              }
            : null;
        if (masterThreadId) {
          if (!getMeta(db, "master_thread_id")) {
            setMeta(db, "master_thread_id", masterThreadId);
          }
          if (leaderOverride) {
            setMasterFc(db, masterThreadId, leaderOverride);
            const primary = getMeta(db, "master_thread_id");
            if (!primary || !getMasterFc(db, primary)) {
              setMeta(db, "master_thread_id", masterThreadId);
            }
          } else {
            leaderOverride = getMasterFc(db, masterThreadId);
          }
        }
        const result = await leader.turn({
          message,
          trigger: "user",
          deferAddTasks: body.delegateTasks === true,
          leader: leaderOverride,
          masterThreadId,
        });
        json(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && pathname === "/api/inbox/consume") {
        // Manual drain is intentionally not exposed. The leader loop owns it.
        throw httpError(404, "not found");
      }

      json(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      const status = error.status || 500;
      if (!res.headersSent) {
        json(res, status, { ok: false, error: error.message });
      } else {
        res.end();
      }
      if (status >= 500) logger.error("[server] request failed", error);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;
    server.maxConnections = 128;
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      const port = server.address()?.port ?? config.port;
      logger.info(
        `[server] http://${config.host}:${port} (dashboard + JSON API)`,
      );
      resolve({
        server,
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
