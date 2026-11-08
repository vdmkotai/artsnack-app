import assert from "node:assert/strict";
import { test } from "node:test";

import type { Id } from "@/convex/_generated/dataModel";

import { pendingHandoff, takeHandoff } from "./handoff-store";
import type { Reference } from "./use-composer";

test("ordered search references are consumed once without eating another composer's payload", () => {
  const first = { id: "reference-1", uri: "one" } as Reference;
  const second = { id: "reference-2", uri: "two" } as Reference;
  pendingHandoff.references = [first, second];
  pendingHandoff.recreateLocalId = "keep-me" as Id<"generations">;

  assert.deepEqual(takeHandoff("references"), { references: [first, second] });
  assert.deepEqual(takeHandoff("references"), {});
  assert.deepEqual(takeHandoff("recreateLocalId"), { recreateLocalId: "keep-me" });
});
