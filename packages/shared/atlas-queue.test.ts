import assert from "node:assert/strict";
import test from "node:test";

import {
  atlasPoll,
  classifyAtlasFailure,
  isAtlasFailed,
  isAtlasSettled,
  readAtlasPrice,
} from "./atlas-queue";

/**
 * The envelope shapes Atlas actually returns, transcribed from live replies.
 * `unwrap` is not exported, so the behaviour is exercised through the readers
 * that use it — see the processor for the loop these feed.
 */

test("a dead prediction is not mistaken for a transient server error", () => {
  // The live reply from a job whose upstream refused it. It was polled for
  // sixteen minutes because the envelope's 500 was read before data.status.
  const body = {
    code: 500,
    message: "api node returned 401",
    data: { id: "x", status: "failed", error: "api node returned 401", outputs: null },
  };
  assert.equal(isAtlasFailed(String(body.data.status)), true);
  assert.equal(isAtlasSettled(String(body.data.status)), false);
});

test("failure classification reads the reason, whichever key carries it", () => {
  assert.match(classifyAtlasFailure(401, "unauthorized").message, /unauthorized/);
  assert.equal(classifyAtlasFailure(401, "").kind, "auth");
  assert.equal(classifyAtlasFailure(402, "").kind, "billing");
  assert.equal(classifyAtlasFailure(429, "").kind, "rate_limit");
  assert.equal(classifyAtlasFailure(400, "content policy").kind, "moderation");
  assert.equal(classifyAtlasFailure(500, "").kind, "server");
});

test("terminal statuses are recognised in every spelling Atlas uses", () => {
  for (const status of ["failed", "error", "timeout", "cancelled", "FAILED"]) {
    assert.equal(isAtlasFailed(status), true, status);
  }
  for (const status of ["completed", "succeeded", "success", "COMPLETED"]) {
    assert.equal(isAtlasSettled(status), true, status);
  }
  for (const status of ["processing", "created", "queued"]) {
    assert.equal(isAtlasFailed(status) || isAtlasSettled(status), false, status);
  }
});

test("the final price accepts the numeric string Atlas returns in production", () => {
  assert.equal(readAtlasPrice("7.56"), 7.56);
  assert.equal(readAtlasPrice(7.56), 7.56);
  assert.equal(readAtlasPrice("0"), undefined);
  assert.equal(readAtlasPrice("not-a-price"), undefined);
});

test("the production completion envelope carries its string price through atlasPoll", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 200,
        data: {
          id: "prediction-1",
          status: "completed",
          outputs: ["https://example.com/result.mp4"],
          price: "7.56",
        },
      }),
      { status: 200 },
    );

  try {
    const prediction = await atlasPoll("/model/{request_id}", "prediction-1", "secret", 1_000);
    assert.equal(prediction.priceUsd, 7.56);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
