import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  COMFY_PROGRESS_MIN_INTERVAL_MS,
  ComfyProgressGate,
  comfyNodeLabelsForWorkflow,
  comfyProgressFromMessage,
  comfyQueueState,
  progressChanged,
  type ComfyProgressUpdate,
} from "./comfyui-progress";

describe("ComfyUI progress", () => {
  test("turns sampler events into exact node progress", () => {
    const labels = comfyNodeLabelsForWorkflow(
      { "3": { class_type: "KSampler", inputs: {} } },
      "image",
    );
    assert.deepEqual(
      comfyProgressFromMessage(
        { type: "progress", data: { prompt_id: "p", node: "3", value: 7, max: 20 } },
        "p",
        labels,
        "image",
      ),
      {
        stage: "generating",
        message: "Sampling image · 7/20",
        current: 7,
        total: 20,
      },
    );
  });

  test("ignores another prompt's WebSocket messages", () => {
    assert.equal(
      comfyProgressFromMessage(
        { type: "execution_start", data: { prompt_id: "other" } },
        "mine",
        {},
        "video",
      ),
      null,
    );
  });

  test("finds running and queued prompts in ComfyUI tuples", () => {
    const queue = {
      queue_running: [[1, "running", {}]],
      queue_pending: [
        [2, "first", {}],
        [3, "mine", {}],
      ],
    };
    assert.deepEqual(comfyQueueState(queue, "running"), { state: "running" });
    assert.deepEqual(comfyQueueState(queue, "mine"), { state: "queued", position: 1 });
    assert.deepEqual(comfyQueueState(queue, "absent"), { state: "missing" });
  });
});

describe("stored progress changes", () => {
  const row = {
    progressStage: "queued",
    progressMessage: "2 jobs ahead on the video pod…",
    queuePosition: 2,
  };

  test("the same report again is not a change", () => {
    assert.equal(progressChanged(row, { ...row }), false);
    // Absent and explicitly undefined are the same stored value.
    assert.equal(
      progressChanged(row, { ...row, progressCurrent: undefined, providerStatus: undefined }),
      false,
    );
  });

  test("any displayed column moving is a change", () => {
    assert.equal(progressChanged(row, { ...row, queuePosition: 1 }), true);
    assert.equal(progressChanged(row, { ...row, progressMessage: "Next…" }), true);
    assert.equal(progressChanged(row, { ...row, progressStage: "generating" }), true);
    assert.equal(progressChanged(row, { ...row, providerStatus: "queued" }), true);
  });

  test("a report that clears a column is a change", () => {
    const counting = { progressStage: "generating", progressCurrent: 3, progressTotal: 20 };
    assert.equal(progressChanged(counting, { progressStage: "generating" }), true);
  });
});

describe("progress gate", () => {
  const step = (current: number, total = 30): ComfyProgressUpdate => ({
    stage: "generating",
    message: `Sampling image · ${current}/${total}`,
    current,
    total,
  });
  const node = (message: string): ComfyProgressUpdate => ({ stage: "generating", message });

  test("sends the first update at once", () => {
    const gate = new ComfyProgressGate();
    assert.deepEqual(gate.offer(node("Loading models..."), 0), {
      send: node("Loading models..."),
      flushAt: null,
    });
  });

  test("drops an exact repeat", () => {
    const gate = new ComfyProgressGate();
    gate.offer(node("Loading models..."), 0);
    assert.deepEqual(gate.offer(node("Loading models..."), 5_000), { send: null, flushAt: null });
  });

  test("holds per-node labels inside the window and flushes the latest", () => {
    const gate = new ComfyProgressGate();
    gate.offer(node("Starting workflow..."), 0);
    assert.deepEqual(gate.offer(node("Loading models..."), 100), {
      send: null,
      flushAt: COMFY_PROGRESS_MIN_INTERVAL_MS,
    });
    // A newer label replaces the held one; the window does not move.
    assert.deepEqual(gate.offer(node("Decoding frames..."), 300), {
      send: null,
      flushAt: COMFY_PROGRESS_MIN_INTERVAL_MS,
    });
    // Too early: still held.
    assert.deepEqual(gate.flush(900), { send: null, flushAt: COMFY_PROGRESS_MIN_INTERVAL_MS });
    // The node that then runs for a minute without a bar still gets its label.
    assert.deepEqual(gate.flush(1_000), { send: node("Decoding frames..."), flushAt: null });
    assert.deepEqual(gate.flush(1_500), { send: null, flushAt: null });
  });

  test("going back to what was sent discards the held update", () => {
    const gate = new ComfyProgressGate();
    gate.offer(node("Loading models..."), 0);
    gate.offer(node("Running workflow..."), 200);
    assert.deepEqual(gate.offer(node("Loading models..."), 400), { send: null, flushAt: null });
    assert.deepEqual(gate.flush(1_000), { send: null, flushAt: null });
  });

  test("sampler steps go out at most once a window, the last step at once", () => {
    const gate = new ComfyProgressGate();
    const sent: number[] = [];
    let flushAt: number | null = null;
    // 30 steps at 20 per second: 1.5 s of sampling.
    for (let index = 1; index <= 30; index++) {
      const now = index * 50;
      if (flushAt !== null && now >= flushAt) {
        const flushed = gate.flush(flushAt);
        if (flushed.send) sent.push(flushed.send.current!);
        flushAt = flushed.flushAt;
      }
      const next = gate.offer(step(index), now);
      if (next.send) sent.push(next.send.current!);
      flushAt ??= next.flushAt;
    }
    assert.deepEqual(sent, [1, 20, 30]);
  });

  test("the finalizing hand-off is never held", () => {
    const gate = new ComfyProgressGate();
    gate.offer(step(29), 0);
    const finalizing: ComfyProgressUpdate = {
      stage: "finalizing",
      message: "Collecting output...",
    };
    assert.deepEqual(gate.offer(finalizing, 10), { send: finalizing, flushAt: null });
  });

  test("an urgent update restarts the window for a held one", () => {
    const gate = new ComfyProgressGate();
    gate.offer(node("Loading models..."), 0);
    gate.offer(node("Running workflow..."), 100); // held, due at 1000
    gate.offer(step(30, 30), 500); // urgent: sent, window now ends at 1500
    gate.offer(node("Encoding video..."), 600); // held behind the urgent one
    assert.deepEqual(gate.flush(1_000), { send: null, flushAt: 1_500 });
    assert.deepEqual(gate.flush(1_500), { send: node("Encoding video..."), flushAt: null });
  });
});
