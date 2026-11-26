#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  if (input.includes("【按需查询结果")) {
    const match = input.match(/RESULT: ([^\n]+)/);
    console.log(
      JSON.stringify({
        reply: `查到详情：${match ? match[1].trim() : "没有结果"}`,
        actions: [],
      }),
    );
    return;
  }
  console.log(
    JSON.stringify({
      reply: "",
      lookup: "登录",
      actions: [],
    }),
  );
});
