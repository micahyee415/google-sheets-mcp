/**
 * Write-enabled Google Sheets MCP tools.
 *
 * As of v2.4.0 these 8 tools are registered for every authenticated @example.com user.
 * Per-user OAuth means each user can only write to sheets they already have
 * Google permission to edit.
 *
 * Every handler is wrapped with `audited()` (see src/audit.ts) so each write
 * emits a structured log entry with rowsWritten + cellsWritten + spreadsheetId,
 * and crosses-threshold writes trigger a Slack DM to the security alert user.
 *
 * Deliberately excluded (from the upstream Python repo):
 *   - share_spreadsheet: can silently grant external access — permanently omitted
 *   - batch_update (raw): unvalidated API passthrough — permanently omitted
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SheetsClient, SheetsApiError, MAX_CELLS_PER_WRITE } from "../sheets-client.js";
import { audited, scopeFromValues, sheetNameFromRange, type WriteScope } from "../audit.js";

function toolError(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

// Cell value schema — strings, numbers, booleans, or null (empty cell)
const CellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const ValuesSchema = z.array(z.array(CellValueSchema));

export function registerWriteTools(
  server: McpServer,
  client: SheetsClient,
  userEmail: string,
): void {

  // 1. update_cells — write values to a range
  server.tool(
    "update_cells",
    "Write values to a range of cells in a Google Spreadsheet. Existing values are overwritten. Supports formulas (prefix with =). Use USER_ENTERED mode so dates and formulas are interpreted correctly.",
    {
      spreadsheet_id: z.string().describe("The spreadsheet ID from the URL"),
      range: z.string().describe(
        "A1 notation range to update, e.g. 'Sheet1!A1:C3'. Include the sheet tab name."
      ),
      values: ValuesSchema.describe(
        "2D array of cell values (array of rows, each row is an array of column values). Use null for empty cells. Example: [[\"Name\", \"Score\"], [\"Alice\", 95]]"
      ),
    },
    audited(
      "update_cells",
      userEmail,
      (args): WriteScope => {
        const { rows, cells } = scopeFromValues(args.values);
        return {
          rowsWritten: rows,
          cellsWritten: cells,
          spreadsheetId: args.spreadsheet_id,
          sheetName: sheetNameFromRange(args.range),
        };
      },
      async ({ spreadsheet_id, range, values }) => {
        const cellCount = values.reduce((sum: number, row) => sum + row.length, 0);
        if (cellCount > MAX_CELLS_PER_WRITE) {
          return toolError(
            `Payload too large: ${cellCount.toLocaleString()} cells exceeds the ${MAX_CELLS_PER_WRITE.toLocaleString()}-cell limit. Split into smaller updates.`
          );
        }
        try {
          const result = await client.updateCells(spreadsheet_id, range, values);
          return {
            content: [{
              type: "text" as const,
              text: `Successfully updated ${result.updatedCells} cell(s) in range ${range}.`,
            }],
          };
        } catch (err) {
          return toolError(err instanceof SheetsApiError ? err.message : String(err));
        }
      },
    ),
  );

  // 2. batch_update_cells — write to multiple ranges in one call
  server.tool(
    "batch_update_cells",
    "Write values to multiple cell ranges in a single API call. More efficient than calling update_cells repeatedly for the same spreadsheet.",
    {
      spreadsheet_id: z.string().describe("The spreadsheet ID from the URL"),
      data: z.array(z.object({
        range: z.string().describe("A1 notation range, e.g. 'Sheet1!A1:C3'"),
        values: ValuesSchema.describe("2D array of cell values for this range"),
      })).min(1).max(20).describe(
        "Array of range/values pairs to update (max 20 ranges per call)"
      ),
    },
    audited(
      "batch_update_cells",
      userEmail,
      (args): WriteScope => {
        let rows = 0;
        let cells = 0;
        const sheetNames = new Set<string>();
        for (const d of args.data) {
          rows += d.values.length;
          for (const row of d.values) cells += row.length;
          const sn = sheetNameFromRange(d.range);
          if (sn) sheetNames.add(sn);
        }
        return {
          rowsWritten: rows,
          cellsWritten: cells,
          spreadsheetId: args.spreadsheet_id,
          sheetName: sheetNames.size === 1
            ? [...sheetNames][0]
            : sheetNames.size > 1
              ? `${sheetNames.size} tabs`
              : undefined,
        };
      },
      async ({ spreadsheet_id, data }) => {
        const cellCount = data.reduce(
          (sum: number, d) => sum + d.values.reduce((s: number, row) => s + row.length, 0),
          0,
        );
        if (cellCount > MAX_CELLS_PER_WRITE) {
          return toolError(
            `Payload too large: ${cellCount.toLocaleString()} cells exceeds the ${MAX_CELLS_PER_WRITE.toLocaleString()}-cell limit. Split into smaller updates.`
          );
        }
        try {
          const result = await client.batchUpdateCells(spreadsheet_id, data);
          return {
            content: [{
              type: "text" as const,
              text: `Batch update complete. Total cells updated: ${result.totalUpdatedCells}.`,
            }],
          };
        } catch (err) {
          return toolError(err instanceof SheetsApiError ? err.message : String(err));
        }
      },
    ),
  );

  // 3. add_rows — insert empty rows
  server.tool(
    "add_rows",
    "Insert empty rows into a sheet at a specified position. Use list_sheets first to get the numeric sheetId (not the tab name).",
    {
      spreadsheet_id: z.string().describe("The spreadsheet ID from the URL"),
      sheet_id: z.number().int().describe(
        "The numeric sheet ID (not the tab name). Use list_sheets to find it."
      ),
      start_index: z.number().int().min(0).describe(
        "Zero-based row index where rows will be inserted. 0 = before the first row. Use the current row count to append at the end."
      ),
      count: z.number().int().min(1).max(1000).describe(
        "Number of empty rows to insert"
      ),
    },
    audited(
      "add_rows",
      userEmail,
      (args): WriteScope => ({
        rowsWritten: args.count,
        cellsWritten: 0,
        spreadsheetId: args.spreadsheet_id,
      }),
      async ({ spreadsheet_id, sheet_id, start_index, count }) => {
        try {
          await client.addRows(spreadsheet_id, sheet_id, start_index, count);
          return {
            content: [{
              type: "text" as const,
              text: `Inserted ${count} empty row(s) at index ${start_index} in sheet ID ${sheet_id}.`,
            }],
          };
        } catch (err) {
          return toolError(err instanceof SheetsApiError ? err.message : String(err));
        }
      },
    ),
  );

  // 4. add_columns — insert empty columns
  server.tool(
    "add_columns",
    "Insert empty columns into a sheet at a specified position. Use list_sheets first to get the numeric sheetId.",
    {
      spreadsheet_id: z.string().describe("The spreadsheet ID from the URL"),
      sheet_id: z.number().int().describe(
        "The numeric sheet ID. Use list_sheets to find it."
      ),
      start_index: z.number().int().min(0).describe(
        "Zero-based column index where columns will be inserted. 0 = before column A."
      ),
      count: z.number().int().min(1).max(100).describe(
        "Number of empty columns to insert"
      ),
    },
    audited(
      "add_columns",
      userEmail,
      (args): WriteScope => ({
        rowsWritten: 0,
        cellsWritten: 0,
        spreadsheetId: args.spreadsheet_id,
      }),
      async ({ spreadsheet_id, sheet_id, start_index, count }) => {
        try {
          await client.addColumns(spreadsheet_id, sheet_id, start_index, count);
          return {
            content: [{
              type: "text" as const,
              text: `Inserted ${count} empty column(s) at index ${start_index} in sheet ID ${sheet_id}.`,
            }],
          };
        } catch (err) {
          return toolError(err instanceof SheetsApiError ? err.message : String(err));
        }
      },
    ),
  );

  // 5. create_spreadsheet — create a new spreadsheet
  server.tool(
    "create_spreadsheet",
    "Create a new Google Spreadsheet with a single 'Sheet1' tab. Optionally place it in a specific Drive folder. Returns the new spreadsheet's ID and URL.",
    {
      title: z.string().min(1).max(255).describe("Title for the new spreadsheet"),
      folder_id: z.string().optional().describe(
        "Drive folder ID to place the spreadsheet in. Use list_folders to find folder IDs. Omit to create in your My Drive."
      ),
    },
    audited(
      "create_spreadsheet",
      userEmail,
      (): WriteScope => ({ rowsWritten: 0, cellsWritten: 0 }),
      async ({ title, folder_id }) => {
        try {
          const result = await client.createSpreadsheet(title, folder_id);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(
                { spreadsheetId: result.spreadsheetId, url: result.url },
                null,
                2
              ),
            }],
          };
        } catch (err) {
          return toolError(err instanceof SheetsApiError ? err.message : String(err));
        }
      },
    ),
  );

  // 6. create_sheet — add a new tab to an existing spreadsheet
  server.tool(
    "create_sheet",
    "Add a new sheet tab to an existing Google Spreadsheet. Returns the new tab's numeric sheetId and title.",
    {
      spreadsheet_id: z.string().describe("The spreadsheet ID from the URL"),
      title: z.string().min(1).max(100).describe("Name for the new sheet tab"),
      index: z.number().int().min(0).optional().describe(
        "Zero-based position to insert the tab (0 = first tab). Omit to append at the end."
      ),
    },
    audited(
      "create_sheet",
      userEmail,
      (args): WriteScope => ({
        rowsWritten: 0,
        cellsWritten: 0,
        spreadsheetId: args.spreadsheet_id,
        sheetName: args.title,
      }),
      async ({ spreadsheet_id, title, index }) => {
        try {
          const result = await client.createSheet(spreadsheet_id, title, index);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return toolError(err instanceof SheetsApiError ? err.message : String(err));
        }
      },
    ),
  );

  // 7. rename_sheet — rename a tab
  // NOTE: copy_sheet was removed — copying a tab cross-spreadsheet is a data exfiltration vector.
  server.tool(
    "rename_sheet",
    "Rename a sheet tab in a Google Spreadsheet. Use list_sheets first to get the numeric sheetId.",
    {
      spreadsheet_id: z.string().describe("The spreadsheet ID from the URL"),
      sheet_id: z.number().int().describe(
        "The numeric sheet ID of the tab to rename. Use list_sheets to find it."
      ),
      new_title: z.string().min(1).max(100).describe("New name for the sheet tab"),
    },
    audited(
      "rename_sheet",
      userEmail,
      (args): WriteScope => ({
        rowsWritten: 0,
        cellsWritten: 0,
        spreadsheetId: args.spreadsheet_id,
        sheetName: args.new_title,
      }),
      async ({ spreadsheet_id, sheet_id, new_title }) => {
        try {
          await client.renameSheet(spreadsheet_id, sheet_id, new_title);
          return {
            content: [{
              type: "text" as const,
              text: `Sheet ID ${sheet_id} renamed to "${new_title}".`,
            }],
          };
        } catch (err) {
          return toolError(err instanceof SheetsApiError ? err.message : String(err));
        }
      },
    ),
  );

  // 8. append_rows — append rows without knowing the current row count
  server.tool(
    "append_rows",
    "Append rows to a Google Sheet without needing to know the current row count. Inserts new rows after the last row with data. Formulas and dates are interpreted correctly (USER_ENTERED mode).",
    {
      spreadsheet_id: z.string().describe("The spreadsheet ID from the URL"),
      sheet_name: z.string().describe("Tab name to append to (e.g. \"Sheet1\")"),
      values: ValuesSchema.describe(
        "2D array of rows to append (array of rows, each row is an array of column values). Example: [[\"Alice\", 95], [\"Bob\", 88]]"
      ),
    },
    audited(
      "append_rows",
      userEmail,
      (args): WriteScope => {
        const { rows, cells } = scopeFromValues(args.values);
        return {
          rowsWritten: rows,
          cellsWritten: cells,
          spreadsheetId: args.spreadsheet_id,
          sheetName: args.sheet_name,
        };
      },
      async ({ spreadsheet_id, sheet_name, values }) => {
        const cellCount = values.reduce((sum: number, row) => sum + row.length, 0);
        if (cellCount > MAX_CELLS_PER_WRITE) {
          return toolError(
            `Payload too large: ${cellCount.toLocaleString()} cells exceeds the ${MAX_CELLS_PER_WRITE.toLocaleString()}-cell limit. Split into smaller appends.`
          );
        }
        try {
          const result = await client.appendRows(spreadsheet_id, `${sheet_name}!A:A`, values);
          return {
            content: [{
              type: "text" as const,
              text: `Appended ${result.appendedRows} row(s) to ${sheet_name}. Data written to ${result.appendedRange}.`,
            }],
          };
        } catch (err) {
          return toolError(err instanceof SheetsApiError ? err.message : String(err));
        }
      },
    ),
  );
}
