import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_FEATURE_FLAGS, isFeatureFlagKey, resolveFeatureFlags } from "./feature-flags";

describe("resolveFeatureFlags", () => {
  test("no row means every flag is on", () => {
    assert.deepEqual(resolveFeatureFlags(null), DEFAULT_FEATURE_FLAGS);
    assert.deepEqual(resolveFeatureFlags(undefined), { higgsfield: true, fal: true });
  });

  test("a stored false overrides only its own flag", () => {
    assert.deepEqual(resolveFeatureFlags({ fal: false }), { higgsfield: true, fal: false });
  });

  test("unknown keys and non-boolean values are ignored", () => {
    assert.deepEqual(resolveFeatureFlags({ higgsfield: "no", other: false }), {
      higgsfield: true,
      fal: true,
    });
  });

  test("does not mutate the defaults", () => {
    resolveFeatureFlags({ higgsfield: false });
    assert.equal(DEFAULT_FEATURE_FLAGS.higgsfield, true);
  });

  test("isFeatureFlagKey", () => {
    assert.equal(isFeatureFlagKey("fal"), true);
    assert.equal(isFeatureFlagKey("grok"), false);
  });
});
