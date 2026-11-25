# Recipe: code review

```text
审查这个 PR 的并发和资源释放问题。不要改代码，只给 findings。
用强模型，思考开到最大。
```

A review task should be a separate child thread. Foreman keeps the master as
the conversation surface and the review child as the evidence trail.

If the worker needs the PR branch, use a worktree-aware task or configure
`t3Worktree`; artifact/diff contracts force the main project tree.
