#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const statePath =
    process.env.FOREMAN_FAKE_T3_MASTER_STATE ||
    path.join(process.cwd(), "fake-t3-master-state.json");
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      argv: process.argv.slice(2),
      stdin,
    }),
  );
  console.log(
    JSON.stringify({
      threadId: "mcp:fake-master",
      reply: "ok",
    }),
  );
});
