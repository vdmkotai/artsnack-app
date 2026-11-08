import assert from "node:assert/strict";
import test from "node:test";

import {
  atlasCanClaimPoll,
  atlasNeedsPollRescue,
  atlasRecoveryDeadline,
  tryAtlasHandoff,
  type AtlasPollLeaseRow,
} from "./atlas-lifecycle";

const NOW = 1_000_000;

function row(overrides: Partial<AtlasPollLeaseRow> = {}): AtlasPollLeaseRow {
  return {
    status: "processing",
    provider: "atlas",
    falRequestId: "prediction-1",
    atlasPollLeaseId: "worker-1",
    atlasPollLeaseUntil: NOW - 1,
    ...overrides,
  };
}

test("an Atlas prediction with no live poller is rescued", () => {
  assert.equal(atlasNeedsPollRescue(row(), NOW), true);
  assert.equal(
    atlasNeedsPollRescue(row({ atlasPollLeaseId: undefined, atlasPollLeaseUntil: undefined }), NOW),
    true,
  );
});

test("an active poll lease prevents duplicate recovery actions", () => {
  const active = row({ atlasPollLeaseUntil: NOW + 60_000 });
  assert.equal(atlasNeedsPollRescue(active, NOW), false);
  assert.equal(atlasCanClaimPoll(active, "worker-2", NOW), false);
  assert.equal(atlasCanClaimPoll(active, "worker-1", NOW), true);
});

test("only unfinished Atlas predictions participate in poll recovery", () => {
  assert.equal(atlasNeedsPollRescue(row({ status: "completed" }), NOW), false);
  assert.equal(atlasNeedsPollRescue(row({ status: "failed" }), NOW), false);
  assert.equal(atlasNeedsPollRescue(row({ provider: "fal" }), NOW), false);
  assert.equal(atlasNeedsPollRescue(row({ falRequestId: undefined }), NOW), false);
});

test("an expired lease may be claimed by a replacement poller", () => {
  assert.equal(atlasCanClaimPoll(row(), "worker-2", NOW), true);
});

test("recovery preserves the submitted request's exact deadline", () => {
  assert.equal(atlasRecoveryDeadline({ createdAt: 10, atlasWaitEndsAt: 50 }, 100), 50);
  assert.equal(atlasRecoveryDeadline({ createdAt: 10 }, 100), 110);
});

test("a transient scheduler failure stays recoverable for the watchdog", async () => {
  const errors: unknown[] = [];
  const scheduled = await tryAtlasHandoff(async () => {
    throw new Error("scheduler unavailable");
  }, errors.push.bind(errors));

  assert.equal(scheduled, false);
  assert.equal(errors.length, 1);
});
