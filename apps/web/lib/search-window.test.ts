import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  FRESH_SEARCH_WINDOW,
  SEARCH_RESTORE_BEFORE,
  SEARCH_RESTORE_THRESHOLD,
  SEARCH_WINDOW_PAGE,
  firstVisibleIndex,
  growSearchWindowAfter,
  growSearchWindowBefore,
  resolveSearchWindow,
  restoredAnchorIndex,
  restoredSearchWindow,
  type SearchScrollPosition,
} from "@/lib/search-window";

const results = (count: number, prefix = "r") =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}` }));

const position = (anchorKey: string | null, anchorIndex: number): SearchScrollPosition => ({
  intentKey: "",
  anchorKey,
  anchorIndex,
  anchorOffset: 120,
});

describe("search grid window", () => {
  test("an ordinary grid starts at the top and grows a page at a time", () => {
    const list = results(1000);
    assert.deepEqual(resolveSearchWindow(list, FRESH_SEARCH_WINDOW), {
      start: 0,
      pivot: 0,
      end: SEARCH_WINDOW_PAGE,
    });
    assert.equal(
      resolveSearchWindow(list, growSearchWindowAfter(FRESH_SEARCH_WINDOW)).end,
      SEARCH_WINDOW_PAGE * 2,
    );
    assert.equal(resolveSearchWindow(results(10), FRESH_SEARCH_WINDOW).end, 10);
  });

  test("finds the anchor by id, or falls back to where it was", () => {
    const list = results(500);
    assert.equal(restoredAnchorIndex(list, position("r321", 0)), 321);
    assert.equal(restoredAnchorIndex(list, position("deleted", 321)), 321);
    assert.equal(restoredAnchorIndex(list, position("deleted", 9000)), 499);
    assert.equal(restoredAnchorIndex([], position("r1", 1)), 0);
  });

  test("an anchor near the top restores as an ordinary grid that reaches past it", () => {
    const window = restoredSearchWindow(results(500), SEARCH_RESTORE_THRESHOLD - 1);
    assert.equal(window.pivotId, null);
    assert.deepEqual(resolveSearchWindow(results(500), window), {
      start: 0,
      pivot: 0,
      end: SEARCH_RESTORE_THRESHOLD - 1 + SEARCH_WINDOW_PAGE,
    });
  });

  test("a deep anchor mounts a window around it instead of everything above it", () => {
    const list = results(5000);
    const window = restoredSearchWindow(list, 3000);
    const range = resolveSearchWindow(list, window);
    assert.deepEqual(range, {
      start: 3000 - SEARCH_RESTORE_BEFORE,
      pivot: 3000,
      end: 3000 + SEARCH_WINDOW_PAGE,
    });
    const earlier = growSearchWindowBefore(window, range.pivot);
    assert.equal(
      resolveSearchWindow(list, earlier).start,
      3000 - SEARCH_RESTORE_BEFORE - SEARCH_WINDOW_PAGE,
    );
    let all = window;
    for (let step = 0; step < 40; step += 1) all = growSearchWindowBefore(all, range.pivot);
    assert.equal(resolveSearchWindow(list, all).start, 0);
    assert.equal(all.before, 3000, "never grows past the top");
  });

  test("stays on the same results when new ones arrive at the top", () => {
    const list = results(5000);
    const window = restoredSearchWindow(list, 3000);
    const before = resolveSearchWindow(list, window);
    const grown = [{ id: "new-1" }, { id: "new-2" }, ...list];
    const after = resolveSearchWindow(grown, window);
    assert.equal(grown[after.pivot].id, list[before.pivot].id);
    assert.equal(grown[after.start].id, list[before.start].id);
    assert.equal(grown[after.end - 1].id, list[before.end - 1].id);
  });

  test("a deleted pivot falls back to its old index", () => {
    const list = results(5000);
    const window = restoredSearchWindow(list, 3000);
    const without = list.filter((result) => result.id !== "r3000");
    assert.equal(resolveSearchWindow(without, window).pivot, 3000);
    assert.equal(resolveSearchWindow(results(100), window).pivot, 99);
  });
});

describe("first visible tile", () => {
  const boxes = (bottoms: number[]) =>
    bottoms.map((bottom) => ({ getBoundingClientRect: () => ({ bottom }) }));

  test("returns the first box whose bottom is below the viewport top", () => {
    // Three rows of tiles; rows share a bottom edge.
    const grid = boxes([-400, -400, -130, -130, -130, 140, 140, 410]);
    assert.equal(firstVisibleIndex(grid, 56), 5);
    assert.equal(firstVisibleIndex(grid, -200), 2);
    assert.equal(firstVisibleIndex(grid, 500), -1);
    assert.equal(firstVisibleIndex([], 0), -1);
  });
});
