# Changelog

## [2.4.0] - 2026-05-20

### Changed

- **Write access opened to all authenticated domain users.** Previously gated by an explicit `WRITE_ALLOWLIST`; now any user authenticated via Google OAuth can call write tools (`update_cells`, `batch_update_cells`, `add_rows`, `add_columns`, `create_spreadsheet`, `create_sheet`, `rename_sheet`, `append_rows`).
- Removed `WRITE_ALLOWLIST` env var. The Google OAuth domain check (`ALLOWED_DOMAIN`) is now the sole access gate.
- Per-user OAuth security model is unchanged — every write runs as the requesting user, so Google enforces each user's own Drive/Sheets permissions on every operation.

### Added

- **Per-write structured audit log.** Each successful or failed write now emits a Cloud Logging entry with `event: "write"` and fields `userEmail`, `tool`, `rowsWritten`, `cellsWritten`, `spreadsheetId`, `sheetName`, `outcome`, `durationMs`. Sits alongside the existing `event: "usage"` request-level audit.
- **Bulk-write Slack DM alerting.** When a single write call exceeds `BULK_WRITE_THRESHOLD_ROWS` (default `20`) rows, the server fires a Slack DM to `BULK_WRITE_ALERT_USER_ID`. Alert payload includes user, tool, rows/cells written, spreadsheet link, and duration. Posted via `chat.postMessage` — fire-and-forget so user-facing latency is unaffected.
- New `src/audit.ts` module exporting `audited()`, `scopeFromValues()`, `sheetNameFromRange()`. 9 new unit tests covering scope computation and threshold boundaries.
- New env vars: `BULK_WRITE_THRESHOLD_ROWS`, `BULK_WRITE_ALERT_USER_ID`, `SLACK_BOT_TOKEN`.

### Removed

- `WRITE_ALLOWLIST` env var (no longer read by the server).

---

## [2.3.2] - 2026-05-15

### Security

- Patched `fast-uri` ReDoS vulnerability via `npm audit fix` (GHSA-cc4q-3qf2-7vrm).

---

## [2.3.1] - 2026-04-20

### Security

- Updated `hono` to fix moderate HTML injection vulnerability in JSX SSR (GHSA-458j-xx4x-4375).

---

## [2.3.0] - 2026-04-13

### Added

- `compare_sheets` — diff two Google Sheets positionally (row N vs row N) or by a shared key column (e.g. Email). Returns a summary with row counts and per-column change counts, plus a detailed differences array. Differences capped at 500 entries.
- `search_across_spreadsheets` — search cell content across multiple spreadsheets with optional Drive discovery (by folder, file name query, or recently modified). Supports explicit spreadsheet IDs or auto-discovery up to 20 sheets.
- `append_rows` — append rows to a sheet without needing to know the current row count. Uses `INSERT_ROWS` mode so new rows are always inserted, never overwriting empty cells below data. Same 10,000-cell limit as other write tools.
- Unit test infrastructure using Node's built-in `node:test` runner. `computeDiff` pure function is exported and tested with 13 tests covering all comparison modes, edge cases, and the 500-entry truncation cap.

---

## [2.2.0] - 2026-04-13

### Security

- Hardened `/register` endpoint: origin check restricts to Claude.ai origins, global rate limit (10 req/min), enhanced audit logging with source IP and user-agent.
- Added 10,000-cell write limit on `update_cells` and `batch_update_cells` to prevent bulk data injection.
- Applied 10,000-row cap to `get_multiple_sheet_data` (consistent with `get_sheet_data` and `get_sheet_formulas`).
- Added `.unref()` to rate-limiter intervals for clean process shutdown.

### Fixed

- Version string now consistent across `/health`, MCP server, and `package.json`.
- `get_sheet_formulas` now exposes `max_rows` parameter (was supported by the underlying client but not wired through to the tool).
- `get_multiple_sheet_data` now exposes `max_rows` parameter.

---

## [2.1.1] - 2026-04-07

### Changed

- Write allowlist expanded to cover additional team members.

### Security

- Routine npm audit — no vulnerabilities found.
