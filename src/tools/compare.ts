/**
 * Compare tool for Google Sheets MCP.
 *
 * Registered for all authenticated @example.com users (read-only).
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SheetsClient, SheetsApiError } from "../sheets-client.js";

const MAX_ROWS_DEFAULT = 1_000;
const MAX_ROWS_HARD = 10_000;

function toolError(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function registerCompareTools(server: McpServer, client: SheetsClient): void {

  // compare_sheets — diff two sheets positionally or by a shared key column
  server.tool(
    "compare_sheets",
    "Compare two Google Sheets and return a structured diff. Supports positional mode (row N vs row N) or key mode (join rows by a shared column value like Email). Returns a summary with row counts and per-column change counts, plus a detailed differences array.",
    {
      spreadsheet_id_a: z.string().describe("Spreadsheet ID of the first sheet (from the URL)"),
      sheet_name_a: z.string().optional().describe("Tab name in spreadsheet A. Omit to use the first tab."),
      spreadsheet_id_b: z.string().describe("Spreadsheet ID of the second sheet (from the URL)"),
      sheet_name_b: z.string().optional().describe("Tab name in spreadsheet B. Omit to use the first tab."),
      key_column: z.string().optional().describe("Column header to join on (e.g. \"Email\"). Omit for positional row-by-row comparison."),
      columns: z.array(z.string()).optional().describe("Limit comparison to specific column headers. Omit to compare all columns."),
      max_rows: z.number().int().min(1).max(MAX_ROWS_HARD).optional().describe(`Row cap per sheet. Default ${MAX_ROWS_DEFAULT}. Hard max ${MAX_ROWS_HARD}.`),
    },
    async ({ spreadsheet_id_a, sheet_name_a, spreadsheet_id_b, sheet_name_b, key_column, columns, max_rows }) => {
      const maxRows = Math.min(max_rows ?? MAX_ROWS_DEFAULT, MAX_ROWS_HARD);
      const rangeA = sheet_name_a ? `${sheet_name_a}!A1:ZZ${maxRows + 1}` : `A1:ZZ${maxRows + 1}`;
      const rangeB = sheet_name_b ? `${sheet_name_b}!A1:ZZ${maxRows + 1}` : `A1:ZZ${maxRows + 1}`;

      try {
        const result = await client.compareSheets(
          spreadsheet_id_a, rangeA,
          spreadsheet_id_b, rangeB,
          { keyColumn: key_column, columns, maxRows },
        );
        const output = JSON.stringify(result, null, 2);
        const notice = result.truncated
          ? `\n\n(Differences truncated to 500 entries. Total differences found: ${result.summary.rowsDifferent + result.summary.rowsOnlyInA + result.summary.rowsOnlyInB}.)`
          : "";
        return {
          content: [{ type: "text" as const, text: output + notice }],
        };
      } catch (err) {
        if (err instanceof Error) {
          return toolError(err.message);
        }
        return toolError(String(err));
      }
    },
  );
}
