import assert from "node:assert/strict";
import test from "node:test";

import {
  FalError,
  classifyFalFailure,
  isFatalFalError,
  isQueueFailed,
  isQueueSettled,
  isUnbilledFailure,
  falStatusUrl,
  parseFalQueueStatus,
} from "./fal-queue";

test("an exhausted balance is never reported as a generic failure", () => {
  assert.equal(classifyFalFailure(402, "").kind, "billing");
  assert.equal(classifyFalFailure(403, "insufficient balance").kind, "billing");
  // Some gateways answer 500 with a billing body rather than a 402.
  assert.equal(classifyFalFailure(500, "account credit exhausted").kind, "billing");
  assert.match(classifyFalFailure(402, "").message, /out of balance/);
});

test("a plain 403 is an auth problem, not a billing one", () => {
  assert.equal(classifyFalFailure(403, "forbidden").kind, "auth");
  assert.equal(classifyFalFailure(401, "bad key").kind, "auth");
});

test("moderation is separated from ordinary input rejection", () => {
  assert.equal(classifyFalFailure(422, "violates content policy").kind, "moderation");
  assert.equal(classifyFalFailure(400, "NSFW content detected").kind, "moderation");
  assert.equal(classifyFalFailure(422, "image_size out of range").kind, "validation");
});

test("rate limits and server errors stay distinct from both", () => {
  assert.equal(classifyFalFailure(429, "slow down").kind, "rate_limit");
  assert.equal(classifyFalFailure(503, "upstream unavailable").kind, "server");
});

test("the response body is surfaced, but bounded", () => {
  const long = "x".repeat(1000);
  const error = classifyFalFailure(500, long);
  assert.ok(error.message.length < 400, "body should be truncated");
  assert.ok(error.message.includes("xxx"));
  // An empty body must not leave a dangling colon.
  assert.ok(!classifyFalFailure(500, "").message.endsWith(":"));
});

test("only pre-execution verdicts abort the poll loop", () => {
  for (const kind of ["auth", "billing", "validation", "moderation"] as const) {
    assert.equal(isFatalFalError(new FalError("x", kind)), true, kind);
  }
  // These mean the job may still be running — and being charged for.
  for (const kind of ["rate_limit", "server", "timeout"] as const) {
    assert.equal(isFatalFalError(new FalError("x", kind)), false, kind);
  }
  // A bare network error carries no verdict, so it must not abort either.
  assert.equal(isFatalFalError(new Error("fetch failed")), false);
});

test("only pre-execution verdicts mean nothing was billed", () => {
  assert.equal(isUnbilledFailure("billing"), true);
  assert.equal(isUnbilledFailure("moderation"), true);
  // The model ran before these happened, so the charge is real.
  assert.equal(isUnbilledFailure("timeout"), false);
  assert.equal(isUnbilledFailure("server"), false);
  assert.equal(isUnbilledFailure(undefined), false);
});

test("queue states are read the way fal reports them", () => {
  assert.equal(isQueueSettled("COMPLETED"), true);
  assert.equal(isQueueSettled("OK"), true);
  assert.equal(isQueueSettled("IN_QUEUE"), false);
  assert.equal(isQueueSettled("IN_PROGRESS"), false);

  assert.equal(isQueueFailed("FAILED"), true);
  assert.equal(isQueueFailed("CANCELLED"), true);
  assert.equal(isQueueFailed("IN_PROGRESS"), false);
});

test("status polling requests and preserves fal runner progress", () => {
  const url = new URL(falStatusUrl("https://queue.fal.run/model/requests/id/status?foo=bar"));
  assert.equal(url.searchParams.get("logs"), "1");
  assert.equal(url.searchParams.get("foo"), "bar");

  assert.deepEqual(
    parseFalQueueStatus({
      status: "IN_PROGRESS",
      queue_position: 3,
      logs: [{ message: "Loading model", timestamp: "2026-08-25T10:00:00Z" }, { message: 42 }, {}],
    }),
    {
      status: "IN_PROGRESS",
      queuePosition: 3,
      error: undefined,
      logs: [{ message: "Loading model", timestamp: "2026-08-25T10:00:00Z" }],
    },
  );
});
