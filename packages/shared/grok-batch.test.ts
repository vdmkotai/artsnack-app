import assert from "node:assert/strict";
import test from "node:test";

import { runGrokOperationsIndependently } from "./grok-batch";

test("keeps successful Grok operations when siblings fail", async () => {
  const result = await runGrokOperationsIndependently([
    async () => "image-1",
    async () => {
      throw new Error("moderated");
    },
    async () => "image-3",
  ]);

  assert.deepEqual(result.successes, ["image-1", "image-3"]);
  assert.equal(result.failures.length, 1);
  assert.match(String(result.failures[0]), /moderated/);
});
