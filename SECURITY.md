# Security policy

Foreman is local-first and can start agents that edit code and use the network.
Treat it as privileged software.

- Do not expose the dashboard/API without TLS and a bearer token.
- Keep `allowedProjectRoots` narrow.
- Use per-worker enroll/revoke tokens for remote workers.
- Do not commit tokens, `foreman.config.json`, or data directories.
- Review leader actions before enabling unattended destructive operations.

Please report vulnerabilities through [GitHub private security advisories](https://github.com/Simon-He95/foreman/security/advisories/new)
rather than opening a public issue with exploit details.
