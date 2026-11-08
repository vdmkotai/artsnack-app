import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FACE_FIX_FALLBACK_CHECKPOINT } from "./enhance-workflows";
import { H3_EXTRA_FILES } from "./h3-video";
import { LTX_BASE_FILES } from "./ltx-video";
import {
  encodeSkipModels,
  isPodModelKey,
  manifestSectionTitle,
  launchModelGroups,
  podModelKey,
} from "./pod-model-selection";

const script = readFileSync(new URL("../../infra/provision.sh", import.meta.url), "utf8");

test("the image list is the manifest's checkpoints and LoRAs, in its own sections", () => {
  const groups = launchModelGroups(script, "image", []);
  const models = groups.flatMap((group) => group.models);

  assert.ok(models.length > 0, "no models parsed");
  assert.ok(models.every((model) => model.dir === "checkpoints" || model.dir === "loras"));
  assert.equal(new Set(models.map((model) => model.key)).size, models.length);
  assert.deepEqual(
    groups.slice(0, 2).map((group) => group.title),
    ["Checkpoints", "LoRA + embeddings"],
  );

  const sdxl = models.find((model) => model.filename === FACE_FIX_FALLBACK_CHECKPOINT);
  assert.deepEqual(sdxl, {
    key: "checkpoints|sd_xl_base_1.0.safetensors",
    dir: "checkpoints",
    filename: "sd_xl_base_1.0.safetensors",
    label: "sd_xl_base_1.0",
    group: "Checkpoints",
  });
});

test("Face Fix's detectors and upscaler are never offered on the image pod", () => {
  const filenames = launchModelGroups(script, "image", []).flatMap((group) =>
    group.models.map((model) => model.filename),
  );
  for (const required of [
    "4x-UltraSharp.pth",
    "face_yolov8m.pt",
    "face_yolov9c.pt",
    "Anzhc_Eyes_seg_hd.pt",
  ]) {
    assert.ok(!filenames.includes(required), `${required} must not be skippable`);
  }
});

test("the video list is the community add-ons and LTX — never the H3 base set", () => {
  const groups = launchModelGroups(script, "video", []);
  assert.deepEqual(
    groups.map((group) => group.title),
    ["Community add-ons", "LTX 2.3 (after ready, ~45 GB)"],
  );
  assert.ok(
    groups[1].models.some((model) => model.filename === LTX_BASE_FILES.checkpoint),
    "the official LTX checkpoint can be skipped",
  );
  assert.deepEqual(
    groups[0].models.map((model) => model.filename).sort(),
    Object.values(H3_EXTRA_FILES).sort(),
  );
});

test("the app's own rows follow the static manifest, deduplicated like provision.sh", () => {
  const groups = launchModelGroups(script, "image", [
    {
      dir: "checkpoints",
      filename: "sd_xl_base_1.0.safetensors",
      modelName: "Duplicate of a static line",
    },
    { dir: "loras", filename: "my_new_lora.safetensors", modelName: "  My new LoRA " },
    { dir: "checkpoints", filename: "unnamed.safetensors" },
  ]);
  const app = groups.at(-1)!;
  assert.equal(app.title, "Added to the app's manifest");
  assert.deepEqual(
    app.models.map((model) => [model.key, model.label]),
    [
      ["loras|my_new_lora.safetensors", "My new LoRA"],
      ["checkpoints|unnamed.safetensors", "unnamed"],
    ],
  );

  const video = launchModelGroups(script, "video", [
    { dir: "diffusion_models", filename: "h3_merge.safetensors", modelName: "H3 merge" },
  ]);
  assert.deepEqual(
    video.at(-1)!.models.map((model) => model.key),
    ["diffusion_models|h3_merge.safetensors"],
  );
});

test("section headers lose their dates, prefixes and trailing notes", () => {
  assert.equal(
    manifestSectionTitle(`# ── Checkpoints — ACTIVE (remove a "#" below to enable more) ──`),
    "Checkpoints",
  );
  assert.equal(manifestSectionTitle("# --- style loras (batch added) ---"), "Style loras");
  assert.equal(
    manifestSectionTitle(
      "# ── Pose/concept — SDXL (added 2026-07-26). The first two are LyCORIS (LoCon),",
    ),
    "Pose/concept — SDXL",
  );
  assert.equal(manifestSectionTitle("# Detail Slider (12345) already above"), null);
});

test("the skip list is one dir|filename per line, and absent when nothing is skipped", () => {
  assert.equal(encodeSkipModels([]), undefined);
  assert.equal(encodeSkipModels(["not a key", "loras|a|b"]), undefined);

  const keys = [
    podModelKey("loras", "realistic filter [XL].safetensors"),
    podModelKey("checkpoints", "sd_xl_base_1.0.safetensors"),
    podModelKey("checkpoints", "sd_xl_base_1.0.safetensors"),
  ];
  assert.ok(keys.every(isPodModelKey));
  const encoded = encodeSkipModels(keys)!;
  assert.doesNotMatch(encoded, /\s/);
  assert.equal(
    Buffer.from(encoded, "base64").toString("utf8"),
    "loras|realistic filter [XL].safetensors\ncheckpoints|sd_xl_base_1.0.safetensors",
  );
});

/** The `without_skipped` block of provision.sh, as the pod runs it. */
function runSkipFilter(skip: string | undefined, optional: string, input: string): string {
  const start = script.indexOf('SKIP_MODELS=""');
  const end = script.indexOf("# ── Dynamic manifest");
  const program = [
    'log() { echo "[provision] $*" >&2; }',
    script.slice(start, end),
    `without_skipped '${optional}' <<<"$INPUT"`,
  ].join("\n");
  const result = spawnSync("bash", ["-c", program], {
    encoding: "utf8",
    env: { ...process.env, INPUT: input, ARTSNACK_SKIP_MODELS_B64: skip ?? "" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const bashMajor = Number(
  spawnSync("bash", ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" }).stdout,
);

test(
  "provision.sh skips exactly the encoded lines, and only in the optional dirs",
  // printf '%(…)T' needs bash 4.2; macOS's /bin/bash is 3.2.
  { skip: !(bashMajor >= 4) },
  () => {
    const manifest = [
      "# ── Checkpoints ──",
      "checkpoints|https://models.example.com/1|keep.safetensors",
      "checkpoints|https://models.example.com/2|drop.safetensors",
      "loras|https://models.example.com/3|realistic filter [XL].safetensors",
      "ultralytics/bbox|https://huggingface.co/x/face_yolov9c.pt|face_yolov9c.pt",
    ].join("\n");
    const skip = encodeSkipModels([
      "checkpoints|drop.safetensors",
      "loras|realistic filter [XL].safetensors",
      "ultralytics/bbox|face_yolov9c.pt",
    ]);

    assert.equal(
      runSkipFilter(skip, "^(checkpoints|loras|diffusion_models)$", manifest),
      [
        "# ── Checkpoints ──",
        "checkpoints|https://models.example.com/1|keep.safetensors",
        "ultralytics/bbox|https://huggingface.co/x/face_yolov9c.pt|face_yolov9c.pt",
      ].join("\n"),
    );
    assert.equal(runSkipFilter(undefined, ".", manifest), manifest);
    assert.equal(runSkipFilter("@@not base64@@", ".", manifest), manifest);
  },
);
