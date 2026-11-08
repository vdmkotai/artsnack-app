/**
 * Face Fix, run against a real pod.
 *
 * The unit tests assert the shape of the graph; this asserts that ComfyUI
 * accepts it — which is a different thing entirely, because a wrong node id, a
 * detector file that is not on disk or an output index off by one all type-check
 * cleanly and fail only here. It generates a source image with a deliberately
 * small face, runs Face Fix over it, and writes both out for a look.
 *
 *   bun infra/facefix-smoke.ts http://127.0.0.1:8288
 *   CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… \
 *     bun infra/facefix-smoke.ts https://comfy.example.com
 *
 * Meant to be run on the pod itself (or through an SSH tunnel), so it never
 * needs the app's auth.
 */

import {
  buildFaceFixWorkflow,
  FACE_FIX_FALLBACK_CHECKPOINT,
} from "../packages/shared/enhance-workflows";
import { comfyAuthHeadersForUrl } from "../packages/shared/comfyui-auth";

const POD = (process.argv[2] ?? process.env.COMFYUI_URL ?? "http://127.0.0.1:8288").replace(
  /\/+$/,
  "",
);
const AUTH_HEADERS = comfyAuthHeadersForUrl(
  { ...process.env, VAST_BACKEND_PUBLIC_URL: process.env.VAST_BACKEND_PUBLIC_URL ?? POD },
  POD,
);
const CHECKPOINT = process.argv[3] ?? FACE_FIX_FALLBACK_CHECKPOINT;
const PROMPT =
  process.argv[4] ??
  "full body photo of a woman standing on a city street, wide shot, distant, walking away from camera, urban background, natural light";
const NEGATIVE = "worst quality, low quality, blurry, deformed";

async function submit(workflow: Record<string, unknown>): Promise<string[]> {
  const res = await fetch(`${POD}/prompt`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pod refused the graph: ${JSON.stringify(body)}`);
  const promptId = body.prompt_id as string;

  for (let attempt = 0; attempt < 600; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const history = await (
      await fetch(`${POD}/history/${promptId}`, { headers: AUTH_HEADERS })
    ).json();
    const entry = history[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      throw new Error(`pod failed the graph: ${JSON.stringify(entry.status.messages)}`);
    }
    if (!entry.status?.completed) continue;
    const files: string[] = [];
    for (const output of Object.values(entry.outputs ?? {}) as {
      images?: { filename: string }[];
    }[]) {
      for (const image of output.images ?? []) files.push(image.filename);
    }
    return files;
  }
  throw new Error("timed out waiting for the pod");
}

function txt2img(): Record<string, unknown> {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: CHECKPOINT } },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: 832, height: 1216, batch_size: 1 },
    },
    "6": { class_type: "CLIPTextEncode", inputs: { text: PROMPT, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: NEGATIVE, clip: ["4", 1] } },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: 123456,
        steps: 25,
        cfg: 7,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "SMOKE_source", images: ["8", 0] },
    },
  };
}

/** ComfyUI reads LoadImage from its input dir, so the source has to go back up. */
async function uploadOutput(filename: string): Promise<string> {
  const bytes = await (
    await fetch(`${POD}/view?filename=${encodeURIComponent(filename)}&type=output`, {
      headers: AUTH_HEADERS,
    })
  ).arrayBuffer();
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), filename);
  form.append("overwrite", "true");
  const res = await fetch(`${POD}/upload/image`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: form,
  });
  const { name } = (await res.json()) as { name: string };
  return name;
}

/**
 * The pixels, not the file.
 *
 * "Did this pass change anything" is the question the smoke test exists for — a
 * Face Fix that detects nothing returns the source unaltered and reports
 * success, which reads exactly like a Face Fix that worked. Comparing whole
 * files cannot answer it: ComfyUI embeds the graph it ran in a tEXt chunk, so
 * two identical images off two different graphs are different files. The IDAT
 * chunks are the compressed pixels and nothing else, and one encoder wrote both.
 */
function pixelHash(png: Uint8Array): number {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let hash = 0x811c9dc5; // FNV-1a, which is plenty for "are these the same bytes"
  let at = 8; // PNG signature
  while (at + 8 <= png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === "IDAT") {
      for (let i = at + 8; i < at + 8 + length; i++) {
        hash = Math.imul(hash ^ png[i], 0x01000193);
      }
    }
    if (type === "IEND") break;
    at += 12 + length;
  }
  return hash >>> 0;
}

async function fetchOutput(filename: string): Promise<number> {
  const bytes = await (
    await fetch(`${POD}/view?filename=${encodeURIComponent(filename)}&type=output`, {
      headers: AUTH_HEADERS,
    })
  ).arrayBuffer();
  return pixelHash(new Uint8Array(bytes));
}

const started = Date.now();
console.log(`source: generating with ${CHECKPOINT}`);
const [source] = await submit(txt2img());
console.log(`source: ${source} (${((Date.now() - started) / 1000).toFixed(1)}s)`);

const uploaded = await uploadOutput(source);
let previous = await fetchOutput(source);

for (const variant of [
  { label: "face pass only", refineEyes: false },
  { label: "face + eye pass", refineEyes: true },
]) {
  const at = Date.now();
  const files = await submit(
    buildFaceFixWorkflow({
      inputImageFilename: uploaded,
      seed: 123456,
      checkpoint: CHECKPOINT,
      prompt: PROMPT,
      negativePrompt: NEGATIVE,
      refineEyes: variant.refineEyes,
    }),
  );
  const seconds = ((Date.now() - at) / 1000).toFixed(1);
  if (files.length === 0) {
    console.log(`${variant.label}: NO OUTPUT (${seconds}s)`);
    continue;
  }
  const pixels = await fetchOutput(files[0]);
  console.log(
    `${variant.label}: ${files[0]} (${seconds}s) — ${
      pixels === previous ? "LEFT THE IMAGE ALONE" : "changed the image"
    }`,
  );
  previous = pixels;
}
