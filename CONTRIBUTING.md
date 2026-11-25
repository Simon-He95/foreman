# Contributing

Thanks for helping.

## Development

```bash
npm ci
npm test
npm run demo -- --duration 15
```

T3-dependent tests are exercised with fake CLIs; a real T3 Code install is only
needed for manual integration testing. Read [DESIGN.md](DESIGN.md) before
changing the control plane, lineage path, or model policy.

## Pull requests

- Keep changes scoped; explain the user-visible behavior.
- Add a regression test for bug fixes where practical.
- Do not commit `foreman.config.json`, `.foreman*/`, tokens, or screenshots with
  personal paths.
- Run `npm test` before opening a PR.

## Security

Do not open a public issue for a vulnerability; see `SECURITY.md`.
