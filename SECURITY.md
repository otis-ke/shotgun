# Security Policy

## Reporting a vulnerability
Please **do not open a public issue**. Report privately through
[GitHub Security Advisories](https://github.com/otis-ke/shotgun/security/advisories/new).
You'll get a reply within 7 days.

## Secrets
- Never commit `.env`. Only `.env.example` (no values) belongs in git.
- `MASTER_KEY` encrypts users' Deriv tokens. If it leaks, rotate it and have users log in again.
- Deriv API tokens are only ever stored encrypted; if one leaks, revoke it in Deriv → Account settings → API token.

## Deployment topology
```
Internet ──HTTPS──▶ reverse proxy (TLS) ──▶ 127.0.0.1:8000 app container ──WSS──▶ Deriv API
                                                     │
                                          private Docker network ──▶ Postgres (no published port)
```
- The app binds to `127.0.0.1` only; expose it solely through a TLS reverse proxy (Caddy/Nginx).
- Postgres has no published port and requires `POSTGRES_PASSWORD` from `.env`.
- Containers run as a non-root user.
- Firewall the VPS to ports 22 (SSH keys only), 80 and 443.

## SDLC controls
| Control | Where |
|---|---|
| Tests on every push and PR | `.github/workflows/ci.yml` |
| Dependency vulnerability audit (pip-audit, npm audit) | `ci.yml` |
| Secret scanning in CI (gitleaks) + GitHub push protection | `ci.yml`, repo settings |
| Static code analysis (CodeQL, weekly + every PR) | `.github/workflows/codeql.yml` |
| Automated dependency updates | `.github/dependabot.yml` |
| `main` protected from force-push and deletion | repo settings |
