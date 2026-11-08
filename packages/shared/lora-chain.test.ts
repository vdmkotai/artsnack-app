import assert from "node:assert/strict";
import test from "node:test";

import { applyLoraChain } from "./workflows/lora-chain";

/** The node numbering /api/generate and /api/enhance both build against. */
function baseWorkflow(): Record<string, object> {
  return {
    "3": { class_type: "KSampler", inputs: { model: ["4", 0] } },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "a", clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "b", clip: ["4", 1] } },
  };
}

test("leaves the graph untouched when nothing is enabled", () => {
  const workflow = baseWorkflow();
  applyLoraChain(workflow, [
    { enabled: false, loraName: "off.safetensors", strengthModel: 1, strengthClip: 1 },
    { enabled: true, loraName: "None", strengthModel: 1, strengthClip: 1 },
    { enabled: true, loraName: "", strengthModel: 1, strengthClip: 1 },
  ]);

  assert.deepEqual(workflow, baseWorkflow());
});

test("chains two LoRAs and re-points the sampler and both text encoders", () => {
  const workflow = baseWorkflow();
  applyLoraChain(workflow, [
    { enabled: true, loraName: "one.safetensors", strengthModel: 0.8, strengthClip: 0.7 },
    { enabled: true, loraName: "two.safetensors", strengthModel: 0.5, strengthClip: 0.4 },
  ]);

  // First loader hangs off the checkpoint, second off the first.
  assert.deepEqual((workflow["lora_0"] as { inputs: Record<string, unknown> }).inputs.model, [
    "4",
    0,
  ]);
  assert.deepEqual((workflow["lora_1"] as { inputs: Record<string, unknown> }).inputs.model, [
    "lora_0",
    0,
  ]);
  assert.deepEqual((workflow["lora_1"] as { inputs: Record<string, unknown> }).inputs.clip, [
    "lora_0",
    1,
  ]);

  // Everything downstream reads the END of the chain, not the checkpoint.
  assert.deepEqual((workflow["3"] as { inputs: Record<string, unknown> }).inputs.model, [
    "lora_1",
    0,
  ]);
  assert.deepEqual((workflow["6"] as { inputs: Record<string, unknown> }).inputs.clip, [
    "lora_1",
    1,
  ]);
  assert.deepEqual((workflow["7"] as { inputs: Record<string, unknown> }).inputs.clip, [
    "lora_1",
    1,
  ]);

  // Untouched inputs survive the re-point.
  assert.equal((workflow["6"] as { inputs: Record<string, unknown> }).inputs.text, "a");
});

test("skips disabled entries without leaving a gap in the node numbering", () => {
  const workflow = baseWorkflow();
  applyLoraChain(workflow, [
    { enabled: false, loraName: "skipped.safetensors", strengthModel: 1, strengthClip: 1 },
    { enabled: true, loraName: "kept.safetensors", strengthModel: 1, strengthClip: 1 },
  ]);

  assert.equal(workflow["lora_1"], undefined);
  assert.deepEqual((workflow["3"] as { inputs: Record<string, unknown> }).inputs.model, [
    "lora_0",
    0,
  ]);
});
