import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Doc } from "./_generated/dataModel";
import { hostedSearchDocument, localSearchDocument } from "./searchCatalog";

const localForm = {
  prompt: "girl, beach",
  negativePrompt: "blurry",
  checkpoint: "sdxl_base.safetensors",
  width: 1024,
  height: 1536,
  seed: 42,
  steps: 30,
  cfg: 7,
  sampler: "euler",
  scheduler: "normal",
  denoise: 1,
  batchSize: 2,
  loras: [
    {
      enabled: true,
      loraName: "lighting.safetensors",
      strengthModel: 0.8,
      strengthClip: 0.7,
    },
    {
      enabled: false,
      loraName: "disabled.safetensors",
      strengthModel: 1,
      strengthClip: 1,
    },
  ],
};

describe("search catalog projections", () => {
  test("maps a local generation once and keeps only enabled LoRAs", () => {
    const row = {
      _id: "local-id",
      status: "completed",
      timestamp: 123,
      b2Keys: ["one.png", "two.png"],
      formState: localForm,
    } as unknown as Doc<"generations">;
    const document = localSearchDocument(row);
    assert.ok(document);
    assert.deepEqual(document.assets, [
      { id: "0", key: "one.png" },
      { id: "1", key: "two.png" },
    ]);
    assert.deepEqual(document.checkpoints, ["sdxl_base.safetensors"]);
    assert.deepEqual(document.loras, ["lighting.safetensors"]);
    assert.equal(document.localSettings, localForm);
  });

  test("drops failed or assetless local rows", () => {
    const row = {
      _id: "local-id",
      status: "failed",
      timestamp: 123,
      b2Keys: ["one.png"],
      formState: localForm,
    } as unknown as Doc<"generations">;
    assert.equal(localSearchDocument(row), null);
    assert.equal(localSearchDocument({ ...row, status: "completed", b2Keys: [] }), null);
  });

  test("keeps legacy hosted b2Key rows and extracts vendor scalar parameters", () => {
    const row = {
      _id: "hosted-id",
      status: "completed",
      provider: "atlas",
      apiModel: "historical-atlas-model",
      mediaType: "video",
      createdAt: 456,
      prompt: "woman on beach",
      b2Key: "legacy.mp4",
      hasReferenceImage: true,
      atlasParams: {
        aspect_ratio: "16:9",
        size: "1080p",
        duration: "10",
        seed: 99,
        num_inference_steps: "28",
        guidance_scale: 6.5,
      },
      generateAudio: false,
      videoMode: "normal",
    } as unknown as Doc<"grokGenerations">;
    const document = hostedSearchDocument(row);
    assert.ok(document);
    assert.equal(document.modelLabel, "historical-atlas-model");
    assert.equal(document.aspectRatio, "16:9");
    assert.equal(document.resolution, "1080p");
    assert.equal(document.duration, 10);
    assert.equal(document.steps, 28);
    assert.equal(document.cfg, 6.5);
    assert.deepEqual(document.assets, [{ id: "0", key: "legacy.mp4" }]);
    assert.deepEqual(document.parameters, {
      aspect_ratio: "16:9",
      size: "1080p",
      duration: "10",
      seed: 99,
      num_inference_steps: "28",
      guidance_scale: 6.5,
      videoMode: "normal",
      generateAudio: false,
    });
  });

  test("drops failed and empty hosted rows", () => {
    const row = {
      _id: "hosted-id",
      status: "failed",
      mediaType: "image",
      createdAt: 1,
      prompt: "beach",
      hasReferenceImage: false,
      b2Keys: ["one.png"],
    } as unknown as Doc<"grokGenerations">;
    assert.equal(hostedSearchDocument(row), null);
    assert.equal(hostedSearchDocument({ ...row, status: "completed", b2Keys: [] }), null);
  });

  test("maps a self-hosted H3 clip with its checkpoint, LoRAs and seed", () => {
    const row = {
      _id: "h3-id",
      status: "completed",
      createdAt: 3,
      prompt: "a cat",
      mediaType: "video",
      provider: "comfy",
      apiModel: "h3_base.safetensors",
      b2Keys: ["videos/h3/clip.mp4"],
      hasReferenceImage: false,
      duration: 5,
      resolution: "1344×768",
      h3Settings: {
        checkpoint: "h3_base.safetensors",
        loras: [{ name: "detail_boost.safetensors", strength: 0.5 }],
        width: 1344,
        height: 768,
        sampler: "euler",
        scheduler: "simple",
        steps: 8,
        seed: 42,
      },
    } as unknown as Doc<"grokGenerations">;
    const document = hostedSearchDocument(row);
    assert.ok(document);
    assert.equal(document.provider, "comfy");
    assert.equal(document.modelLabel, "h3_base");
    assert.deepEqual(document.checkpoints, ["h3_base.safetensors"]);
    assert.deepEqual(document.loras, ["detail_boost.safetensors"]);
    assert.equal(document.seed, 42);
  });
});
