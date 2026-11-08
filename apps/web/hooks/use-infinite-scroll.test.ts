import assert from "node:assert/strict";
import test from "node:test";

import { shouldPauseAutomaticPaging } from "./use-infinite-scroll";

test("keeps paging after idle filtered pages while the results column is underfilled", () => {
  const underfilledColumn = { clientHeight: 1_500, scrollHeight: 1_500 };

  assert.equal(shouldPauseAutomaticPaging(3, underfilledColumn), false);
});

test("may pause idle paging once the user has enough content to scroll", () => {
  const overflowingColumn = { clientHeight: 1_500, scrollHeight: 2_000 };

  assert.equal(shouldPauseAutomaticPaging(3, overflowingColumn), true);
});

test("never pauses while the sentinel is on screen, whatever the zoom made of the grid", () => {
  // A filtered grid just taller than its column: three empty pages in a row
  // used to stop paging here with the end of the list in plain view.
  const barelyOverflowing = { clientHeight: 844, scrollHeight: 1_000 };

  assert.equal(shouldPauseAutomaticPaging(3, barelyOverflowing, false), true);
  assert.equal(shouldPauseAutomaticPaging(3, barelyOverflowing, true), false);
});

test("with the end in view, an external feed gets a longer leash and a finite one none", () => {
  const overflowing = { clientHeight: 844, scrollHeight: 4_000 };

  assert.equal(shouldPauseAutomaticPaging(9, overflowing, true), false);
  assert.equal(shouldPauseAutomaticPaging(10, overflowing, true), true);
  assert.equal(shouldPauseAutomaticPaging(500, overflowing, true, Infinity), false);
  // Underfilled stays unconditional: nothing could scroll it back into motion.
  assert.equal(
    shouldPauseAutomaticPaging(500, { clientHeight: 844, scrollHeight: 844 }, true),
    false,
  );
});
