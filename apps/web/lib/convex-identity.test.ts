import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { observeConvexIdentity, resetConvexIdentityForTests } from "./convex-identity-state";

beforeEach(() => resetConvexIdentityForTests());

test("a first load confirms the user once Convex has gone from loading to ready", () => {
  assert.equal(observeConvexIdentity(null, false), null);
  assert.equal(observeConvexIdentity("A", false), null);
  assert.equal(observeConvexIdentity("A", true), "A");
});

test("a session switch is not confirmed while Convex still reports the old token", () => {
  observeConvexIdentity("A", false);
  observeConvexIdentity("A", true);
  // Clerk says B, Convex still says ready — that readiness belongs to A.
  assert.equal(observeConvexIdentity("B", true), null);
  assert.equal(observeConvexIdentity("B", true), null);
  // Convex drops A's token, then confirms B's.
  assert.equal(observeConvexIdentity("B", false), null);
  assert.equal(observeConvexIdentity("B", true), "B");
});

test("the same user's token refresh keeps the confirmation; sign-out clears it", () => {
  observeConvexIdentity("A", false);
  observeConvexIdentity("A", true);
  assert.equal(observeConvexIdentity("A", false), "A");
  assert.equal(observeConvexIdentity("A", true), "A");
  assert.equal(observeConvexIdentity(null, false), null);
});
