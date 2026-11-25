#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const outIndex = args.findIndex(
  (arg) => arg === "-o" || arg === "--output-last-message",
);
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;
const payload = {
  reply: "fake codex leader reply",
  actions: [
    {
      type: "add_task",
      title: "codex-added task",
      brief: "created by fake codex",
      priority: 10,
    },
  ],
};
if (outFile) {
  fs.writeFileSync(outFile, JSON.stringify(payload));
}
console.log("fake codex ran");
