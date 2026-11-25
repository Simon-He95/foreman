# Maintainer asset checklist

This is an internal checklist, not part of the end-user guide.

Use a clean demo project and data directory. No tokens, personal paths, or real
conversations.

## Current assets

- `dashboard-live.png` — captured from the mock demo (3 tasks: running, queued,
  done) with a neutral `docs-demo/acme-web` project path. Used in the README.
- `social-preview.png` — 1280×640 GitHub social card. Upload it manually under
  **Settings → General → Social preview**; GitHub has no upload API.

## Still to capture

1. `master-lineage.png`
   - T3 master thread with a task request and a child thread reference
   - show provider `Foreman (control plane)`
2. `lineage-panel.png`
   - Thread details / Lineage with the child marked `subagent`
3. `completion-notification.png`
   - `📣 Foreman：✅ 完成 …` with model/effort and thread link
4. `doctor.png`
   - `foreman doctor` all green
5. `first-task.gif` (optional but recommended)
   - ask → child created → notification

## Capture checklist

- use a neutral project name, e.g. `acme-web`, not a personal repo
- use mock or a dedicated demo data dir
- 1440px wide, consistent theme (one light/dark set)
- redact tokens, local usernames, private paths
- keep the T3 thread title clear: `Foreman`
- capture the child link in the master message; this is the main differentiator

## Suggested flow for the GIF

```text
1. Type: 调研最近一个月发布节奏，输出简报
2. Show: child thread created under master
3. Show: dashboard running task
4. Show: completion notification + child link
```
