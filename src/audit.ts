/**
 * Write-action audit + bulk-write alerting.
 *
 * Wraps each write-tool handler with `audited()` so every write emits a
 * structured Cloud Logging entry (`event: "write"`) carrying:
 *   - userEmail, tool, rowsWritten, cellsWritten, spreadsheetId, sheetName
 *   - outcome (ok | error), durationMs, optional error text
 *
 * When a successful write exceeds `BULK_WRITE_THRESHOLD_ROWS` (default 20),
 * a Slack DM is posted to `BULK_WRITE_ALERT_USER_ID` via `chat.postMessage`.
 * The post is fire-and-forget so user-facing latency is unaffected.
 */

import { logger } from "./logger.js";

const THRESHOLD = parseInt(process.env.BULK_WRITE_THRESHOLD_ROWS ?? "20", 10);
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const ALERT_USER_ID = process.env.BULK_WRITE_ALERT_USER_ID ?? "";

if (!SLACK_TOKEN || !ALERT_USER_ID) {
  logger.warn("Bulk-write Slack alerting not fully configured", {
    hasToken: Boolean(SLACK_TOKEN),
    hasAlertUserId: Boolean(ALERT_USER_ID),
    threshold: THRESHOLD,
  });
} else {
  logger.info("Bulk-write Slack alerting enabled", {
    threshold: THRESHOLD,
    alertUserId: ALERT_USER_ID,
  });
}

export interface WriteScope {
  rowsWritten: number;
  cellsWritten: number;
  spreadsheetId?: string;
  sheetName?: string;
}

interface ToolResult {
  isError?: boolean;
  content: unknown;
}

/**
 * Extracts the sheet/tab name from an A1-notation range like "Sheet1!A1:C3".
 * Returns undefined if no sheet prefix is present.
 */
export function sheetNameFromRange(range: string | undefined): string | undefined {
  if (!range) return undefined;
  const bang = range.indexOf("!");
  if (bang <= 0) return undefined;
  const raw = range.slice(0, bang);
  // Strip surrounding single quotes used to escape names with spaces.
  return raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
}

/** Count rows + cells across a 2D values array. */
export function scopeFromValues(values: unknown[][]): { rows: number; cells: number } {
  let cells = 0;
  for (const row of values) cells += row.length;
  return { rows: values.length, cells };
}

/**
 * Wraps a write-tool handler:
 *   1. Computes WriteScope from args
 *   2. Runs the handler
 *   3. Emits a structured "write" log entry
 *   4. Fires a Slack DM if rowsWritten exceeds the threshold and the call succeeded
 */
export function audited<TArgs, TResult extends ToolResult>(
  toolName: string,
  userEmail: string,
  computeScope: (args: TArgs) => WriteScope,
  handler: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs) => {
    const startMs = Date.now();
    const scope = computeScope(args);
    let outcome: "ok" | "error" = "ok";
    let errorText: string | undefined;
    let result: TResult | undefined;

    try {
      result = await handler(args);
      if (result.isError) {
        outcome = "error";
        const content = result.content as Array<{ text?: string }> | undefined;
        errorText = content?.[0]?.text;
      }
      return result;
    } catch (err) {
      outcome = "error";
      errorText = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const durationMs = Date.now() - startMs;

      logger.info("Write performed", {
        event: "write",
        userEmail,
        tool: toolName,
        rowsWritten: scope.rowsWritten,
        cellsWritten: scope.cellsWritten,
        ...(scope.spreadsheetId ? { spreadsheetId: scope.spreadsheetId } : {}),
        ...(scope.sheetName ? { sheetName: scope.sheetName } : {}),
        outcome,
        durationMs,
        ...(errorText ? { error: errorText } : {}),
      });

      if (outcome === "ok" && scope.rowsWritten > THRESHOLD) {
        // Fire-and-forget — never block the user.
        void emitBulkAlert({
          userEmail,
          tool: toolName,
          rowsWritten: scope.rowsWritten,
          cellsWritten: scope.cellsWritten,
          spreadsheetId: scope.spreadsheetId,
          sheetName: scope.sheetName,
          durationMs,
        }).catch((e) =>
          logger.warn("Bulk-write Slack post failed", {
            event: "bulk_write_alert_failed",
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    }
  };
}

async function emitBulkAlert(payload: {
  userEmail: string;
  tool: string;
  rowsWritten: number;
  cellsWritten: number;
  spreadsheetId?: string;
  sheetName?: string;
  durationMs: number;
}): Promise<void> {
  if (!SLACK_TOKEN || !ALERT_USER_ID) {
    logger.warn("Bulk write detected but Slack not configured — skipping DM", {
      event: "bulk_write_alert_failed",
      userEmail: payload.userEmail,
      tool: payload.tool,
      rowsWritten: payload.rowsWritten,
    });
    return;
  }

  const sheetLink = payload.spreadsheetId
    ? `<https://docs.google.com/spreadsheets/d/${payload.spreadsheetId}/edit|open sheet>`
    : "_(no spreadsheet id captured)_";

  const lines = [
    `:rotating_light: *Bulk write on gsheets-mcp* (>${THRESHOLD} rows)`,
    `• *User:* \`${payload.userEmail}\``,
    `• *Tool:* \`${payload.tool}\``,
    `• *Rows:* ${payload.rowsWritten.toLocaleString()}`,
    `• *Cells:* ${payload.cellsWritten.toLocaleString()}`,
    payload.sheetName ? `• *Sheet:* ${payload.sheetName}` : null,
    `• *Spreadsheet:* ${sheetLink}`,
    `• *Duration:* ${payload.durationMs}ms`,
  ].filter(Boolean);

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: ALERT_USER_ID, text: lines.join("\n") }),
  });
  const body = (await res.json()) as { ok: boolean; error?: string };
  if (!body.ok) {
    logger.warn("Slack chat.postMessage returned not-ok", {
      event: "bulk_write_alert_failed",
      error: body.error,
      userEmail: payload.userEmail,
      tool: payload.tool,
    });
    return;
  }
  logger.info("Bulk write Slack alert sent", {
    event: "bulk_write_alert",
    userEmail: payload.userEmail,
    tool: payload.tool,
    rowsWritten: payload.rowsWritten,
  });
}
