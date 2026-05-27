import { test } from "node:test";
import assert from "node:assert/strict";
import { sheetNameFromRange, scopeFromValues } from "../audit.js";

test("sheetNameFromRange: standard A1 range → tab name", () => {
  assert.equal(sheetNameFromRange("Sheet1!A1:C3"), "Sheet1");
});

test("sheetNameFromRange: quoted tab name with spaces → unquoted", () => {
  assert.equal(sheetNameFromRange("'Q1 Report'!A1:Z100"), "Q1 Report");
});

test("sheetNameFromRange: no bang → undefined", () => {
  assert.equal(sheetNameFromRange("A1:C3"), undefined);
});

test("sheetNameFromRange: empty input → undefined", () => {
  assert.equal(sheetNameFromRange(undefined), undefined);
  assert.equal(sheetNameFromRange(""), undefined);
});

test("scopeFromValues: empty array → zero rows zero cells", () => {
  const { rows, cells } = scopeFromValues([]);
  assert.equal(rows, 0);
  assert.equal(cells, 0);
});

test("scopeFromValues: 3x2 rectangle → 3 rows, 6 cells", () => {
  const { rows, cells } = scopeFromValues([
    ["a", "b"],
    ["c", "d"],
    ["e", "f"],
  ]);
  assert.equal(rows, 3);
  assert.equal(cells, 6);
});

test("scopeFromValues: jagged rows → cells counted per row", () => {
  const { rows, cells } = scopeFromValues([
    ["a", "b", "c"],
    ["d"],
    ["e", "f"],
  ]);
  assert.equal(rows, 3);
  assert.equal(cells, 6);
});

test("scopeFromValues: 25 rows triggers bulk threshold (>20)", () => {
  const values = Array.from({ length: 25 }, () => ["x", "y", "z"]);
  const { rows, cells } = scopeFromValues(values);
  assert.equal(rows, 25);
  assert.equal(cells, 75);
  assert.ok(rows > 20, "25-row write should exceed default 20-row threshold");
});

test("scopeFromValues: exactly 20 rows is NOT bulk (boundary)", () => {
  const values = Array.from({ length: 20 }, () => ["x"]);
  const { rows } = scopeFromValues(values);
  assert.equal(rows, 20);
  assert.equal(rows > 20, false, "20-row write should NOT trigger >20 threshold");
});
