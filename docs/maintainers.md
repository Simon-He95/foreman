# Maintainers

## GitHub repository metadata

Use these values for the repository settings; they are the canonical copy:

- **Description**: `Always-on control plane for coding-agent fleets on T3 Code. A durable SQLite task ledger, leased worker threads, retries, and accurate status from one leader.`
- **Homepage**: `https://github.com/Simon-He95/foreman#readme`
- **Topics**: `ai-agents`, `agent-orchestration`, `coding-agents`, `control-plane`,
  `t3-code`, `task-queue`, `sqlite`, `acp`, `claude`, `codex`, `dimagent`
- **Social preview**: [`assets/social-preview.png`](assets/social-preview.png)
  (GitHub → Settings → General → Social preview; the API has no upload endpoint)
- **Issues**: on; **Discussions**: on; **Wiki**: off; **Projects**: off
- **Merge policy**: squash merge; delete branch on merge

## Release checklist

```bash
npm test
npm pack --dry-run
npm version patch        # or minor/major
git push --follow-tags
npm publish
gh release create "v$(node -p 'require("./package.json").version')" \
  --title "Foreman v$(node -p 'require("./package.json").version')" \
  --notes-file CHANGELOG.md
```

`npm publish` requires the `@simon-he95` scope and a granular npm token with
publish rights. The package is public (`publishConfig.access=public`) and the
binary remains `foreman`.

## Security and secrets

- Never commit `foreman.config.json`, `.foreman*/`, tokens, data directories,
  worker state, or dashboard access tokens.
- Use GitHub private security advisories for vulnerabilities.
- Rotate T3/worker tokens after any accidental exposure.

## Repository setup

```bash
gh repo edit Simon-He95/foreman \
  --description "Always-on control plane for coding-agent fleets on T3 Code. A durable SQLite task ledger, leased worker threads, retries, and accurate status from one leader." \
  --add-topic ai-agents --add-topic agent-orchestration --add-topic coding-agents \
  --add-topic control-plane --add-topic t3-code --add-topic task-queue \
  --add-topic sqlite --add-topic acp --add-topic claude --add-topic codex \
  --add-topic dimagent \
  --enable-issues --enable-discussions --enable-wiki=false --enable-projects=false
```
