import assert from "node:assert/strict";
import test from "node:test";

import { parseRetryAfterMs, rateLimitWaitMs, withRateLimitRetry } from "./rate-limit-retry";

class RateLimited extends Error {
  constructor(readonly waitMs: number | null = null) {
    super("429");
  }
}

const rateLimitWait = (error: unknown) => (error instanceof RateLimited ? error.waitMs : undefined);

test("a rate limit is waited out and the second attempt's answer returned", async () => {
  const waits: number[] = [];
  let calls = 0;
  const result = await withRateLimitRetry(
    async () => {
      calls++;
      if (calls < 3) throw new RateLimited();
      return "ok";
    },
    { rateLimitWaitMs: rateLimitWait, sleep: async (ms) => void waits.push(ms), random: () => 0.5 },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  // ±25% jitter around 2 s and 4 s; 0.5 lands on the base itself.
  assert.deepEqual(waits, [2_000, 4_000]);
});

test("anything that is not a rate limit is thrown at once", async () => {
  let calls = 0;
  await assert.rejects(
    withRateLimitRetry(
      async () => {
        calls++;
        throw new Error("HTTP 500");
      },
      { rateLimitWaitMs: rateLimitWait, sleep: async () => {} },
    ),
    /HTTP 500/,
  );
  assert.equal(calls, 1);
});

test("retries stop after the schedule runs out and the 429 surfaces", async () => {
  let calls = 0;
  await assert.rejects(
    withRateLimitRetry(
      async () => {
        calls++;
        throw new RateLimited();
      },
      { rateLimitWaitMs: rateLimitWait, sleep: async () => {}, delaysMs: [1, 1] },
    ),
    RateLimited,
  );
  assert.equal(calls, 3);
});

test("jitter spreads siblings, and a vendor's Retry-After is never undercut", () => {
  assert.equal(rateLimitWaitMs(0, null, { random: () => 0 }), 1_500);
  assert.equal(rateLimitWaitMs(0, null, { random: () => 1 }), 2_500);
  assert.equal(rateLimitWaitMs(9, null, { random: () => 0.5 }), 16_000);
  assert.equal(rateLimitWaitMs(0, null, { random: () => 1, delaysMs: [60_000] }), 30_000);
  assert.equal(rateLimitWaitMs(0, 7_000, { random: () => 0 }), 7_000);
  assert.equal(rateLimitWaitMs(0, 7_000, { random: () => 1 }), 7_500);
  // Not capped: retrying before the vendor's time only burns attempts.
  assert.equal(rateLimitWaitMs(0, 120_000, { random: () => 0 }), 120_000);
});

test("a wait that does not fit the budget fails at once instead of retrying early", async () => {
  // Retry-After: 180 used to be cut to 30 s, so every attempt met the same
  // refusal and the job failed after two minutes of waiting anyway.
  const waits: number[] = [];
  let calls = 0;
  await assert.rejects(
    withRateLimitRetry(
      async () => {
        calls++;
        throw new RateLimited(180_000);
      },
      { rateLimitWaitMs: rateLimitWait, sleep: async (ms) => void waits.push(ms) },
    ),
    RateLimited,
  );
  assert.equal(calls, 1);
  assert.equal(waits.length, 0);

  // Within the budget, the vendor's figure is waited out in full.
  calls = 0;
  const result = await withRateLimitRetry(
    async () => {
      calls++;
      if (calls === 1) throw new RateLimited(40_000);
      return "ok";
    },
    { rateLimitWaitMs: rateLimitWait, sleep: async (ms) => void waits.push(ms), random: () => 0 },
  );
  assert.equal(result, "ok");
  assert.deepEqual(waits, [40_000]);
});

test("Retry-After is read as seconds or as an HTTP date", () => {
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs("3"), 3_000);
  assert.equal(parseRetryAfterMs("1.5"), 1_500);
  const now = Date.parse("2026-10-28T12:00:00Z");
  assert.equal(parseRetryAfterMs("Wed, 28 Oct 2026 12:00:05 GMT", now), 5_000);
  assert.equal(parseRetryAfterMs("soon"), null);
});
