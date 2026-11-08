import assert from "node:assert/strict";
import test from "node:test";

import { guessVideoFamily, podManifestLine, sanitizePodFilename } from "./pod-model-downloads";

test("sanitizePodFilename accepts the shapes already in the manifest", () => {
  // Manifest-style names — spaces, brackets, dots.
  for (const name of [
    "Dramatic Lighting Slider.safetensors",
    "realistic filter [IL].safetensors",
    "sd_xl_base_1.0.safetensors",
    "face_yolov9c.pt",
    "some_model.ckpt",
  ]) {
    assert.equal(sanitizePodFilename(name), name);
  }
  assert.equal(sanitizePodFilename("  padded.safetensors  "), "padded.safetensors");
});

test("sanitizePodFilename rejects traversal, wrong extensions and hidden files", () => {
  for (const name of [
    "../etc/cron.d/x.safetensors",
    "sub/dir.safetensors",
    "a..b.safetensors",
    ".hidden.safetensors",
    "-flag.safetensors",
    "model.exe",
    "model.safetensors.sh",
    "модель.safetensors", // non-ASCII: the manifest format has never carried it
    "",
  ]) {
    assert.equal(sanitizePodFilename(name), null, name);
  }
});

test("manifest line is exactly the provision.sh format", () => {
  assert.equal(
    podManifestLine(
      "loras",
      "https://huggingface.co/example/lora/resolve/main/style.safetensors",
      "style.safetensors",
    ),
    "loras|https://huggingface.co/example/lora/resolve/main/style.safetensors|style.safetensors",
  );
});

test("guessVideoFamily reads the family off a filename, or admits it cannot", () => {
  assert.equal(guessVideoFamily("ltx-2.3-22b-distilled.safetensors"), "ltx");
  assert.equal(guessVideoFamily("minimax_h3_fp8.safetensors"), "h3");
  assert.equal(guessVideoFamily("motion_h3_lora.safetensors"), "h3");
  assert.equal(guessVideoFamily("sd_xl_base_1.0.safetensors"), null);
});
