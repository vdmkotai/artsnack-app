import assert from "node:assert/strict";
import test from "node:test";

import {
  buildH3VideoWorkflow,
  DEFAULT_H3_SETTINGS,
  H3_BASE_FILES,
  h3Dimensions,
  h3FrameCount,
  h3ReferencePrompt,
  normalizeH3Settings,
  type H3VideoSettings,
  h3ReferenceTagProblem,
  H3_EXTRA_FILES,
} from "./h3-video";

function settings(overrides: Partial<H3VideoSettings> = {}): H3VideoSettings {
  return normalizeH3Settings({ ...DEFAULT_H3_SETTINGS, prompt: "a cat", ...overrides });
}

function build(overrides: Partial<H3VideoSettings> = {}, inputs = {}) {
  return buildH3VideoWorkflow(settings(overrides), inputs, { seed: 42, filenamePrefix: "h3/x" });
}

test("frame count follows the template's 17k+5 grid", () => {
  assert.equal(h3FrameCount(5), 124);
  assert.equal(h3FrameCount(10), 243);
  assert.equal(h3FrameCount(15), 362);
  assert.equal(h3FrameCount(0), 5);
  for (const seconds of [1, 2.5, 7, 13, 20]) {
    assert.equal((h3FrameCount(seconds) - 5) % 17, 0);
  }
});

test("presets land on the native 768x1344 and snap to 32", () => {
  assert.deepEqual(h3Dimensions(768, "16:9"), { width: 1344, height: 768 });
  assert.deepEqual(h3Dimensions(768, "9:16"), { width: 768, height: 1344 });
  assert.deepEqual(h3Dimensions(480, "16:9"), { width: 864, height: 480 });
  assert.deepEqual(h3Dimensions(768, "1:1"), { width: 768, height: 768 });
});

test("normalize clamps a hostile request instead of passing it to the pod", () => {
  const s = normalizeH3Settings({
    width: 16384,
    height: 10,
    durationSeconds: 600,
    steps: 999,
    sampler: "rm -rf",
    checkpoint: "../../etc/passwd",
    loras: Array.from({ length: 30 }, (_, i) => ({ name: `l${i}.safetensors`, strength: 99 })),
  });
  assert.equal(s.width, 1920);
  assert.equal(s.height, 256);
  assert.equal(s.durationSeconds, 20);
  assert.equal(s.steps, 60);
  assert.equal(s.sampler, "res_multistep");
  assert.equal(s.checkpoint, H3_BASE_FILES.fl2va);
  assert.equal(s.loras.length, 10);
  assert.equal(s.loras[0].strength, 5);
});

test("reference mode defaults to the Ref2VA model", () => {
  const s = normalizeH3Settings({ mode: "reference", checkpoint: "" });
  assert.equal(s.checkpoint, H3_BASE_FILES.ref2va);
});

test("text mode: guidance-free graph with audio muxed in", () => {
  const graph = build();
  assert.equal(graph.conditioning.class_type, "MiniMaxH3ImageToVideo");
  assert.equal(graph.conditioning.inputs.length, 124);
  assert.equal(graph.guider.class_type, "BasicGuider");
  assert.deepEqual(graph.video.inputs.audio, ["decode_audio", 0]);
  assert.equal(graph.noise.inputs.noise_seed, 42);
  assert.equal(graph.first_frame, undefined);
});

test("turbo prepends the mode's official LoRA ahead of the user's", () => {
  const graph = build({ loras: [{ name: "detail_boost.safetensors", strength: 0.5 }] });
  assert.equal(graph.lora_0.inputs.lora_name, H3_BASE_FILES.turboFl2v);
  assert.equal(graph.lora_1.inputs.lora_name, "detail_boost.safetensors");
  assert.deepEqual(graph.lora_1.inputs.model, ["lora_0", 0]);
  const reference = build({ mode: "reference" });
  assert.equal(reference.lora_0.inputs.lora_name, H3_BASE_FILES.turboRef2v);
});

test("model patches chain in order and feed both scheduler and guider", () => {
  const graph = build({
    turbo: false,
    shiftEnabled: true,
    fastAttention: true,
    sparseAttention: "sol-attn",
    easyCache: true,
  });
  assert.deepEqual(graph.shift.inputs.model, ["unet", 0]);
  assert.deepEqual(graph.attention.inputs.model, ["shift", 0]);
  assert.deepEqual(graph.sparse.inputs.model, ["attention", 0]);
  assert.equal(graph.sparse.inputs["selection.tau"], 1.3);
  assert.deepEqual(graph.easy_cache.inputs.model, ["sparse", 0]);
  assert.deepEqual(graph.scheduler.inputs.model, ["easy_cache", 0]);
  assert.deepEqual(graph.guider.inputs.model, ["easy_cache", 0]);
});

test("audio off leaves no audio decoder in the graph", () => {
  const graph = build({ audio: false });
  assert.equal(graph.decode_audio, undefined);
  assert.equal(graph.video.inputs.audio, undefined);
});

test("frames mode wires first and last frame loaders", () => {
  const graph = build({ mode: "frames" }, { firstFrame: "a.png", lastFrame: "b.png" });
  assert.deepEqual(graph.conditioning.inputs.first_frame, ["first_frame", 0]);
  assert.deepEqual(graph.conditioning.inputs.last_frame, ["last_frame", 0]);
  assert.equal(graph.first_frame.inputs.image, "a.png");
});

test("text mode ignores frames even if some were uploaded", () => {
  const graph = build({ mode: "text" }, { firstFrame: "a.png" });
  assert.equal(graph.first_frame, undefined);
});

test("reference mode uses autogrow slots, capped at nine", () => {
  const refs = Array.from({ length: 12 }, (_, i) => `r${i}.png`);
  const graph = build({ mode: "reference" }, { references: refs });
  assert.equal(graph.conditioning.class_type, "MiniMaxH3ReferenceToVideo");
  assert.deepEqual(graph.conditioning.inputs["ref_images.ref_image_8"], ["reference_8", 0]);
  assert.equal(graph.conditioning.inputs["ref_images.ref_image_9"], undefined);
  assert.equal(graph.conditioning.inputs.ref_image_size, "match");
});

test("reference tags from the composer become H3's <Picture N>", () => {
  assert.equal(
    h3ReferencePrompt("@image1 hugs @image 2, like <Picture 3>; mail@image9x stays"),
    "<Picture 1> hugs <Picture 2>, like <Picture 3>; mail@image9x stays",
  );
  const graph = build(
    { mode: "reference", prompt: "@image2 waves at @image1" },
    {
      references: ["a.png", "b.png"],
    },
  );
  assert.equal(graph.conditioning.inputs.prompt, "<Picture 2> waves at <Picture 1>");
  // Other modes have no references to point at; the text is left as typed.
  assert.equal(build({ prompt: "@image1 runs" }).conditioning.inputs.prompt, "@image1 runs");
});

test("reference tags past the attached images are refused, not renumbered", () => {
  assert.equal(h3ReferenceTagProblem("@image1 hugs @image2", 2), null);
  assert.match(h3ReferenceTagProblem("@image1 hugs @image3", 2) ?? "", /@image3/);
  assert.match(h3ReferenceTagProblem("@image0 waves", 1) ?? "", /@image0/);
  assert.equal(h3ReferenceTagProblem("no tags at all", 0), null);
});

test("community add-ons: upscale renders at half size, then refines at full size", () => {
  const graph = buildH3VideoWorkflow(
    normalizeH3Settings({ prompt: "x", width: 1344, height: 768, upscale: true }),
    {},
    { seed: 1, filenamePrefix: "t" },
  );
  assert.equal(graph.conditioning.inputs.width, 672);
  assert.equal(graph.conditioning.inputs.height, 384);
  assert.equal(graph.conditioning_full.inputs.width, 1344);
  assert.equal(graph.upscale_latent.inputs.model_name, H3_EXTRA_FILES.latentUpscaler);
  assert.deepEqual(graph.decode.inputs.samples, ["sample_refine", 0]);
});

test("community add-ons: RIFE doubles the fps, the encoder stays the official one", () => {
  const graph = buildH3VideoWorkflow(
    normalizeH3Settings({ prompt: "x", interpolate: true }),
    {},
    { seed: 1, filenamePrefix: "t" },
  );
  assert.equal(graph.video.inputs.fps, 48);
  assert.deepEqual(graph.video.inputs.images, ["interpolate", 0]);
  assert.equal(graph.clip.inputs.clip_name, H3_BASE_FILES.textEncoder);
  const plain = buildH3VideoWorkflow(
    normalizeH3Settings({ prompt: "x" }),
    {},
    { seed: 1, filenamePrefix: "t" },
  );
  assert.equal(plain.video.inputs.fps, 24);
  assert.equal(plain.upscale_latent, undefined);
});
