/**
 * Read-only Google Sheets MCP tools.
 *
 * All 9 tools are registered for every authenticated @example.com user.
 * None of these tools modify any data.
 *
 * Deliberately excluded tools (from the upstream Python repo):
 *   - share_spreadsheet: can silently share files externally — too dangerous
 *   - batch_update (raw): unvalidated API passthrough — too dangerous
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SheetsClient, SheetsApiError, MAX_ROWS_HARD_CAP, SpreadsheetFile } from "../sheets-client.js";

function toolError(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function registerReadTools(server: McpServer, client: SheetsClient): void {

  // 1. get_sheet_data — read formatted cell values
  server.tool(
    "get_sheet_data",
    `Read cell values from a Google Spreadsheet. Returns formatted values (numbers, dates, strings) for the specified range. Omit range to read the entire accessible area of the sheet. Hard limit: ${MAX_ROWS_HARD_CAP.toLocaleString()} rows — a truncation notice is appended if the sheet exceeds this.`,
    {
      spreadsheet_id: z.string().describe(
        "The spreadsheet ID found in the URL: docs.google.com/spreadsheets/d/<ID>/"
      ),
      range: z.string().optional().describe(
        "A1 notation range, e.g. 'Sheet1!A1:D10' or 'A:D'. Include the sheet tab name to target a specific tab. Omit to read all data."
      ),
      max_rows: z.number().int().min(1).max(MAX_ROWS_HARD_CAP).optional().describe(
        `Maximum rows to return (1–${MAX_ROWS_HARD_CAP.toLocaleString()}). Omit to use the full hard cap. Use to intentionally limit a large sheet.`
      ),
    },
    async ({ spreadsheet_id, range, max_rows }) => {
      try {
        const result = await client.getSheetData(spreadsheet_id, range, max_rows);
        let text = JSON.stringify(result.values, null, 2);
        if (result.truncated) {
          text += `\n\n[Note: Results truncated at ${(max_rows ?? MAX_ROWS_HARD_CAP).toLocaleString()} rows. Use a more specific range or max_rows to read additional rows.]`;
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return toolError(err instanceof SheetsApiError ? err.message : String(err));
      }
    },
  );

  // 2. get_sheet_formulas — read raw formula strings
  server.tool(
    "get_sheet_formulas",
    `Read raw formula strings from a Google Spreadsheet instead of computed values. Cells with formulas return '=SUM(A1:A10)' style strings. Cells without formulas return their literal value. Hard limit: ${MAX_ROWS_HARD_CAP.toLocaleString()} rows.`,
    {
      spreadsheet_id: z.string().describe("The spreadsheet ID from the URL"),
      range: z.string().optional().describe(
        "A1 notation range. Omit to read the full sheet."
      ),
      max_rows: z.number().int().min(1).max(MAX_ROWS_HARD_CAP).optional().describe(
        `Maximum rows to return (1–${MAX_ROWS_HARD_CAP.toLocaleString()}). Omit to use the full hard cap. Use to intentionally limit a large sheet.`
      ),
    },
    async ({ spreadsheet_id, range, max_rows }) => {
      try {
        const result = await client.getSheetFormulas(spreadsheet_id, range, max_rows);
        let text = JSON.stringify(result.values, null, 2);
        if (result.truncated) {
          text += `\n\n[Note: Results truncated at ${(max_rows ?? MAX_ROWS_HARD_CAP).toLocaleString()} rows. Use a more specific range to read additional rows.]`;
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return toolError(err instanceof SheetsApiError ? err.message : String(err));
      }
    },
  );

  // 3. list_sheets — list all tabs in a spreadsheet
  server.tool(
    "list_sheets",
    "List all sheet tabs in a Google Spreadsheet. Returns each tab's numeric sheetId, name, and position (index). The sheetId is required for add_rows, add_columns, and rename_sheet.",
    {
      spreadsheet_id: z.string().describe("The spreadsheet ID from the URL"),
    },
    async ({ spreadsheet_id }) => {
      try {
        const sheets = await client.listSheets(spreadsheet_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(sheets, null, 2) }] };
      } catch (err) {
        return toolError(err instanceof SheetsApiError ? err.message : String(err));
      }
    },
  );

  // 4. get_multiple_sheet_data — read from several spreadsheets at once
  server.tool(
    "get_multiple_sheet_data",
    `Read data from multiple Google Spreadsheets in parallel. Returns data grouped by spreadsheet ID. More efficient than calling get_sheet_data repeatedly. Hard limit: ${MAX_ROWS_HARD_CAP.toLocaleString()} rows per spreadsheet when no custom ranges are specified.`,
    {
      spreadsheet_ids: z.array(z.string()).min(1).max(5).describe(
        "Array of spreadsheet IDs to read (max 5)"
      ),
      ranges: z.array(z.string()).optional().describe(
        "Optional array of A1 notation ranges to fetch from each spreadsheet. Applied to all spreadsheets. Omit to read up to the row cap from each."
      ),
      max_rows: z.number().int().min(1).max(MAX_ROWS_HARD_CAP).optional().describe(
        `Maximum rows per spreadsheet (1–${MAX_ROWS_HARD_CAP.toLocaleString()}). Only applies when no custom ranges are specified. Omit to use the full hard cap.`
      ),
    },
    async ({ spreadsheet_ids, ranges, max_rows }) => {
      try {
        const results = await client.getMultipleSheetData(spreadsheet_ids, ranges, max_rows);
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return toolError(err instanceof SheetsApiError ? err.message : String(err));
      }
    },
  );

  // 5. get_multiple_spreadsheet_summary — quick preview of several sheets
  server.tool(
    "get_multiple_spreadsheet_summary",
    "Preview the first few rows of multiple spreadsheets at once. Useful for quickly understanding the structure and content of several sheets before deciding which ones to read in full.",
    {
      spreadsheet_ids: z.array(z.string()).min(1).max(10).describe(
        "Array of spreadsheet IDs to preview (max 10)"
      ),
      max_rows: z.number().int().min(1).max(20).optional().describe(
        "Number of rows to preview per spreadsheet (default: 5, max: 20)"
      ),
    },
    async ({ spreadsheet_ids, max_rows }) => {
      try {
        const results = await client.getMultipleSpreadsheetSummary(spreadsheet_ids, max_rows);
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return toolError(err instanceof SheetsApiError ? err.message : String(err));
      }
    },
  );

  // 6. list_spreadsheets — list accessible spreadsheets
  server.tool(
    "list_spreadsheets",
    "List Google Spreadsheets you have access to, ordered by most recently modified. Optionally filter to a specific Drive folder by ID. Returns spreadsheet ID, name, modified time, and URL for each file.",
    {
      folder_id: z.string().optional().describe(
        "Drive folder ID to list spreadsheets within. Use list_folders to find folder IDs. Omit to list all accessible spreadsheets."
      ),
      page_size: z.number().int().min(1).max(100).optional().describe(
        "Maximum number of results (default: 50, max: 100)"
      ),
    },
    async ({ folder_id, page_size }) => {
      try {
        const files = await client.listSpreadsheets(folder_id, page_size);
        return { content: [{ type: "text" as const, text: JSON.stringify(files, null, 2) }] };
      } catch (err) {
        return toolError(err instanceof SheetsApiError ? err.message : String(err));
      }
    },
  );

  // 7. list_folders — list Drive folders
  server.tool(
    "list_folders",
    "List Google Drive folders you have access to. Optionally filter to subfolders of a parent folder. Returns folder ID, name, and modified time.",
    {
      parent_id: z.string().optional().describe(
        "Parent folder ID to list subfolders within. Omit to list all top-level accessible folders."
      ),
      page_size: z.number().int().min(1).max(100).optional().describe(
        "Maximum number of results (default: 50)"
      ),
    },
    async ({ parent_id, page_size }) => {
      try {
        const folders = await client.listFolders(parent_id, page_size);
        return { content: [{ type: "text" as const, text: JSON.stringify(folders, null, 2) }] };
      } catch (err) {
        return toolError(err instanceof SheetsApiError ? err.message : String(err));
      }
    },
  );

  // 8. search_spreadsheets — full-text Drive search
  server.tool(
    "search_spreadsheets",
    "Search for Google Spreadsheets by name or cell content. Only returns files you have access to in Google Drive — private spreadsheets belonging to other users are not visible.",
    {
      query: z.string().min(1).describe(
        "Search term — matches against file names and spreadsheet content"
      ),
      page_size: z.number().int().min(1).max(50).optional().describe(
        "Maximum number of results (default: 20, max: 50)"
      ),
    },
    async ({ query, page_size }) => {
      try {
        const files = await client.searchSpreadsheets(query, page_size);
        return { content: [{ type: "text" as const, text: JSON.stringify(files, null, 2) }] };
      } catch (err) {
        return toolError(err instanceof SheetsApiError ? err.message : String(err));
      }
    },
  );

  // 9. find_in_spreadsheet — search cell values within a spreadsheet
  server.tool(
    "find_in_spreadsheet",
    "Search for a text string within cell values of a spreadsheet. Returns every matching cell with its sheet tab name, row number, column number (both 1-based), and the full cell value. Case-insensitive.",
    {
      spreadsheet_id: z.string().describe("The spreadsheet ID from the URL"),
      search_term: z.string().min(1).describe(
        "Text to search for (case-insensitive substring match)"
      ),
      sheet_name: z.string().optional().describe(
        "Limit search to a specific sheet tab by name. Omit to search all tabs."
      ),
    },
    async ({ spreadsheet_id, search_term, sheet_name }) => {
      try {
        const matches = await client.findInSpreadsheet(spreadsheet_id, search_term, sheet_name);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ totalMatches: matches.length, matches }, null, 2),
          }],
        };
      } catch (err) {
        return toolError(err instanceof SheetsApiError ? err.message : String(err));
      }
    },
  );

  // 10. search_across_spreadsheets — search cell content across multiple spreadsheets
  server.tool(
    "search_across_spreadsheets",
    "Search cell content across multiple Google Spreadsheets. Provide explicit spreadsheet IDs to search, or let the tool discover sheets via Drive (optionally scoped to a folder or filtered by file name). Returns matching cells with spreadsheet name, tab, row, column, and value.",
    {
      search_term: z.string().min(1).describe(
        "Text to search for in cell values (case-insensitive)"
      ),
      spreadsheet_ids: z.array(z.string()).max(20).optional().describe(
        "Explicit list of spreadsheet IDs to search (max 20). If provided, skips Drive discovery."
      ),
      folder_id: z.string().optional().describe(
        "Scope Drive discovery to a specific folder ID. Only used when spreadsheet_ids is not provided."
      ),
      file_name_query: z.string().optional().describe(
        "Filter discovered sheets by file name. Only used when spreadsheet_ids is not provided."
      ),
      max_spreadsheets: z.number().int().min(1).max(20).optional().describe(
        "Maximum number of spreadsheets to search (default 10, hard max 20). Only applies to discovered sheets."
      ),
      max_results_per_sheet: z.number().int().min(1).max(500).optional().describe(
        "Maximum cell matches returned per spreadsheet (default 50)."
      ),
    },
    async ({ search_term, spreadsheet_ids, folder_id, file_name_query, max_spreadsheets, max_results_per_sheet }) => {
      const maxSheets = Math.min(max_spreadsheets ?? 10, 20);
      const maxPerSheet = max_results_per_sheet ?? 50;

      try {
        let idsToSearch: string[];

        if (spreadsheet_ids && spreadsheet_ids.length > 0) {
          // Explicit IDs provided — skip Drive discovery
          idsToSearch = spreadsheet_ids;
        } else {
          // Drive discovery
          let discovered: SpreadsheetFile[];
          if (file_name_query) {
            discovered = await client.searchSpreadsheets(file_name_query, maxSheets, folder_id);
          } else {
            discovered = await client.listSpreadsheets(folder_id, maxSheets);
          }
          idsToSearch = discovered.map(f => f.id);
        }

        if (idsToSearch.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ spreadsheets_searched: 0, total_matches: 0, results: [] }, null, 2),
            }],
          };
        }

        const allResults = await client.searchAcrossSpreadsheets(idsToSearch, search_term, maxPerSheet);
        const successResults = allResults.filter(r => !r.error);
        const matchResults = successResults.filter(r => r.matches.length > 0);
        const totalMatches = matchResults.reduce((sum, r) => sum + r.matches.length, 0);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              spreadsheets_searched: successResults.length,
              total_matches: totalMatches,
              results: matchResults,
            }, null, 2),
          }],
        };
      } catch (err) {
        return toolError(err instanceof SheetsApiError ? err.message : String(err));
      }
    },
  );
}
