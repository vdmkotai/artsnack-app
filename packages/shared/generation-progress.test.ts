import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  generationProgressLabel,
  generationProgressPercent,
  sanitizeProgressMessage,
} from "./generation-progress";

describe("generation progress", () => {
  test("reports only determinate progress with a valid total", () => {
    assert.equal(generationProgressPercent({ progressCurrent: 6, progressTotal: 24 }), 25);
    assert.equal(generationProgressPercent({ progressCurrent: 30, progressTotal: 24 }), 100);
    assert.equal(generationProgressPercent({ progressCurrent: 1, progressTotal: 0 }), undefined);
  });

  test("uses real queue position and provider messages", () => {
    assert.equal(
      generationProgressLabel({ progressStage: "provider-queued", queuePosition: 2 }),
      "2 jobs ahead...",
    );
    assert.equal(
      generationProgressLabel({
        progressStage: "generating",
        mediaType: "video",
        progressMessage: "  Loading   model weights...\n",
      }),
      "Loading model weights...",
    );
    assert.equal(
      generationProgressLabel({
        progressStage: "preparing",
        progressMessage: "Checking provider availability...",
      }),
      "Checking provider availability...",
    );
    assert.equal(
      generationProgressLabel({
        progressStage: "preparing-inputs",
        mediaType: "video",
        progressMessage: "Downloading source image...",
      }),
      "Downloading source image...",
    );
    assert.equal(
      generationProgressLabel({
        progressStage: "submitting",
        progressMessage: "Sending video to Grok...",
      }),
      "Sending video to Grok...",
    );
  });

  test("keeps legacy rows readable", () => {
    assert.equal(
      generationProgressLabel({ status: "processing", mediaType: "video" }),
      "Generating video...",
    );
    assert.equal(
      generationProgressLabel({ status: "pending", dispatchedAt: undefined }),
      "Waiting for a worker slot...",
    );
    assert.equal(
      generationProgressLabel({ progressStage: "queued", dispatchedAt: Date.now() }),
      "Queued...",
    );
    assert.equal(
      generationProgressLabel({
        progressStage: "queued",
        progressMessage: "Waiting for video worker...",
      }),
      "Waiting for video worker...",
    );
  });

  test("bounds provider text before it reaches a card", () => {
    assert.equal(sanitizeProgressMessage(" a\n\n b "), "a b");
    assert.equal(sanitizeProgressMessage("x".repeat(200))?.length, 160);
  });
});
