import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDiff } from "../sheets-client.js";

test("positional: identical sheets → zero differences", () => {
  const headers = ["Name", "Salary"];
  const rows = [["Alice", "100000"], ["Bob", "90000"]];
  const result = computeDiff(headers, rows, headers, rows, {});
  assert.equal(result.differences.length, 0);
  assert.equal(result.summary.rowsDifferent, 0);
  assert.equal(result.summary.rowsMatched, 2);
  assert.equal(result.truncated, false);
});

test("positional: changed cell → correct diff entry", () => {
  const headers = ["Name", "Salary"];
  const rowsA = [["Alice", "100000"], ["Bob", "90000"]];
  const rowsB = [["Alice", "110000"], ["Bob", "90000"]];
  const result = computeDiff(headers, rowsA, headers, rowsB, {});
  assert.equal(result.summary.rowsDifferent, 1);
  assert.equal(result.differences[0].type, "changed");
  assert.equal(result.differences[0].key, 2); // spreadsheet row 2 (row 1 is header)
  assert.deepEqual(result.differences[0].changes[0], {
    column: "Salary", valueA: "100000", valueB: "110000",
  });
  assert.deepEqual(result.summary.columnChangeCounts, { Salary: 1 });
});

test("positional: B has extra rows → added", () => {
  const headers = ["Name", "Salary"];
  const rowsA = [["Alice", "100000"]];
  const rowsB = [["Alice", "100000"], ["Bob", "90000"]];
  const result = computeDiff(headers, rowsA, headers, rowsB, {});
  assert.equal(result.summary.rowsOnlyInB, 1);
  assert.equal(result.differences[0].type, "added");
  assert.equal(result.differences[0].key, 3); // spreadsheet row 3
});

test("positional: A has extra rows → removed", () => {
  const headers = ["Name", "Salary"];
  const rowsA = [["Alice", "100000"], ["Bob", "90000"]];
  const rowsB = [["Alice", "100000"]];
  const result = computeDiff(headers, rowsA, headers, rowsB, {});
  assert.equal(result.summary.rowsOnlyInA, 1);
  assert.equal(result.differences[0].type, "removed");
});

test("key mode: rows matched regardless of order", () => {
  const headers = ["Email", "Salary"];
  const rowsA = [["user@example.com", "100000"], ["user@example.com", "90000"]];
  const rowsB = [["user@example.com", "95000"], ["user@example.com", "100000"]];
  const result = computeDiff(headers, rowsA, headers, rowsB, { keyColumn: "Email" });
  assert.equal(result.summary.rowsDifferent, 1);
  assert.equal(result.differences[0].key, "user@example.com");
  assert.equal(result.differences[0].changes[0].column, "Salary");
  assert.equal(result.differences[0].changes[0].valueA, "90000");
  assert.equal(result.differences[0].changes[0].valueB, "95000");
});

test("key mode: row only in A → removed", () => {
  const headers = ["Email", "Salary"];
  const rowsA = [["user@example.com", "100000"], ["user@example.com", "90000"]];
  const rowsB = [["user@example.com", "100000"]];
  const result = computeDiff(headers, rowsA, headers, rowsB, { keyColumn: "Email" });
  assert.equal(result.summary.rowsOnlyInA, 1);
  assert.equal(result.differences.some(d => d.type === "removed" && d.key === "user@example.com"), true);
});

test("key mode: row only in B → added", () => {
  const headers = ["Email", "Salary"];
  const rowsA = [["user@example.com", "100000"]];
  const rowsB = [["user@example.com", "100000"], ["user@example.com", "80000"]];
  const result = computeDiff(headers, rowsA, headers, rowsB, { keyColumn: "Email" });
  assert.equal(result.summary.rowsOnlyInB, 1);
  assert.equal(result.differences.some(d => d.type === "added" && d.key === "user@example.com"), true);
});

test("key mode: missing key_column throws", () => {
  const headersA = ["Email", "Salary"];
  const headersB = ["Name", "Salary"];
  assert.throws(
    () => computeDiff(headersA, [], headersB, [], { keyColumn: "Email" }),
    /not found in sheet B/,
  );
});

test("key mode: unknown columns filter throws", () => {
  const headers = ["Email", "Salary"];
  const rows = [["user@example.com", "100000"]];
  assert.throws(
    () => computeDiff(headers, rows, headers, rows, { keyColumn: "Email", columns: ["Ghost"] }),
    /not found in either sheet/,
  );
});

test("positional: columns filter uses correct column from each sheet", () => {
  const headersA = ["Name", "Salary", "Department"];
  const headersB = ["Department", "Name", "Salary"];
  const rowsA = [["Alice", "100000", "Engineering"]];
  const rowsB = [["Engineering", "Alice", "110000"]];
  const result = computeDiff(headersA, rowsA, headersB, rowsB, { columns: ["Salary"] });
  assert.equal(result.summary.rowsDifferent, 1);
  assert.equal(result.differences[0].changes[0].column, "Salary");
  assert.equal(result.differences[0].changes[0].valueA, "100000");
  assert.equal(result.differences[0].changes[0].valueB, "110000");
});

test("key mode: B-only columns included in default comparison", () => {
  const headersA = ["Email", "Salary"];
  const headersB = ["Email", "Salary", "Department"];
  const rowsA = [["user@example.com", "100000"]];
  const rowsB = [["user@example.com", "100000", "Engineering"]];
  const result = computeDiff(headersA, rowsA, headersB, rowsB, { keyColumn: "Email" });
  assert.equal(result.summary.rowsMatched, 1);
  assert.equal(result.differences.length, 1);
  assert.equal(result.differences[0].type, "changed");
  assert.equal(result.differences[0].changes[0].column, "Department");
  assert.equal(result.differences[0].changes[0].valueA, null);
  assert.equal(result.differences[0].changes[0].valueB, "Engineering");
});

test("positional: null cell and empty-string cell treated as equal", () => {
  const headers = ["Name", "Notes"];
  const rowsA = [["Alice", null]];
  const rowsB = [["Alice", ""]];
  const result = computeDiff(headers, rowsA, headers, rowsB, {});
  assert.equal(result.summary.rowsDifferent, 0);
  assert.equal(result.differences.length, 0);
});

test("differences array capped at 500 with truncated flag", () => {
  const headers = ["ID", "Value"];
  // 501 rows in A, all different values in B
  const rowsA = Array.from({ length: 501 }, (_, i) => [String(i), "A"]);
  const rowsB = Array.from({ length: 501 }, (_, i) => [String(i), "B"]);
  const result = computeDiff(headers, rowsA, headers, rowsB, {});
  assert.equal(result.truncated, true);
  assert.equal(result.differences.length, 500);
});
