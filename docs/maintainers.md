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
npm run release
```

`bumpp` asks whether this is patch / minor / major / custom. The script then
checks a clean `main`, runs tests, bumps `package.json` / `package-lock.json`,
publishes to npm, verifies the registry, then commits, tags, and pushes.

By default the script uses npm's **web/security-key 2FA** flow. npm opens its
browser authorization URL; the script does not prompt for an OTP. This requires
an interactive TTY. For non-interactive or authenticator fallback use:

```bash
npm run release -- --auth otp --otp 123456
# or
NPM_OTP=123456 npm run release -- --auth otp
```

The release script publishes to `https://registry.npmjs.org/` even if your
default npm registry is a mirror. Authenticate against npmjs explicitly:

```bash
npm login --auth-type=web --registry https://registry.npmjs.org/
```

npm may return a staged release instead of publishing immediately; the script
then calls `npm stage approve` with the same authentication mode.

Non-mutating check:

```bash
npm run release:dry
```

For CI/automation, use the manual `publish` GitHub Actions workflow with an
`NPM_TOKEN` secret; npm may still require a maintainer approval for staged
releases. The local release script defaults to browser/security-key auth, so
non-interactive CI should use the explicit OTP or token path.

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
