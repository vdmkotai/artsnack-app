import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applyComfyTimelineMessage,
  comfyHistoryTimes,
  comfySystemInfo,
  formatDurationMs,
  mergeComfyRunStats,
  outputKeyTimestamp,
  summarizeComfyRun,
  type ComfyRunTimeline,
} from "./comfy-run-stats";
import {
  buildH3VideoWorkflow,
  DEFAULT_H3_SETTINGS,
  h3NodeStage,
  normalizeH3Settings,
} from "./h3-video";

describe("ComfyUI run timeline", () => {
  test("records each node once, at the first moment it is reported", () => {
    const timeline: ComfyRunTimeline = { nodes: [] };
    const executing = (node: string) => ({ type: "executing", data: { prompt_id: "p", node } });
    assert.equal(applyComfyTimelineMessage(timeline, executing("unet"), "p", 1_000), true);
    assert.equal(applyComfyTimelineMessage(timeline, executing("sample"), "p", 5_000), true);
    assert.equal(applyComfyTimelineMessage(timeline, executing("sample"), "p", 6_000), false);
    assert.deepEqual(timeline.nodes, [
      { id: "unet", startedAt: 1_000 },
      { id: "sample", startedAt: 5_000 },
    ]);
  });

  test("keeps a sampler's step count and the end of the prompt", () => {
    const timeline: ComfyRunTimeline = { nodes: [{ id: "sample", startedAt: 0 }] };
    for (const value of [1, 2, 8]) {
      applyComfyTimelineMessage(
        timeline,
        { type: "progress", data: { prompt_id: "p", node: "sample", value, max: 8 } },
        "p",
        value,
      );
    }
    applyComfyTimelineMessage(
      timeline,
      { type: "execution_success", data: { prompt_id: "p", timestamp: 8_800 } },
      "p",
      9_000,
    );
    assert.deepEqual(timeline, {
      nodes: [{ id: "sample", startedAt: 0, total: 8 }],
      endedAt: 9_000,
      clockOffset: 200,
    });
  });

  test("measures the clock offset off the pod's own timestamps, keeping the smallest", () => {
    const timeline: ComfyRunTimeline = { nodes: [] };
    const start = { type: "execution_start", data: { prompt_id: "p", timestamp: 10_000 } };
    const cached = {
      type: "execution_cached",
      data: { prompt_id: "p", nodes: [], timestamp: 10_050 },
    };
    assert.equal(applyComfyTimelineMessage(timeline, start, "p", 12_300), true);
    assert.equal(applyComfyTimelineMessage(timeline, cached, "p", 12_100), true);
    assert.equal(applyComfyTimelineMessage(timeline, cached, "p", 12_500), false);
    assert.equal(timeline.clockOffset, 2_050);
    assert.equal(
      mergeComfyRunStats({ clockOffset: 1_900 }, { clockOffset: timeline.clockOffset }).clockOffset,
      1_900,
    );
  });

  test("ignores other prompts and malformed messages", () => {
    const timeline: ComfyRunTimeline = { nodes: [] };
    for (const message of [
      { type: "executing", data: { prompt_id: "other", node: "unet" } },
      { type: "executing", data: { prompt_id: "p" } },
      { type: "progress", data: { prompt_id: "p", node: "sample", max: "x" } },
      "not json",
      null,
    ]) {
      assert.equal(applyComfyTimelineMessage(timeline, message, "p", 1), false);
    }
    assert.deepEqual(timeline, { nodes: [] });
  });
});

describe("ComfyUI history and system stats", () => {
  test("reads execution start, end and cached nodes", () => {
    assert.deepEqual(
      comfyHistoryTimes([
        ["execution_start", { prompt_id: "p", timestamp: 1_000 }],
        ["execution_cached", { prompt_id: "p", nodes: ["unet", "clip"], timestamp: 1_001 }],
        ["execution_success", { prompt_id: "p", timestamp: 61_000 }],
      ]),
      { executionStartedAt: 1_000, cachedNodes: ["unet", "clip"], executionEndedAt: 61_000 },
    );
    assert.deepEqual(comfyHistoryTimes(undefined), {});
    assert.deepEqual(comfyHistoryTimes([["execution_start", { prompt_id: "p" }]]), {});
  });

  test("names the GPU without the device prefix and allocator suffix", () => {
    assert.deepEqual(
      comfySystemInfo({
        system: { comfyui_version: "0.39.2", pytorch_version: "2.9.0+cu130" },
        devices: [
          {
            name: "cuda:0 NVIDIA RTX PRO 6000 Blackwell Server Edition : cudaMallocAsync",
            vram_total: 102_000_000_000,
          },
        ],
      }),
      {
        gpuName: "NVIDIA RTX PRO 6000 Blackwell Server Edition",
        vramBytes: 102_000_000_000,
        comfyuiVersion: "0.39.2",
        pytorchVersion: "2.9.0+cu130",
      },
    );
    assert.deepEqual(comfySystemInfo({ devices: "nope" }), {});
  });
});

describe("merging what each processor run learned", () => {
  test("keeps the earliest start of a node seen twice and the newest scalars", () => {
    const merged = mergeComfyRunStats(
      { submittedAt: 10, nodes: [{ id: "sample", startedAt: 100, total: 4 }] },
      {
        executionEndedAt: 900,
        nodes: [
          { id: "decode", startedAt: 700 },
          { id: "sample", startedAt: 300, total: 8 },
        ],
      },
    );
    assert.deepEqual(merged, {
      submittedAt: 10,
      executionEndedAt: 900,
      nodes: [
        { id: "sample", startedAt: 100, total: 8 },
        { id: "decode", startedAt: 700 },
      ],
    });
  });

  test("an empty patch changes nothing", () => {
    const existing = { submittedAt: 1, gpuName: "H100" };
    assert.deepEqual(mergeComfyRunStats(existing, {}), existing);
    assert.deepEqual(mergeComfyRunStats(undefined, { gpuName: undefined }), {});
  });
});

describe("summarizing a finished run", () => {
  test("splits the wait into phases and the render into stages", () => {
    const summary = summarizeComfyRun(
      {
        createdAt: 0,
        completedAt: 400_000,
        stats: {
          submittedAt: 5_000,
          executionStartedAt: 65_000,
          executionEndedAt: 385_000,
          nodes: [
            { id: "unet", startedAt: 65_000 },
            { id: "lora_0", startedAt: 70_000 },
            { id: "noise", startedAt: 75_000 },
            { id: "conditioning", startedAt: 75_020 },
            { id: "sample", startedAt: 100_000, total: 8 },
            { id: "decode", startedAt: 340_000 },
            { id: "save", startedAt: 375_000 },
          ],
          nodesEndedAt: 385_000,
        },
      },
      h3NodeStage,
    );
    assert.equal(summary.totalMs, 400_000);
    assert.deepEqual(
      summary.phases.map((phase) => [phase.key, phase.ms]),
      [
        ["prepare", 5_000],
        ["queue", 60_000],
        ["render", 320_000],
        ["save", 15_000],
      ],
    );
    assert.deepEqual(
      summary.stages.map((stage) => [stage.key, stage.ms, stage.steps]),
      [
        // The 20 ms of sampler setup is below the threshold and left out.
        ["load", 10_000, undefined],
        ["encode", 24_980, undefined],
        ["sample", 240_000, 8],
        ["decode", 35_000, undefined],
        ["mux", 10_000, undefined],
      ],
    );
  });

  test("ends the last node at the pod's end when the socket missed it", () => {
    const summary = summarizeComfyRun(
      {
        createdAt: 0,
        stats: {
          executionStartedAt: 1_000,
          executionEndedAt: 11_000,
          // The Convex clock reads 500 ms ahead of the pod's.
          clockOffset: 500,
          nodes: [{ id: "sample", startedAt: 1_500 }],
        },
      },
      h3NodeStage,
    );
    assert.equal(summary.totalMs, undefined);
    assert.deepEqual(summary.stages, [{ key: "sample", label: "Sampling", ms: 10_000 }]);
  });

  test("a late first node is not mistaken for clock skew", () => {
    // Same clocks; the socket joined 45 s into a 300 s render and missed the end.
    const summary = summarizeComfyRun(
      {
        createdAt: 0,
        stats: {
          executionStartedAt: 0,
          executionEndedAt: 300_000,
          nodes: [
            { id: "sample", startedAt: 45_000 },
            { id: "decode", startedAt: 290_000 },
          ],
        },
      },
      h3NodeStage,
    );
    assert.deepEqual(
      summary.stages.map((stage) => [stage.key, stage.ms]),
      [
        ["sample", 245_000],
        ["decode", 10_000],
      ],
    );
  });

  test("moves the pod's readings onto Convex time at the phase boundaries", () => {
    // The pod's clock is 2 s behind: unadjusted, the queue would read 0 and
    // saving 2 s too long.
    const summary = summarizeComfyRun(
      {
        createdAt: 0,
        completedAt: 20_000,
        stats: {
          submittedAt: 1_000,
          executionStartedAt: 1_000,
          executionEndedAt: 11_000,
          clockOffset: 2_000,
        },
      },
      h3NodeStage,
    );
    assert.deepEqual(
      summary.phases.map((phase) => [phase.key, phase.ms]),
      [
        ["prepare", 1_000],
        ["queue", 2_000],
        ["render", 10_000],
        ["save", 7_000],
      ],
    );
  });

  test("clamps a gap the two clocks made negative", () => {
    const summary = summarizeComfyRun(
      { createdAt: 10_000, stats: { submittedAt: 10_500, executionStartedAt: 10_400 } },
      h3NodeStage,
    );
    assert.deepEqual(
      summary.phases.map((phase) => [phase.key, phase.ms]),
      [
        ["prepare", 500],
        ["queue", 0],
      ],
    );
  });
});

test("every node of a full H3 graph has a named stage", () => {
  const graph = buildH3VideoWorkflow(
    normalizeH3Settings({
      ...DEFAULT_H3_SETTINGS,
      prompt: "<Picture 1> waves",
      mode: "reference",
      loras: [{ name: "style.safetensors", strength: 0.7 }],
      shiftEnabled: true,
      sparseAttention: "sol-attn",
      easyCache: true,
      interpolate: true,
      upscale: true,
    }),
    { references: ["ref.png"] },
    { seed: 1, filenamePrefix: "x" },
  );
  for (const id of Object.keys(graph)) {
    assert.notEqual(h3NodeStage(id).key, "other", `node ${id} has no stage`);
  }
});

test("reads the upload time off an output key", () => {
  assert.equal(outputKeyTimestamp("videos/h3/1791818006867_4g3h2d.mp4"), 1_791_818_006_867);
  assert.equal(outputKeyTimestamp("grok-references/abc.jpg"), undefined);
  assert.equal(outputKeyTimestamp(undefined), undefined);
});

test("formats durations at a useful precision", () => {
  assert.equal(formatDurationMs(420), "0.4 s");
  assert.equal(formatDurationMs(9_940), "9.9 s");
  assert.equal(formatDurationMs(42_400), "42 s");
  assert.equal(formatDurationMs(245_000), "4 min 05 s");
  assert.equal(formatDurationMs(3_725_000), "1 h 02 min");
});
