#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const statePath =
  process.env.FOREMAN_FAKE_T3_STATE ||
  path.join(process.cwd(), "fake-t3-leader-state.json");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf8"))
    : { starts: 0, sends: 0 };
  if (args[0] === "thread" && args[1] === "start") {
    state.starts += 1;
    state.lastStartPrompt = stdin.slice(0, 200);
    fs.writeFileSync(statePath, JSON.stringify(state));
    console.log(
      JSON.stringify({
        threadId: "mcp:fake-leader-session",
        reply: JSON.stringify({
          reply: "first leader reply",
          actions: [],
        }),
      }),
    );
    return;
  }
  if (args[0] === "thread" && args[1] === "send") {
    state.sends += 1;
    state.lastSendThread = args[2];
    state.lastSendPrompt = stdin.slice(0, 200);
    fs.writeFileSync(statePath, JSON.stringify(state));
    console.log(
      JSON.stringify({
        reply: "second leader reply",
        actions: [],
      }),
    );
    return;
  }
  console.error(`unexpected t3 args: ${args.join(" ")}`);
  process.exit(1);
});
