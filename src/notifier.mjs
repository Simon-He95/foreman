import { spawn } from "node:child_process";
import { getMeta } from "./db.mjs";

function clip(text, max = 3000) {
  const value = String(text ?? "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function notifyMaster(db, config, text) {
  let threadId = null;
  try {
    threadId = getMeta(db, "master_thread_id");
  } catch {
    return false;
  }
  if (!threadId) return false;
  const body = `📣 Foreman：${clip(text, 3000)}`;
  try {
    const child = spawn(
      config.t3Bin,
      ["thread", "send", threadId, body],
      {
        cwd: config.cwd,
        env: { ...process.env },
        stdio: "ignore",
        detached: true,
      },
    );
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
