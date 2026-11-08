import assert from "node:assert/strict";
import test from "node:test";

import { MAX_PAGE_ROWS, pageRowsFor } from "./page-rows";

const screen = 844;

test("asks for the composer's usual page until the grid has been measured", () => {
  assert.equal(pageRowsFor(null, 30, screen), 30);
  assert.equal(pageRowsFor({ columns: 3, columnWidth: 283, height: 0 }, 0, 0), 30);
});

test("keeps 30 rows at 100% preview zoom, where they already cover two screens", () => {
  // 30 rows of single images in three ~283px columns: about 2,900px of grid.
  assert.equal(pageRowsFor({ columns: 3, columnWidth: 283, height: 2_900 }, 30, screen), 30);
});

test("sizes by the pixels each loaded row actually filled", () => {
  // 25%: 60 rows laid out to 300px — five pixels a row — so two screens is ~340 rows.
  assert.equal(pageRowsFor({ columns: 14, columnWidth: 56, height: 300 }, 60, screen), 338);
  // Wide clips at 25% on a big screen want more than any page should be.
  assert.equal(
    pageRowsFor({ columns: 24, columnWidth: 32, height: 120 }, 60, 1_440),
    MAX_PAGE_ROWS,
  );
});

test("a filter that shows little asks for more, since its rows fill less", () => {
  const unfiltered = pageRowsFor({ columns: 7, columnWidth: 118, height: 1_200 }, 60, screen);
  const filtered = pageRowsFor({ columns: 7, columnWidth: 118, height: 240 }, 60, screen);
  assert.ok(filtered > unfiltered, `${filtered} > ${unfiltered}`);
});

test("before anything is laid out, the column count stands in", () => {
  assert.equal(pageRowsFor({ columns: 14, columnWidth: 56, height: 0 }, 0, screen), 400);
  assert.equal(pageRowsFor({ columns: 3, columnWidth: 283, height: 0 }, 0, screen), 30);
});
