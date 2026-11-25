import fs from "node:fs";
import path from "node:path";
import { addProject, getProject, listProjects } from "./db.mjs";
import { resolveProjectPath } from "./projects.mjs";

export function ensureDefaultProject(db, config) {
  const projects = listProjects(db, { includeDisabled: true });
  const existing = projects.find(
    (project) => path.resolve(config.cwd, project.local_path) === config.projectPath,
  );
  if (existing) return existing;
  const defaultProject = getProject(db, "default");
  if (defaultProject) return defaultProject;
  try {
    return addProject(db, {
      name: "default",
      path: config.projectPath,
      adapter: config.adapter,
    });
  } catch (error) {
    if (/already exists/.test(error.message)) return getProject(db, "default");
    throw error;
  }
}

export function resolveTaskProject(db, config, { project, projectPath } = {}) {
  if (project) {
    const row = getProject(db, project);
    if (!row) {
      const error = new Error(`unknown project: ${project}`);
      error.status = 404;
      throw error;
    }
    if (!Number(row.enabled)) {
      const error = new Error(`project is disabled: ${project}`);
      error.status = 409;
      throw error;
    }
    const localPath = path.resolve(config.cwd, row.local_path);
    let stat;
    try {
      stat = fs.statSync(localPath);
    } catch {
      const error = new Error(`project path is not a directory: ${localPath}`);
      error.status = 400;
      throw error;
    }
    if (!stat.isDirectory()) {
      const error = new Error(`project path is not a directory: ${localPath}`);
      error.status = 400;
      throw error;
    }
    return {
      project: row,
      projectPath: localPath,
      adapter: row.default_adapter || null,
    };
  }

  const resolved = resolveProjectPath(config, projectPath);
  const row =
    listProjects(db, { includeDisabled: true }).find(
      (entry) => path.resolve(config.cwd, entry.local_path) === resolved,
    ) || null;
  if (row && !Number(row.enabled)) {
    const error = new Error(`project is disabled: ${row.name}`);
    error.status = 409;
    throw error;
  }
  return {
    project: row,
    projectPath: resolved,
    adapter: row?.default_adapter || null,
  };
}

export function projectSummary(project, config) {
  if (!project) return null;
  const localPath = path.resolve(config.cwd, project.local_path);
  const relative = path.relative(config.cwd, localPath);
  return {
    id: project.id,
    name: project.name,
    path: relative && !relative.startsWith("..") ? relative : localPath,
    pathShort:
      relative === ""
        ? "."
        : relative && !relative.startsWith("..")
          ? relative
          : localPath,
    adapter: project.default_adapter || null,
    enabled: Boolean(project.enabled),
  };
}

export function listProjectSummaries(db, config) {
  return listProjects(db, { includeDisabled: true }).map((project) =>
    projectSummary(project, config),
  );
}

export function projectNameMap(db) {
  return new Map(
    listProjects(db, { includeDisabled: true }).map((project) => [
      project.id,
      project.name,
    ]),
  );
}
