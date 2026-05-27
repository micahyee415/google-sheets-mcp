/**
 * Google Sheets + Drive API client.
 *
 * Authenticates using the user's own Google OAuth access token, passed through
 * from the Authorization header on each MCP request. Every API call runs with
 * the requesting user's own Drive and Sheets permissions — Google enforces their
 * existing sharing settings on every operation.
 *
 * Access model:
 *   - Users can read/write any spreadsheet they personally have access to in Drive
 *   - Private documents (e.g. Jordan's, Morgan's) are inaccessible unless the user
 *     already has permission in Google Drive — Google returns 403 automatically
 *   - No service account, no shared credential, no explicit sharing required
 *
 * All methods throw SheetsApiError on API failure.
 */

import { google } from "googleapis";
import type { sheets_v4, drive_v3 } from "googleapis";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hard cap on rows returned by getSheetData / getSheetFormulas. Prevents bulk exfiltration. */
export const MAX_ROWS_HARD_CAP = 10_000;

/** Hard cap on cells (rows × columns) in a single write operation. Prevents bulk data injection. */
export const MAX_CELLS_PER_WRITE = 10_000;

// ─── Error class ──────────────────────────────────────────────────────────────

export class SheetsApiError extends Error {
  public status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "SheetsApiError";
    this.status = status;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SheetProperties {
  sheetId: number;
  title: string;
  index: number;
}

export interface SpreadsheetFile {
  id: string;
  name: string;
  modifiedTime?: string | null;
  webViewLink?: string | null;
}

export interface FolderFile {
  id: string;
  name: string;
  modifiedTime?: string | null;
}

export interface CellMatch {
  sheet: string;
  row: number;
  col: number;
  value: string;
}

// Cell value types accepted by the Sheets API
export type CellValue = string | number | boolean | null;

// ─── Compare types ────────────────────────────────────────────────────────────

export interface DiffEntry {
  type: "added" | "removed" | "changed";
  /** Key column value (key mode) or 1-based spreadsheet row number (positional mode). */
  key: string | number;
  changes: Array<{ column: string; valueA: CellValue; valueB: CellValue }>;
}

export interface CompareResult {
  summary: {
    totalRowsA: number;
    totalRowsB: number;
    rowsOnlyInA: number;
    rowsOnlyInB: number;
    rowsMatched: number;
    rowsDifferent: number;
    columnChangeCounts: Record<string, number>;
  };
  differences: DiffEntry[];
  truncated: boolean;
  warnings?: string[];
}

export interface SpreadsheetSearchResult {
  spreadsheetId: string;
  spreadsheetName: string;
  matches: CellMatch[];
  /** Set to true when the spreadsheet could not be searched (e.g. permission denied). */
  error?: true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Escapes a value for safe embedding in a Drive API query string.
 * Drive query strings delimit strings with single quotes; literal ' must be \'.
 * See: https://developers.google.com/drive/api/guides/search-files#query_string_examples
 */
function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const MAX_DIFF_ENTRIES = 500;

/**
 * Pure diff function — compares two sheets represented as header + row arrays.
 * Exported for unit testing. Called by SheetsClient.compareSheets().
 *
 * Positional mode (no keyColumn): row N of A vs row N of B. First row = header.
 * Key mode (keyColumn provided): join rows by key column value, then diff.
 *
 * Throws a plain Error (not SheetsApiError) for validation failures (missing key
 * column, unknown column filter) — these are user input errors, not API errors.
 */
export function computeDiff(
  headersA: string[],
  rowsA: CellValue[][],
  headersB: string[],
  rowsB: CellValue[][],
  options: { keyColumn?: string; columns?: string[] },
): CompareResult {
  const { keyColumn, columns } = options;
  const allDiffs: DiffEntry[] = [];
  let rowsOnlyInA = 0, rowsOnlyInB = 0, rowsMatched = 0, rowsDifferent = 0;
  const columnChangeCounts: Record<string, number> = {};
  const warnings: string[] = [];

  const cellStr = (v: CellValue): string => (v === null || v === undefined) ? "" : String(v);
  const idxMapA = new Map(headersA.map((h, i) => [h, i] as [string, number]));
  const idxMapB = new Map(headersB.map((h, i) => [h, i] as [string, number]));

  if (keyColumn) {
    // ── Key mode ──────────────────────────────────────────────────────────────
    const keyIdxA = headersA.indexOf(keyColumn);
    const keyIdxB = headersB.indexOf(keyColumn);
    if (keyIdxA === -1 || keyIdxB === -1) {
      const missing: string[] = [];
      if (keyIdxA === -1) missing.push(`sheet A (headers: ${headersA.join(", ")})`);
      if (keyIdxB === -1) missing.push(`sheet B (headers: ${headersB.join(", ")})`);
      throw new Error(`Key column "${keyColumn}" not found in ${missing.join(" and ")}.`);
    }

    if (columns && columns.length > 0) {
      const allHeaders = new Set([...headersA, ...headersB]);
      const bad = columns.filter(c => !allHeaders.has(c) && c !== keyColumn);
      if (bad.length > 0) {
        throw new Error(`Column(s) not found in either sheet: ${bad.join(", ")}.`);
      }
    }

    const mapA = new Map<string, CellValue[]>();
    const dupKeysA = new Set<string>();
    for (const row of rowsA) {
      const key = cellStr(row[keyIdxA] ?? null);
      if (mapA.has(key)) dupKeysA.add(key);
      mapA.set(key, row);
    }

    const mapB = new Map<string, CellValue[]>();
    const dupKeysB = new Set<string>();
    for (const row of rowsB) {
      const key = cellStr(row[keyIdxB] ?? null);
      if (mapB.has(key)) dupKeysB.add(key);
      mapB.set(key, row);
    }

    const allCols = [...new Set([...headersA, ...headersB])].filter(h => h !== keyColumn);
    const compareCols = columns ?? allCols;

    if (dupKeysA.size > 0) {
      warnings.push(`Duplicate key values in sheet A: ${[...dupKeysA].map(k => `"${k}"`).join(", ")}. Last row with each key is used.`);
    }
    if (dupKeysB.size > 0) {
      warnings.push(`Duplicate key values in sheet B: ${[...dupKeysB].map(k => `"${k}"`).join(", ")}. Last row with each key is used.`);
    }

    for (const [key, rowA] of mapA) {
      const rowB = mapB.get(key);
      if (!rowB) {
        rowsOnlyInA++;
        allDiffs.push({ type: "removed", key, changes: [] });
      } else {
        rowsMatched++;
        const changes: DiffEntry["changes"] = [];
        for (const col of compareCols) {
          const idxA = idxMapA.get(col) ?? -1;
          const idxB = idxMapB.get(col) ?? -1;
          const valA: CellValue = idxA >= 0 ? (rowA[idxA] ?? null) : null;
          const valB: CellValue = idxB >= 0 ? (rowB[idxB] ?? null) : null;
          if (cellStr(valA) !== cellStr(valB)) {
            changes.push({ column: col, valueA: valA, valueB: valB });
            columnChangeCounts[col] = (columnChangeCounts[col] ?? 0) + 1;
          }
        }
        if (changes.length > 0) {
          rowsDifferent++;
          allDiffs.push({ type: "changed", key, changes });
        }
      }
    }

    for (const key of mapB.keys()) {
      if (!mapA.has(key)) {
        rowsOnlyInB++;
        allDiffs.push({ type: "added", key, changes: [] });
      }
    }
  } else {
    // ── Positional mode ───────────────────────────────────────────────────────
    const maxLen = Math.max(rowsA.length, rowsB.length);
    const compareCols = columns ?? [...new Set([...headersA, ...headersB])];

    if (columns && columns.length > 0) {
      const allHeaders = new Set([...headersA, ...headersB]);
      const bad = columns.filter(c => !allHeaders.has(c));
      if (bad.length > 0) {
        throw new Error(`Column(s) not found in either sheet: ${bad.join(", ")}.`);
      }
    }

    for (let i = 0; i < maxLen; i++) {
      const rowA = rowsA[i];
      const rowB = rowsB[i];
      const rowNum = i + 2; // 1-based spreadsheet row (row 1 is header)

      if (rowA && rowB) {
        rowsMatched++;
        const changes: DiffEntry["changes"] = [];
        for (const colName of compareCols) {
          const idxA = idxMapA.get(colName) ?? -1;
          const idxB = idxMapB.get(colName) ?? -1;
          const valA: CellValue = idxA >= 0 ? (rowA[idxA] ?? null) : null;
          const valB: CellValue = idxB >= 0 ? (rowB[idxB] ?? null) : null;
          if (cellStr(valA) !== cellStr(valB)) {
            changes.push({ column: colName, valueA: valA, valueB: valB });
            columnChangeCounts[colName] = (columnChangeCounts[colName] ?? 0) + 1;
          }
        }
        if (changes.length > 0) {
          rowsDifferent++;
          allDiffs.push({ type: "changed", key: rowNum, changes });
        }
      } else if (rowA) {
        rowsOnlyInA++;
        allDiffs.push({ type: "removed", key: rowNum, changes: [] });
      } else {
        rowsOnlyInB++;
        allDiffs.push({ type: "added", key: rowNum, changes: [] });
      }
    }
  }

  const truncated = allDiffs.length > MAX_DIFF_ENTRIES;
  return {
    summary: {
      totalRowsA: rowsA.length,
      totalRowsB: rowsB.length,
      rowsOnlyInA,
      rowsOnlyInB,
      rowsMatched,
      rowsDifferent,
      columnChangeCounts,
    },
    differences: truncated ? allDiffs.slice(0, MAX_DIFF_ENTRIES) : allDiffs,
    truncated,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Converts a Google API error into a typed SheetsApiError.
 * Returns never — always throws.
 */
function handleGoogleError(err: unknown): never {
  if (err && typeof err === "object") {
    const e = err as { status?: number; code?: number; message?: string; errors?: Array<{ message: string }> };
    const status = e.status ?? e.code ?? 500;
    const message =
      e.errors?.[0]?.message ??
      e.message ??
      "Google API error";

    if (status === 403) {
      throw new SheetsApiError(
        "Permission denied. You do not have access to this resource. " +
        "Check that the spreadsheet is shared with your Google account.",
        403
      );
    }
    if (status === 404) {
      throw new SheetsApiError("Spreadsheet or resource not found.", 404);
    }
    throw new SheetsApiError(message, status);
  }
  throw new SheetsApiError(String(err));
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class SheetsClient {
  private readonly sheets: sheets_v4.Sheets;
  private readonly drive: drive_v3.Drive;

  constructor(accessToken: string) {
    // Per-user OAuth — API calls run as the requesting user.
    // Google enforces their existing Drive/Sheets permissions on every call.
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    this.sheets = google.sheets({ version: "v4", auth, timeout: 30_000 });
    this.drive = google.drive({ version: "v3", auth, timeout: 30_000 });
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  /**
   * Read formatted cell values from a spreadsheet.
   * Returns a 2D array (rows × columns) of string values.
   * Omit range to read the entire accessible area of the sheet.
   */
  async getSheetData(
    spreadsheetId: string,
    range?: string,
    maxRows?: number,
  ): Promise<{ values: CellValue[][], truncated: boolean }> {
    try {
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range: range ?? "A:ZZ",
        valueRenderOption: "FORMATTED_VALUE",
      });
      const all = (res.data.values ?? []) as CellValue[][];
      const limit = Math.min(maxRows ?? MAX_ROWS_HARD_CAP, MAX_ROWS_HARD_CAP);
      const truncated = all.length > limit;
      return { values: truncated ? all.slice(0, limit) : all, truncated };
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Read raw formula strings from a spreadsheet.
   * Cells without formulas return their literal value.
   */
  async getSheetFormulas(
    spreadsheetId: string,
    range?: string,
    maxRows?: number,
  ): Promise<{ values: CellValue[][], truncated: boolean }> {
    try {
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range: range ?? "A:ZZ",
        valueRenderOption: "FORMULA",
      });
      const all = (res.data.values ?? []) as CellValue[][];
      const limit = Math.min(maxRows ?? MAX_ROWS_HARD_CAP, MAX_ROWS_HARD_CAP);
      const truncated = all.length > limit;
      return { values: truncated ? all.slice(0, limit) : all, truncated };
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * List all sheet tabs in a spreadsheet.
   * Returns sheetId (numeric), title, and index (tab position) for each sheet.
   * The sheetId is required by add_rows, add_columns, and rename_sheet.
   */
  async listSheets(spreadsheetId: string): Promise<SheetProperties[]> {
    try {
      const res = await this.sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets.properties(sheetId,title,index)",
      });
      return (res.data.sheets ?? []).map((s) => ({
        sheetId: s.properties?.sheetId ?? 0,
        title: s.properties?.title ?? "",
        index: s.properties?.index ?? 0,
      }));
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Read data from multiple spreadsheets in parallel.
   * Uses batchGet per spreadsheet — more efficient than individual reads.
   * When no custom ranges are provided, defaults to A1:ZZ{MAX_ROWS_HARD_CAP}.
   */
  async getMultipleSheetData(
    spreadsheetIds: string[],
    ranges?: string[],
    maxRows?: number,
  ): Promise<Array<{ spreadsheetId: string; data: sheets_v4.Schema$ValueRange[] }>> {
    const rowCap = Math.min(maxRows ?? MAX_ROWS_HARD_CAP, MAX_ROWS_HARD_CAP);
    const effectiveRanges = ranges ?? [`A1:ZZ${rowCap}`];
    const results = await Promise.all(
      spreadsheetIds.map(async (id) => {
        try {
          const res = await this.sheets.spreadsheets.values.batchGet({
            spreadsheetId: id,
            ranges: effectiveRanges,
            valueRenderOption: "FORMATTED_VALUE",
          });
          return { spreadsheetId: id, data: res.data.valueRanges ?? [] };
        } catch (err) {
          handleGoogleError(err);
        }
      }),
    );
    return results;
  }

  /**
   * Preview the first N rows of multiple spreadsheets in parallel.
   * Useful for understanding structure before deciding which sheets to read fully.
   */
  async getMultipleSpreadsheetSummary(
    spreadsheetIds: string[],
    maxRows = 5,
  ): Promise<Array<{ spreadsheetId: string; preview: CellValue[][] }>> {
    const results = await Promise.all(
      spreadsheetIds.map(async (id) => {
        try {
          const res = await this.sheets.spreadsheets.values.get({
            spreadsheetId: id,
            range: `A1:Z${maxRows}`,
            valueRenderOption: "FORMATTED_VALUE",
          });
          return {
            spreadsheetId: id,
            preview: (res.data.values ?? []) as CellValue[][],
          };
        } catch (err) {
          handleGoogleError(err);
        }
      }),
    );
    return results;
  }

  /**
   * List spreadsheets the user can access across My Drive and all Shared Drives
   * they are a member of. Optionally filtered to a specific folder.
   * Results ordered by most recently modified.
   * Google enforces the user's role in each Shared Drive on every call.
   */
  async listSpreadsheets(
    folderId?: string,
    pageSize = 50,
  ): Promise<SpreadsheetFile[]> {
    try {
      const q = folderId
        ? `mimeType='application/vnd.google-apps.spreadsheet' and '${escapeDriveQuery(folderId)}' in parents and trashed=false`
        : `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
      const res = await this.drive.files.list({
        q,
        pageSize,
        fields: "files(id,name,modifiedTime,webViewLink)",
        orderBy: "modifiedTime desc",
        includeItemsFromAllDrives: true,  // include Shared Drive files
        supportsAllDrives: true,           // app supports both My Drive and Shared Drives
        corpora: "allDrives",              // search across all drives the user has access to
      });
      return (res.data.files ?? []) as SpreadsheetFile[];
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * List Drive folders the user can access across My Drive and all Shared Drives
   * they are a member of. Optionally filtered to subfolders of a parent folder ID.
   * Google enforces the user's role in each Shared Drive on every call.
   */
  async listFolders(
    parentId?: string,
    pageSize = 50,
  ): Promise<FolderFile[]> {
    try {
      const q = parentId
        ? `mimeType='application/vnd.google-apps.folder' and '${escapeDriveQuery(parentId)}' in parents and trashed=false`
        : `mimeType='application/vnd.google-apps.folder' and trashed=false`;
      const res = await this.drive.files.list({
        q,
        pageSize,
        fields: "files(id,name,modifiedTime)",
        orderBy: "name",
        includeItemsFromAllDrives: true,  // include Shared Drive folders
        supportsAllDrives: true,           // app supports both My Drive and Shared Drives
        corpora: "allDrives",              // search across all drives the user has access to
      });
      return (res.data.files ?? []) as FolderFile[];
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Full-text search for spreadsheets by name or content across My Drive and
   * all Shared Drives the user is a member of.
   * Query values are properly escaped to prevent Drive query injection.
   * Google enforces the user's role in each Shared Drive on every call.
   */
  async searchSpreadsheets(
    searchQuery: string,
    pageSize = 20,
    folderId?: string,
  ): Promise<SpreadsheetFile[]> {
    try {
      // Drive API query strings use ' as delimiters — escape user input
      const folderClause = folderId ? ` and '${escapeDriveQuery(folderId)}' in parents` : "";
      const q = `mimeType='application/vnd.google-apps.spreadsheet' and fullText contains '${escapeDriveQuery(searchQuery)}' and trashed=false${folderClause}`;
      const res = await this.drive.files.list({
        q,
        pageSize,
        fields: "files(id,name,modifiedTime,webViewLink)",
        orderBy: "modifiedTime desc",
        includeItemsFromAllDrives: true,  // include Shared Drive spreadsheets
        supportsAllDrives: true,           // app supports both My Drive and Shared Drives
        corpora: "allDrives",              // search across all drives the user has access to
      });
      return (res.data.files ?? []) as SpreadsheetFile[];
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Search for a text string within cell values across all (or one) sheet in a spreadsheet.
   * Returns matching cell locations with sheet name, row, column (1-based), and value.
   * Case-insensitive. Skips sheets that cannot be read (e.g. protected).
   */
  async findInSpreadsheet(
    spreadsheetId: string,
    searchTerm: string,
    sheetName?: string,
  ): Promise<CellMatch[]> {
    try {
      // If no sheet specified, search all sheets
      const sheetsToSearch = sheetName
        ? [{ title: sheetName }]
        : await this.listSheets(spreadsheetId);

      const matches: CellMatch[] = [];
      const lowerTerm = searchTerm.toLowerCase();

      await Promise.all(
        sheetsToSearch.map(async (sheet) => {
          try {
            const res = await this.sheets.spreadsheets.values.get({
              spreadsheetId,
              range: `${sheet.title}!A1:ZZ${MAX_ROWS_HARD_CAP}`,
              valueRenderOption: "FORMATTED_VALUE",
            });
            const values = (res.data.values ?? []) as CellValue[][];
            values.forEach((row, rowIdx) => {
              row.forEach((cell, colIdx) => {
                if (cell !== null && String(cell).toLowerCase().includes(lowerTerm)) {
                  matches.push({
                    sheet: sheet.title,
                    row: rowIdx + 1,   // 1-based for human readability
                    col: colIdx + 1,   // 1-based for human readability
                    value: String(cell),
                  });
                }
              });
            });
          } catch {
            // Skip sheets we can't read — don't fail the whole search
          }
        }),
      );

      return matches;
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Search cell content across multiple spreadsheets in parallel.
   * Returns only spreadsheets that have at least one match.
   * Fetches spreadsheet display names in parallel with the cell search.
   * Falls back to the spreadsheet ID as name if the metadata call fails.
   */
  async searchAcrossSpreadsheets(
    spreadsheetIds: string[],
    searchTerm: string,
    maxResultsPerSheet: number,
  ): Promise<SpreadsheetSearchResult[]> {
    const results = await Promise.all(
      spreadsheetIds.map(async (id) => {
        const [spreadsheetName, searchOutcome] = await Promise.all([
          this.sheets.spreadsheets.get({ spreadsheetId: id, fields: "properties.title" })
            .then(res => res.data.properties?.title ?? id)
            .catch(() => id),
          this.findInSpreadsheet(id, searchTerm)
            .then(m => ({ ok: true as const, matches: m }))
            .catch(() => ({ ok: false as const })),
        ]);
        if (!searchOutcome.ok) {
          return { spreadsheetId: id, spreadsheetName, matches: [], error: true as const };
        }
        return {
          spreadsheetId: id,
          spreadsheetName,
          matches: searchOutcome.matches.slice(0, maxResultsPerSheet),
        };
      }),
    );
    return results;
  }

  /**
   * Fetch two sheet ranges and compare them using computeDiff.
   * rangeA/rangeB should be A1 notation ranges including the sheet tab name
   * if needed (e.g. "Sheet1!A1:ZZ1000").
   */
  async compareSheets(
    spreadsheetIdA: string,
    rangeA: string,
    spreadsheetIdB: string,
    rangeB: string,
    options: { keyColumn?: string; columns?: string[]; maxRows: number },
  ): Promise<CompareResult> {
    try {
      const [resA, resB] = await Promise.all([
        this.sheets.spreadsheets.values.get({
          spreadsheetId: spreadsheetIdA,
          range: rangeA,
          valueRenderOption: "FORMATTED_VALUE",
        }),
        this.sheets.spreadsheets.values.get({
          spreadsheetId: spreadsheetIdB,
          range: rangeB,
          valueRenderOption: "FORMATTED_VALUE",
        }),
      ]);

      const rawA = (resA.data.values ?? []) as CellValue[][];
      const rawB = (resB.data.values ?? []) as CellValue[][];

      if (rawA.length === 0) {
        throw new SheetsApiError("Sheet A has no accessible data.", 422);
      }
      if (rawB.length === 0) {
        throw new SheetsApiError("Sheet B has no accessible data.", 422);
      }

      const headersA = rawA[0].map(String);
      const rowsA = rawA.slice(1);
      const headersB = rawB[0].map(String);
      const rowsB = rawB.slice(1);

      return computeDiff(headersA, rowsA, headersB, rowsB, options);
    } catch (err) {
      if (err instanceof SheetsApiError) throw err;
      handleGoogleError(err);
    }
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  /**
   * Write values to a cell range. Existing values are overwritten.
   * Use USER_ENTERED input so formulas (=SUM(...)) are interpreted correctly.
   */
  async updateCells(
    spreadsheetId: string,
    range: string,
    values: CellValue[][],
  ): Promise<{ updatedCells: number }> {
    try {
      const res = await this.sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
      });
      return { updatedCells: res.data.updatedCells ?? 0 };
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Write values to multiple ranges in a single API call.
   * More efficient than multiple updateCells calls.
   */
  async batchUpdateCells(
    spreadsheetId: string,
    data: Array<{ range: string; values: CellValue[][] }>,
  ): Promise<{ totalUpdatedCells: number }> {
    try {
      const res = await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data,
        },
      });
      return { totalUpdatedCells: res.data.totalUpdatedCells ?? 0 };
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Insert empty rows at the specified zero-based index.
   * Requires the numeric sheetId (not the tab name) — use listSheets() to get it.
   */
  async addRows(
    spreadsheetId: string,
    sheetId: number,
    startIndex: number,
    count: number,
  ): Promise<void> {
    try {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            insertDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex,
                endIndex: startIndex + count,
              },
              inheritFromBefore: false,
            },
          }],
        },
      });
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Insert empty columns at the specified zero-based index.
   * Requires the numeric sheetId — use listSheets() to get it.
   */
  async addColumns(
    spreadsheetId: string,
    sheetId: number,
    startIndex: number,
    count: number,
  ): Promise<void> {
    try {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            insertDimension: {
              range: {
                sheetId,
                dimension: "COLUMNS",
                startIndex,
                endIndex: startIndex + count,
              },
              inheritFromBefore: false,
            },
          }],
        },
      });
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Create a new spreadsheet with a single "Sheet1" tab.
   * If folderId is provided, moves the new spreadsheet into that Drive folder.
   * Returns the spreadsheet ID and URL.
   */
  async createSpreadsheet(
    title: string,
    folderId?: string,
  ): Promise<{ spreadsheetId: string; url: string }> {
    try {
      const res = await this.sheets.spreadsheets.create({
        requestBody: {
          properties: { title },
          sheets: [{ properties: { title: "Sheet1", index: 0 } }],
        },
      });

      const spreadsheetId = res.data.spreadsheetId!;
      const url =
        res.data.spreadsheetUrl ??
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

      // Move to specified folder if provided
      if (folderId) {
        const fileRes = await this.drive.files.get({
          fileId: spreadsheetId,
          fields: "parents",
        });
        const prevParents = (fileRes.data.parents ?? []).join(",");
        await this.drive.files.update({
          fileId: spreadsheetId,
          addParents: folderId,
          removeParents: prevParents,
          fields: "id,parents",
        });
      }

      return { spreadsheetId, url };
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Add a new tab to an existing spreadsheet.
   * Returns the new tab's numeric sheetId and title.
   */
  async createSheet(
    spreadsheetId: string,
    title: string,
    index?: number,
  ): Promise<{ sheetId: number; title: string }> {
    try {
      const res = await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title,
                ...(index !== undefined ? { index } : {}),
              },
            },
          }],
        },
      });
      const added = res.data.replies?.[0]?.addSheet?.properties;
      return {
        sheetId: added?.sheetId ?? 0,
        title: added?.title ?? title,
      };
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Copy a sheet tab to a destination spreadsheet.
   * Returns the new tab's sheetId and title in the destination spreadsheet.
   */
  async copySheet(
    spreadsheetId: string,
    sheetId: number,
    destinationSpreadsheetId: string,
  ): Promise<{ sheetId: number; title: string }> {
    try {
      const res = await this.sheets.spreadsheets.sheets.copyTo({
        spreadsheetId,
        sheetId,
        requestBody: { destinationSpreadsheetId },
      });
      return {
        sheetId: res.data.sheetId ?? 0,
        title: res.data.title ?? "",
      };
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Rename a sheet tab. Requires the numeric sheetId — use listSheets() to get it.
   */
  async renameSheet(
    spreadsheetId: string,
    sheetId: number,
    newTitle: string,
  ): Promise<void> {
    try {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: { sheetId, title: newTitle },
              fields: "title",
            },
          }],
        },
      });
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Append rows to a sheet without needing to know the current row count.
   * Uses INSERT_ROWS to create new rows rather than overwriting empty cells.
   * Uses USER_ENTERED so formulas and dates are interpreted correctly.
   * Returns the range where data was actually written.
   */
  async appendRows(
    spreadsheetId: string,
    range: string,
    values: CellValue[][],
  ): Promise<{ appendedRange: string; appendedRows: number }> {
    try {
      const res = await this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values },
      });
      const appendedRange = res.data.updates?.updatedRange ?? range;
      const appendedRows = res.data.updates?.updatedRows ?? values.length;
      return { appendedRange, appendedRows };
    } catch (err) {
      handleGoogleError(err);
    }
  }
}
