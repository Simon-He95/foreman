import fs from "node:fs";
import path from "node:path";

function inside(root, target) {
  const rel = path.relative(root, target);
  return (
    rel === "" ||
    (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
  );
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Used by the HTTP API and the leader. A model or a remote browser must not be
// able to point a worker at an arbitrary directory on the control-plane host.
export function resolveProjectPath(config, requested) {
  const raw =
    requested === undefined || requested === null || String(requested).trim() === ""
      ? config.projectPath
      : String(requested).trim();
  const target = path.resolve(config.cwd, raw);

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw fail(400, `projectPath is not a directory: ${target}`);
  }
  if (!stat.isDirectory()) {
    throw fail(400, `projectPath is not a directory: ${target}`);
  }

  let targetReal;
  try {
    targetReal = fs.realpathSync(target);
  } catch {
    throw fail(400, `projectPath cannot be resolved: ${target}`);
  }

  const roots = [...(config.allowedProjectRoots || []), config.projectPath].filter(
    Boolean,
  );
  for (const root of roots) {
    const rootPath = path.resolve(config.cwd, String(root));
    let rootReal;
    try {
      rootReal = fs.realpathSync(rootPath);
    } catch {
      continue;
    }
    if (inside(rootReal, targetReal)) return target;
  }

  throw fail(403, `projectPath is outside allowed roots: ${target}`);
}

export function validateArtifactPath(projectPath, artifactPath) {
  if (!artifactPath) return null;
  const root = path.resolve(projectPath);
  const file = path.resolve(root, String(artifactPath));
  if (!inside(root, file)) {
    throw fail(400, `artifactPath escapes the project: ${artifactPath}`);
  }
  return String(artifactPath);
}

export function projectRoots(config) {
  return [
    ...new Set(
      [...(config.allowedProjectRoots || []), config.projectPath]
        .filter(Boolean)
        .map((root) => path.resolve(config.cwd, String(root))),
    ),
  ];
}
