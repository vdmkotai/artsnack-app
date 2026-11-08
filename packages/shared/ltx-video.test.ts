import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LTX_BASE_FILES,
  buildLtxVideoWorkflow,
  ltxDimensions,
  ltxFrameCount,
  normalizeLtxSettings,
} from "./ltx-video";

test("LTX frame counts sit on the 8k+1 grid", () => {
  assert.equal(ltxFrameCount(5, 24), 121);
  assert.equal(ltxFrameCount(10, 24), 241);
  assert.equal(ltxFrameCount(20, 24), 481);
  assert.equal((ltxFrameCount(7, 30) - 1) % 8, 0);
});

test("sizes snap to 64 so the half-size pass lands on 32", () => {
  assert.deepEqual(ltxDimensions(768, "9:16"), { width: 768, height: 1344 });
  const s = normalizeLtxSettings({ width: 1000, height: 700 });
  assert.equal(s.width % 64, 0);
  assert.equal(s.height % 64, 0);
});

test("two passes: half-size render, 2× latent upscale, 3-step refine", () => {
  const g = buildLtxVideoWorkflow(
    normalizeLtxSettings({ prompt: "x", width: 768, height: 1344 }),
    {},
    { seed: 1, filenamePrefix: "t" },
  );
  assert.equal(g.empty_video.inputs.width, 384);
  assert.equal(g.empty_video.inputs.height, 672);
  assert.equal(g.upscaler.inputs.model_name, LTX_BASE_FILES.spatialUpscaler);
  assert.deepEqual(g.split_out.inputs.av_latent, ["sample_refine", 0]);
  assert.equal(g.clip.inputs.type, "ltxv");
});

test("image → video pins first and last frames as guides", () => {
  const g = buildLtxVideoWorkflow(
    normalizeLtxSettings({ prompt: "x", mode: "frames" }),
    { firstFrame: "a.png", lastFrame: "b.png" },
    { seed: 1, filenamePrefix: "t" },
  );
  assert.equal(g.guide_0.inputs.frame_idx, 0);
  assert.equal(g.guide_1.inputs.frame_idx, -1);
  assert.equal(g.guide_0.inputs.strength, 0.7);
  assert.deepEqual(g.reinforce.inputs.image, ["frame_prep_0", 0]);
});

test("one pass crops the guides before decoding", () => {
  const g = buildLtxVideoWorkflow(
    normalizeLtxSettings({ prompt: "x", mode: "frames", twoPass: false }),
    { firstFrame: "a.png" },
    { seed: 1, filenamePrefix: "t" },
  );
  assert.equal(g.upscaler, undefined);
  assert.deepEqual(g.decode.inputs.samples, ["crop_out", 2]);
});

test("reference sheet: Ingredients LoRA, sheet repeated to the clip, one full-size pass", () => {
  const settings = normalizeLtxSettings({
    prompt: "Reference sheet: a knight.\n\nGenerated video: the knight walks.",
    mode: "sheet",
    width: 768,
    height: 448,
    sheetStrength: 1.2,
  });
  const g = buildLtxVideoWorkflow(
    settings,
    { references: ["sheet.png"] },
    {
      seed: 1,
      filenamePrefix: "t",
    },
  );
  assert.equal(g.ingredients.inputs.lora_name, LTX_BASE_FILES.ingredients);
  assert.equal(g.ingredients.inputs.strength_model, 1.2);
  assert.deepEqual(g.guider.inputs.model, ["ingredients", 0]);
  assert.equal(g.sheet_fit.inputs.target_width, 768);
  assert.equal(g.sheet_fit.inputs.padding_color, "black");
  assert.equal(g.sheet_clip.inputs.amount, ltxFrameCount(5, 24));
  assert.equal(g.sheet_guide.inputs.frame_idx, 0);
  assert.equal(g.sheet_guide.inputs.strength, 1);
  assert.equal(g.empty_video.inputs.width, 768, "full size: no half-size first pass");
  assert.equal(g.upscaler, undefined);
  assert.equal(g.schedule.class_type, "ManualSigmas");
  assert.equal(g.sampler.inputs.sampler_name, "euler_ancestral_cfg_pp");
  assert.deepEqual(g.decode.inputs.samples, ["crop_out", 2]);
});

test("sheet mode without a sheet image builds a plain text graph", () => {
  const g = buildLtxVideoWorkflow(
    normalizeLtxSettings({ prompt: "x", mode: "sheet" }),
    {},
    {
      seed: 1,
      filenamePrefix: "t",
    },
  );
  assert.equal(g.ingredients, undefined);
  assert.equal(normalizeLtxSettings({ mode: "sheet", sheetStrength: 9 }).sheetStrength, 2);
});

test("8 steps sample on Lightricks' fixed distilled schedule, other counts on LTXVScheduler", () => {
  const eight = buildLtxVideoWorkflow(
    normalizeLtxSettings({ prompt: "x" }),
    {},
    {
      seed: 1,
      filenamePrefix: "t",
    },
  );
  assert.equal(eight.schedule.class_type, "ManualSigmas");
  assert.match(String(eight.schedule.inputs.sigmas), /^1\.0, 0\.99375,.*0\.421875, 0\.0$/);
  const thirty = buildLtxVideoWorkflow(
    normalizeLtxSettings({ prompt: "x", steps: 30 }),
    {},
    {
      seed: 1,
      filenamePrefix: "t",
    },
  );
  assert.equal(thirty.schedule.class_type, "LTXVScheduler");
  assert.equal(thirty.schedule.inputs.steps, 30);
});

test("two passes re-pin a last frame for the refine and crop it before decoding", () => {
  const g = buildLtxVideoWorkflow(
    normalizeLtxSettings({ prompt: "x", mode: "frames" }),
    { firstFrame: "a.png", lastFrame: "b.png" },
    { seed: 1, filenamePrefix: "t" },
  );
  assert.equal(g.refine_guide_1.inputs.frame_idx, -1);
  assert.deepEqual(g.refine_guide_1.inputs.latent, ["reinforce", 0]);
  assert.deepEqual(g.guider_refine.inputs.positive, ["refine_guide_1", 0]);
  assert.deepEqual(g.av_refine.inputs.video_latent, ["refine_guide_1", 2]);
  assert.deepEqual(g.crop_out.inputs.positive, ["refine_guide_1", 0]);
  assert.deepEqual(g.decode.inputs.samples, ["crop_out", 2]);
});

test("two passes with only a first frame decode straight from the refine", () => {
  const g = buildLtxVideoWorkflow(
    normalizeLtxSettings({ prompt: "x", mode: "frames" }),
    { firstFrame: "a.png" },
    { seed: 1, filenamePrefix: "t" },
  );
  assert.equal(g.crop_out, undefined);
  assert.deepEqual(g.decode.inputs.samples, ["split_out", 0]);
  assert.deepEqual(g.guider_refine.inputs.positive, ["crop", 0]);
});
