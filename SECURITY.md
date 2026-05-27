# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately through GitHub:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability** to open a private advisory.

This keeps the report confidential until a fix is released. Please don't open a public issue for security vulnerabilities.

## Supported Versions

This project is actively maintained. Security fixes are applied to the latest version on `main` only.

## Security Updates

### 2026-04-13
- v2.2.0: Hardened `/register` endpoint (origin check, rate limit, audit logging with IP + user-agent). Added 10,000-cell write cap. Applied consistent 10,000-row cap on multi-sheet reads. Rate-limiter intervals now unref'd for clean shutdown.

### 2026-04-09
- Routine npm audit completed — no vulnerabilities found.
