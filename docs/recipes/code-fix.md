# Recipe: code fix

```text
修复登录页的 flaky 测试。先复现，再改代码，补回归测试。
用 coding 模型，effort high。
```

Foreman will:

1. classify this as a coding task
2. create a child thread in the master's project
3. run the worker with the selected model/effort
4. verify `git diff` if `requireDiff` is configured
5. notify the master with the child link

If the master is in a different project from the code, native lineage is not
possible; use a master in that project or fall back to a top-level worker.

CLI equivalent:

```bash
node src/cli.mjs add "fix flaky login test" \
  --brief "reproduce, fix, add regression test" \
  --model dimcode-api-oauth/claude-opus-5-5 \
  --effort high \
  --require-diff
```
