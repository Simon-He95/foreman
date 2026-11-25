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
- **Branch protection**: `main` requires `test (22)` and `test (24)`; linear
  history; no force pushes or deletions; conversation resolution on

## Release checklist

The normal release is one command:

```bash
npm run release -- --patch
```

It checks a clean `main`, runs tests, bumps `package.json` / `package-lock.json`,
publishes to npm, verifies the registry, then commits, tags, and pushes. npm
will ask for a 2FA OTP once; the script does not bypass account security. Use
`npm run release -- --minor` or `--major` for a larger bump.

Non-mutating check:

```bash
npm run release:dry
```

If npm returns a staged release instead of a direct publish, the script calls
`npm stage approve` automatically after the same OTP. For CI/automation, use the
manual `publish` GitHub Actions workflow with an `NPM_TOKEN` secret; npm may
still require a maintainer approval for staged releases.

The package is `foreman-ops` (public, `publishConfig.access=public`), and the
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
