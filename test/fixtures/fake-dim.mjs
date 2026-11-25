#!/usr/bin/env node
console.log(
  JSON.stringify({
    reply: "fake dim leader reply",
    actions: [
      {
        type: "add_task",
        title: "dim-added task",
        brief: "created by fake dim",
        priority: 11,
      },
    ],
  }),
);
