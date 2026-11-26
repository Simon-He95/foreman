# Maintainer asset checklist

This is an internal checklist, not part of the end-user guide.

Use a clean demo project and data directory. No tokens, personal paths, or real
conversations.

## Current assets

- `dashboard-live.png` — 1440×1000, captured from a sanitized 8-task demo state
  (`demo-repo`, fake `mcp:demo-master`). Shows the master session, task filter,
  collapsed routing/errors, and the “问主会话” task action. Used in the README.
- `first-run.png` — 1440×1000, unbound dashboard with T3 reachable, default
  FC/project, and the one-click master creation panel.
- `social-preview.png` — 1280×640 GitHub social card. Upload it manually under
  **Settings → General → Social preview**; GitHub has no upload API.

## Still to capture

1. `one-session-lookup.png`
   - master answers a task-detail question without opening a worker thread
   - show a task id and the returned result/event summary
2. `doctor.png`
   - `foreman doctor` all green
3. `first-task.gif` (optional but recommended)
   - ask → queue → completion notification → ask for details in the same session

## Capture checklist

- use a neutral project name, e.g. `demo-repo`, not a personal repo
- use mock or a sanitized demo data dir
- 1440px wide, consistent theme (one light/dark set)
- redact tokens, local usernames, private paths
- do **not** make worker-thread links the hero of a screenshot; the master
  session is the interface
- keep the T3 master title clear: `Foreman`

## Suggested flow for the GIF

```text
1. Type: 调研最近一个月发布节奏，输出简报
2. Show: task queued/running in the dashboard and master session
3. Show: completion notification
4. Ask: “刚才那个调研的结论和失败原因？”
5. Show: master answers from the ledger, without opening a child thread
```
