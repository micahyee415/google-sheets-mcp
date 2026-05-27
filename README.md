# gsheets-mcp

> A Model Context Protocol (MCP) server for Google Sheets (read + write), deployed on Google Cloud Run.

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)

---

## Overview

`gsheets-mcp` exposes Google Sheets and Google Drive as MCP tools so an AI assistant (e.g. Claude.ai) can read, write, search, and compare spreadsheets on behalf of authenticated users.

Key design decisions:

- **Per-user OAuth passthrough** — every Google API call runs as the requesting user, so Google's own Drive/Sheets permissions are enforced on every operation. The server never holds a service-account key that could reach any sheet.
- **Domain-restricted access** — only accounts from a configured Google Workspace domain (`ALLOWED_DOMAIN`) can connect. Tokens are validated against Google's tokeninfo endpoint on each request, with a short-lived in-memory cache to reduce latency.
- **Deliberately omitted tools** — `share_spreadsheet` (silent external-sharing risk) and raw `batch_update` (unvalidated API passthrough) are intentionally excluded.
- **Bulk-write alerting** — write operations that exceed a configurable row threshold (`BULK_WRITE_THRESHOLD_ROWS`) fire a Slack DM to a designated alert recipient, fire-and-forget so user latency is unaffected.
- **Structured audit logging** — every request and every write emits a structured Cloud Logging entry (SOC 2 CC7.2 alignment).

---

## MCP Tools

### Read tools (10)

| Tool | Description |
|------|-------------|
| `get_sheet_data` | Read formatted cell values from a spreadsheet or range. Hard row cap with truncation notice. |
| `get_sheet_formulas` | Read raw formula strings instead of computed values. |
| `list_sheets` | List all sheet tabs with numeric sheetId, name, and position. |
| `get_multiple_sheet_data` | Read data from up to 5 spreadsheets in parallel. |
| `get_multiple_spreadsheet_summary` | Preview the first N rows of up to 10 spreadsheets at once. |
| `list_spreadsheets` | List accessible spreadsheets ordered by last-modified; optionally scoped to a Drive folder. |
| `list_folders` | List Google Drive folders; optionally scoped to a parent folder. |
| `search_spreadsheets` | Full-text Drive search for spreadsheets by name or cell content. |
| `find_in_spreadsheet` | Case-insensitive substring search within a single spreadsheet's cell values. |
| `search_across_spreadsheets` | Search cell content across multiple spreadsheets with optional Drive discovery (by folder, file name, or recently modified). Supports explicit IDs or auto-discovery up to 20 sheets. |

### Compare tool (1)

| Tool | Description |
|------|-------------|
| `compare_sheets` | Diff two Google Sheets positionally (row N vs row N) or by a shared key column (e.g. Email). Returns per-column change counts and a detailed differences array, capped at 500 entries. |

### Write tools (8)

All write tools are wrapped with structured audit logging. Writes exceeding `BULK_WRITE_THRESHOLD_ROWS` rows trigger a Slack DM alert. Each user can only write to sheets they already have Google permission to edit — per-user OAuth enforces this at the Google layer.

| Tool | Description |
|------|-------------|
| `update_cells` | Write values to a cell range (overwrites existing). Supports formulas. 10,000-cell limit per call. |
| `batch_update_cells` | Write to up to 20 ranges in a single API call. 10,000-cell total limit per call. |
| `add_rows` | Insert empty rows at a specified index. Requires numeric `sheetId` from `list_sheets`. |
| `add_columns` | Insert empty columns at a specified index. Requires numeric `sheetId` from `list_sheets`. |
| `create_spreadsheet` | Create a new Google Spreadsheet; optionally place it in a Drive folder. Returns ID and URL. |
| `create_sheet` | Add a new tab to an existing spreadsheet. |
| `rename_sheet` | Rename a sheet tab. Requires numeric `sheetId`. |
| `append_rows` | Append rows after the last row with data without needing to know the current row count. |

---

## Architecture

```
Claude.ai
    │  HTTPS + Bearer (Google OAuth token)
    ▼
Express HTTP server (Cloud Run)
    ├── POST /register          — RFC 7591 Dynamic Client Registration
    ├── GET  /.well-known/…     — RFC 8414 OAuth discovery metadata
    ├── GET  /health            — liveness probe
    └── ALL  /mcp               — MCP endpoint (StreamableHTTP transport)
             │
             ├── 1. Extract Bearer token
             ├── 2. Verify with Google tokeninfo — confirms domain + audience
             ├── 3. Per-user rate limit (60 req/min, in-memory fixed window)
             ├── 4. Create fresh McpServer + StreamableHTTPServerTransport per request
             └── 5. Dispatch to read / compare / write tools
                      │
                      └── Google Sheets & Drive APIs (googleapis, user's own token)
```

**Transport:** StreamableHTTP (stateless — a fresh `McpServer` is created per request).

**OAuth flow:** Claude.ai calls `/register` to obtain the Google OAuth client credentials, then redirects the user through Google's standard OAuth consent screen. The resulting access token is sent as a Bearer header on every MCP request. The server validates it against `https://oauth2.googleapis.com/tokeninfo`, checks the domain, checks the audience (prevents token reuse from other Google-integrated apps), and caches the result for up to 60 seconds.

**Deployment:** Docker multi-stage build → Google Container Registry → Google Cloud Run (`us-central1`). Cloud Build pipeline runs `npm audit --audit-level=high` before building the image and deploys via `service.yaml` using `gcloud run services replace`.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22, TypeScript 5 |
| MCP SDK | `@modelcontextprotocol/sdk` |
| HTTP server | Express 5 |
| Google APIs | `googleapis`, `google-auth-library` |
| Validation | Zod |
| Containerization | Docker (multi-stage, non-root user) |
| CI/CD | Google Cloud Build |
| Hosting | Google Cloud Run |
| Secrets | GCP Secret Manager |
| Logging | Structured JSON (Cloud Logging) |
| Tests | Node.js built-in `node:test` runner |

---

## Getting Started

### Prerequisites

- Node.js 22+
- A Google Cloud project with the Sheets API and Drive API enabled
- A Google OAuth 2.0 client (Web application type) with `https://claude.ai` and `https://api.claude.ai` as authorized JavaScript origins
- GCP Secret Manager entries for the OAuth client ID and secret (for Cloud Run deployment)
- A Slack bot token with `chat:write` scope (optional — for bulk-write alerting)

### Installation

```bash
git clone https://github.com/micahyee415/google-sheets-mcp
cd google-sheets-mcp
npm install
```

### Configuration

Copy and edit the environment variables. For local development you can export them directly or use a `.env` loader:

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth 2.0 client secret |
| `ALLOWED_DOMAIN` | Yes | Workspace domain to restrict access to (e.g. `example.com`) |
| `SERVER_URL` | Yes | Public base URL of this service (e.g. `https://your-service.example.com`) |
| `PORT` | No | HTTP port (default `8080`) |
| `BULK_WRITE_THRESHOLD_ROWS` | No | Row count above which a Slack DM alert fires (default `20`) |
| `BULK_WRITE_ALERT_USER_ID` | No | Slack user ID to DM on bulk writes |
| `SLACK_BOT_TOKEN` | No | Slack bot token with `chat:write` scope |

For Cloud Run, secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SLACK_BOT_TOKEN`) are sourced from GCP Secret Manager via `secretKeyRef` in `service.yaml`.

### Run locally

```bash
# Build TypeScript
npm run build

# Start the server
npm start
# → Listening on http://localhost:8080
```

Health check: `curl http://localhost:8080/health`

### Deploy to Cloud Run

```bash
gcloud builds submit \
  --config cloudbuild.yaml \
  --project your-gcp-project \
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD)
```

The Cloud Build pipeline will:
1. Run `npm audit --audit-level=high` and fail on high/critical CVEs.
2. Build and push the Docker image (tagged with commit SHA and `:latest`).
3. Deploy via `service.yaml` using `gcloud run services replace`.

After deploying, restore the `allUsers` Cloud Run invoker binding if your setup requires public access (Cloud Run resets IAM policy on each deploy).

---

## Connecting an MCP Client

Point your MCP client at the deployed service URL:

```
https://your-service.example.com/mcp
```

Claude.ai handles the OAuth flow automatically using the `/register` and `/.well-known/oauth-authorization-server` endpoints. Any `@your-domain.com` user who completes the Google sign-in will be granted access.

---

## Security

- **Domain restriction** — only accounts from `ALLOWED_DOMAIN` can authenticate. Enforced on every request via Google's tokeninfo endpoint.
- **Audience check** — the OAuth token's `aud` claim is validated against `GOOGLE_CLIENT_ID` to prevent token reuse from other Google-integrated apps.
- **Per-user OAuth** — no service account. Every Google API call runs as the authenticated user; Google enforces that user's existing Drive/Sheets permissions.
- **Per-user rate limiting** — 60 requests/minute per user (in-memory fixed window).
- **Write audit logging** — every write tool call emits a structured log entry with `userEmail`, `tool`, `rowsWritten`, `cellsWritten`, `spreadsheetId`, `outcome`, and `durationMs`.
- **Bulk-write alerting** — writes exceeding the threshold row count fire a Slack DM to the designated alert user (fire-and-forget).
- **Cell write cap** — `update_cells` and `batch_update_cells` reject payloads exceeding 10,000 cells.
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `Cache-Control: no-store` on all responses.
- **Non-root container** — the Docker image runs as a dedicated non-root `app` user.
- **CI security gate** — `npm audit --audit-level=high` runs before every Cloud Build image build.
- **Deliberately excluded tools** — `share_spreadsheet` and raw `batch_update` are permanently omitted (external-sharing and unvalidated API passthrough risks).

See [SECURITY.md](./SECURITY.md) for the vulnerability reporting policy.

---

## License

No license file is currently included. All rights reserved unless otherwise specified.
