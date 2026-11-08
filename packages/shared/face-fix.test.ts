import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFaceFixWorkflow,
  FACE_FIX_DEFAULTS,
  FACE_FIX_DETAIL,
  FACE_FIX_FALLBACK_CHECKPOINT,
  FACE_FIX_MODELS,
} from "./enhance-workflows";

type Node = { class_type: string; inputs: Record<string, unknown> };

function nodes(workflow: Record<string, unknown>): Record<string, Node> {
  return workflow as Record<string, Node>;
}

test("re-renders the face with the checkpoint, prompt and LoRAs that drew the source", () => {
  const graph = nodes(
    buildFaceFixWorkflow({
      inputImageFilename: "in.png",
      seed: 7,
      checkpoint: "novaAnimeXL_ilV190.safetensors",
      prompt: "a knight on a bridge",
      negativePrompt: "worst quality",
      loras: [
        { enabled: true, loraName: "style.safetensors", strengthModel: 0.8, strengthClip: 0.8 },
      ],
    }),
  );

  // The single most important property of the mode: the face is drawn by the
  // model that drew the picture, not by a hardcoded one.
  assert.equal(graph["4"].inputs.ckpt_name, "novaAnimeXL_ilV190.safetensors");
  assert.equal(graph["6"].inputs.text, "a knight on a bridge");
  assert.equal(graph["7"].inputs.text, "worst quality");

  // And the LoRA stack reaches the detailer, which has no KSampler to re-point.
  assert.deepEqual(graph["lora_0"].inputs.model, ["4", 0]);
  assert.deepEqual(graph["31"].inputs.model, ["lora_0", 0]);
  assert.deepEqual(graph["6"].inputs.clip, ["lora_0", 1]);
});

test("falls back only when nothing about the source is known", () => {
  const graph = nodes(buildFaceFixWorkflow({ inputImageFilename: "in.png", seed: -1 }));

  assert.equal(graph["4"].inputs.ckpt_name, FACE_FIX_FALLBACK_CHECKPOINT);
  assert.equal(graph["6"].inputs.text, "");
});

test("a fixed seed is passed through and -1 is rolled", () => {
  const fixed = nodes(buildFaceFixWorkflow({ inputImageFilename: "in.png", seed: 42 }));
  assert.equal(fixed["31"].inputs.seed, 42);

  const rolled = nodes(buildFaceFixWorkflow({ inputImageFilename: "in.png", seed: -1 }));
  const seed = rolled["31"].inputs.seed as number;
  assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 2147483647);
});

test("the detail preset sets the pixel budget the face gets", () => {
  for (const detail of ["standard", "high", "max"] as const) {
    const graph = nodes(buildFaceFixWorkflow({ inputImageFilename: "in.png", seed: 1, detail }));
    assert.equal(graph["31"].inputs.guide_size, FACE_FIX_DETAIL[detail].guideSize);
    assert.equal(graph["31"].inputs.max_size, FACE_FIX_DETAIL[detail].maxSize);
    assert.equal(graph["31"].inputs.bbox_crop_factor, FACE_FIX_DETAIL[detail].cropFactor);
  }

  // The default is the one the UI shows as default.
  const byDefault = nodes(buildFaceFixWorkflow({ inputImageFilename: "in.png", seed: 1 }));
  assert.equal(
    byDefault["31"].inputs.guide_size,
    FACE_FIX_DETAIL[FACE_FIX_DEFAULTS.detail].guideSize,
  );
});

test("the detector choice picks the model, not just a label", () => {
  const accurate = nodes(
    buildFaceFixWorkflow({ inputImageFilename: "in.png", seed: 1, detector: "accurate" }),
  );
  assert.equal(accurate["30"].inputs.model_name, FACE_FIX_MODELS.detectors.accurate);

  const fast = nodes(
    buildFaceFixWorkflow({ inputImageFilename: "in.png", seed: 1, detector: "fast" }),
  );
  assert.equal(fast["30"].inputs.model_name, FACE_FIX_MODELS.detectors.fast);
});

test("the eye pass chains after the face pass and is what gets saved", () => {
  const off = nodes(buildFaceFixWorkflow({ inputImageFilename: "in.png", seed: 1 }));
  assert.equal(off["34"], undefined);
  assert.deepEqual(off["9"].inputs.images, ["31", 0]);

  const on = nodes(
    buildFaceFixWorkflow({ inputImageFilename: "in.png", seed: 1, refineEyes: true }),
  );
  assert.equal(on["33"].inputs.model_name, FACE_FIX_MODELS.eyeSegm);
  assert.deepEqual(on["34"].inputs.image, ["31", 0]);
  assert.deepEqual(on["9"].inputs.images, ["34", 0]);
  // Gentler than the face pass, or the eyes come back looking elsewhere.
  assert.ok((on["34"].inputs.denoise as number) < (on["31"].inputs.denoise as number));
  // A different seed: the same noise over an area that just changed underneath
  // it re-rolls the same correction.
  assert.notEqual(on["34"].inputs.seed, on["31"].inputs.seed);
});

test("a LoRA stack reaches both detailer passes", () => {
  const graph = nodes(
    buildFaceFixWorkflow({
      inputImageFilename: "in.png",
      seed: 1,
      refineEyes: true,
      loras: [{ enabled: true, loraName: "one.safetensors", strengthModel: 1, strengthClip: 1 }],
    }),
  );

  assert.deepEqual(graph["31"].inputs.model, ["lora_0", 0]);
  assert.deepEqual(graph["34"].inputs.model, ["lora_0", 0]);
});

test("out-of-range numbers are clamped rather than sent to the pod", () => {
  const graph = nodes(
    buildFaceFixWorkflow({
      inputImageFilename: "in.png",
      seed: 1,
      denoise: 5,
      steps: 9999,
      cfg: 0,
      refineEyes: true,
      eyeDenoise: 0.9,
    }),
  );

  assert.equal(graph["31"].inputs.denoise, 0.95);
  assert.equal(graph["31"].inputs.steps, 150);
  assert.equal(graph["31"].inputs.cfg, 1);
  assert.equal(graph["34"].inputs.denoise, 0.6);
});

test("nothing claims SAM is doing work, since no SAM model is wired", () => {
  const graph = nodes(buildFaceFixWorkflow({ inputImageFilename: "in.png", seed: 1 }));
  assert.equal("sam_model_opt" in graph["31"].inputs, false);
  assert.equal(graph["31"].inputs.sam_detection_hint, "none");
});
