import assert from "node:assert/strict";
import { test } from "node:test";

import { validateSavedSearchInput } from "./savedSearches";

test("saved search validation trims names and accepts the documented limits", () => {
  assert.equal(validateSavedSearchInput("  Beach references  ", "q=beach"), "Beach references");
  assert.equal(validateSavedSearchInput("x".repeat(80), "x".repeat(16_000)), "x".repeat(80));
});

test("saved search validation rejects blank, overlong and empty payloads", () => {
  assert.throws(() => validateSavedSearchInput("   ", "q=beach"), /1–80/);
  assert.throws(() => validateSavedSearchInput("x".repeat(81), "q=beach"), /1–80/);
  assert.throws(() => validateSavedSearchInput("Beach", ""), /too large/);
  assert.throws(() => validateSavedSearchInput("Beach", "x".repeat(16_001)), /too large/);
});
