import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMeta, setMeta } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = "foreman-ops";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const CACHE_KEY = "update_check";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function currentVersion() {
  const packagePath = path.resolve(__dirname, "..", "package.json");
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

export function compareVersions(left, right) {
  const parse = (value) =>
    String(value || "")
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

export function readUpdateCache(db) {
  if (!db) return null;
  try {
    const raw = getMeta(db, CACHE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return {
      ...value,
      stale: !value.checkedAt || Date.now() - value.checkedAt > CACHE_TTL_MS,
    };
  } catch {
    return null;
  }
}

function writeUpdateCache(db, value) {
  if (!db) return;
  try {
    setMeta(db, CACHE_KEY, JSON.stringify(value));
  } catch {
    // Update checks must never affect the control plane.
  }
}

function registryBase(value) {
  return String(value || process.env.FOREMAN_UPDATE_REGISTRY || DEFAULT_REGISTRY)
    .trim()
    .replace(/\/+$/, "");
}

export async function checkForUpdate(
  db,
  {
    force = false,
    registry = DEFAULT_REGISTRY,
    packageName = PACKAGE_NAME,
    timeoutMs = 8000,
  } = {},
) {
  const current = currentVersion();
  const cached = readUpdateCache(db);
  if (!force && cached && !cached.stale) {
    return { ...cached, cached: true };
  }

  const base = registryBase(registry);
  const url = `${base}/${encodeURIComponent(packageName)}/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`registry returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    const latest = String(payload.version || "").trim();
    if (!latest) throw new Error("registry response has no version");
    const value = {
      current,
      latest,
      updateAvailable: compareVersions(latest, current) > 0,
      checkedAt: Date.now(),
      registry: base,
      source: "npm",
      error: null,
    };
    writeUpdateCache(db, value);
    return value;
  } catch (error) {
    const value = {
      current,
      latest: cached?.latest || null,
      updateAvailable: Boolean(cached?.updateAvailable),
      checkedAt: Date.now(),
      registry: base,
      source: "npm",
      error: error.name === "AbortError" ? "registry check timed out" : error.message,
    };
    writeUpdateCache(db, value);
    return value;
  } finally {
    clearTimeout(timer);
  }
}

export function updateSummary(update) {
  if (!update) return "尚未检查更新";
  if (update.error) return `检查失败：${update.error}`;
  if (update.updateAvailable) {
    return `发现新版本 ${update.latest}（当前 ${update.current}）`;
  }
  return `已是最新版本 ${update.current}`;
}
