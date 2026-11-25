import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// A task can declare a completion contract. A worker "done" outcome only
// becomes a ledger "done" if every declared check passes; otherwise the task
// is blocked for a human/leader decision.

export function hasContract(task) {
  return Boolean(
    String(task.completion_token || "").trim() ||
      String(task.artifact_path || "").trim() ||
      String(task.artifact_contains || "").trim() ||
      Number(task.require_diff || 0) === 1,
  );
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export function verifyContract(task, outcome) {
  const token = String(task.completion_token || "").trim();
  const artifact = String(task.artifact_path || "").trim();
  const contains =
    task.artifact_contains === null || task.artifact_contains === undefined
      ? ""
      : String(task.artifact_contains);
  const requireDiff = Number(task.require_diff || 0) === 1;
  const checks = [];

  if (!token && !artifact && !contains && !requireDiff) {
    return { ok: true, checks };
  }
  if (contains && !artifact) {
    return {
      ok: false,
      reason: "artifactContains requires an artifactPath",
      checks: [{ type: "artifact_contains", contains, ok: false }],
    };
  }

  const result = String(outcome?.result ?? "");

  if (token) {
    const lines = result
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const ok =
      result.trim().toLowerCase() === token.toLowerCase() ||
      lines.some((line) => line.toLowerCase() === token.toLowerCase());
    checks.push({ type: "token", token, ok });
    if (!ok) {
      return {
        ok: false,
        reason: `completion token "${token}" was not a standalone line in the worker result`,
        checks,
      };
    }
  }

  if (artifact) {
    const root = path.resolve(task.project_path);
    const file = path.resolve(root, artifact);
    if (!inside(root, file)) {
      return {
        ok: false,
        reason: `artifact path escapes the project: ${artifact}`,
        checks,
      };
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      checks.push({ type: "artifact", artifact, ok: false });
      return {
        ok: false,
        reason: `artifact not found: ${artifact}`,
        checks,
      };
    }
    if (!stat.isFile()) {
      checks.push({ type: "artifact", artifact, ok: false });
      return {
        ok: false,
        reason: `artifact is not a file: ${artifact}`,
        checks,
      };
    }
    if (stat.size === 0) {
      checks.push({ type: "artifact", artifact, ok: false });
      return {
        ok: false,
        reason: `artifact is empty: ${artifact}`,
        checks,
      };
    }
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(file);
    if (!inside(realRoot, realFile)) {
      checks.push({ type: "artifact", artifact, ok: false });
      return {
        ok: false,
        reason: `artifact escapes the project through a symlink: ${artifact}`,
        checks,
      };
    }
    checks.push({ type: "artifact", artifact, ok: true });
    if (contains) {
      let text = "";
      try {
        text = fs.readFileSync(realFile, "utf8");
      } catch (error) {
        return {
          ok: false,
          reason: `artifact ${artifact} is unreadable: ${error.message}`,
          checks,
        };
      }
      const ok = text.includes(contains);
      checks.push({ type: "artifact_contains", contains, ok });
      if (!ok) {
        return {
          ok: false,
          reason: `artifact ${artifact} does not contain "${contains}"`,
          checks,
        };
      }
    }
  }

  if (requireDiff) {
    const status = spawnSync(
      "git",
      ["-C", task.project_path, "status", "--porcelain"],
      { encoding: "utf8", timeout: 5000 },
    );
    const ok = status.status === 0 && Boolean(status.stdout.trim());
    checks.push({ type: "diff", ok });
    if (!ok) {
      return {
        ok: false,
        reason: "no git diff/untracked change in the project",
        checks,
      };
    }
  }

  return { ok: true, checks };
}
