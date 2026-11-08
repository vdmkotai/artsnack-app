import assert from "node:assert/strict";
import test from "node:test";
import {
  atlasCatalogRows,
  atlasDefaults,
  atlasFrameSlots,
  atlasScalarParams,
  atlasVariants,
  getAtlasModel,
  resolveAtlasVariant,
} from "./atlas-models";
import { buildAtlasRequest } from "./atlas-payload";
import { defaultAtlasRecord, remapAtlasReferenceDetails } from "./atlas-records";

const images = ["https://media.example/a.jpg", "https://media.example/b.jpg"];
const request = (
  model: string,
  params: Record<string, string | number | boolean | string[]> = {},
  refs = images,
) =>
  buildAtlasRequest({
    model,
    params: { prompt: "Move @image1 beside @image2.", ...params },
    referenceUrls: refs,
  }).body;

test("Gemini and Grok receive their distinct zero-based image markers", () => {
  assert.equal(
    request("google/gemini-omni-1.1-flash/reference-to-video").prompt,
    "Move <IMAGE_REF_0> beside <IMAGE_REF_1>.",
  );
  assert.equal(
    request("xai/grok-imagine-video-v1.5/reference-to-video").prompt,
    "Move <IMAGE_0> beside <IMAGE_1>.",
  );
});

test("Gemini frame input and tagged references use different endpoints and fields", () => {
  const frame = getAtlasModel("google/gemini-omni-1.1-flash/image-to-video");
  assert.deepEqual(atlasFrameSlots(frame), ["Start", "End"]);
  const body = request(frame.id, { prompt: "Move between the frames" });
  assert.equal(body.image, images[0]);
  assert.equal(body.last_image, images[1]);
  assert.equal(
    resolveAtlasVariant(frame, 2, "Animate @image1").id,
    "google/gemini-omni-1.1-flash/reference-to-video",
  );
});

test("Pixverse carries reference types and names and translates image tags", () => {
  const body = request("pixverse/v6/reference-to-video", {
    images_details: JSON.stringify([
      { type: "subject", ref_name: "hero" },
      { type: "background", ref_name: "room" },
    ]),
  });
  assert.deepEqual(body.images, [
    { image: images[0], type: "subject", ref_name: "hero" },
    { image: images[1], type: "background", ref_name: "room" },
  ]);
  assert.equal(body.prompt, "Move @hero  beside @room .");
  assert.throws(
    () =>
      request("pixverse/v6/reference-to-video", {
        images_details: JSON.stringify([{ ref_name: "same" }, { ref_name: "same" }]),
      }),
    /unique/,
  );
  const cleared = request("pixverse/v6/reference-to-video", {
    images_details: JSON.stringify([{ ref_name: "" }, { ref_name: "room" }]),
  });
  assert.match(String(cleared.prompt), /@reference1 /);
});

test("Pixverse names stay unique after deleting an attachment and adding another", () => {
  const model = getAtlasModel("pixverse/v6/reference-to-video");
  const first = remapAtlasReferenceDetails(model, atlasDefaults(model), ["a", "b"], ["b"]);
  const next = remapAtlasReferenceDetails(model, first, ["b"], ["b", "c"]);
  const rows = JSON.parse(String(next.images_details));
  assert.deepEqual(
    rows.map((row: { ref_name: string }) => row.ref_name),
    ["reference2", "reference3"],
  );
  const body = request(model.id, next);
  assert.equal(body.prompt, "Move @reference2  beside @reference3 .");
});

test("Vidu groups views of a subject while tags still identify each attached image", () => {
  const body = request("vidu/q2/reference-to-video", {
    subjects_details: JSON.stringify([{ id: "hero" }, { id: "hero" }]),
  });
  assert.deepEqual(body.subjects, [{ id: "hero", images }]);
  assert.equal(body.prompt, "Move @hero beside @hero.");
  assert.throws(
    () =>
      request(
        "vidu/q2/reference-to-video",
        { subjects_details: JSON.stringify(Array.from({ length: 4 }, () => ({ id: "hero" }))) },
        [...images, ...images],
      ),
    /three images/,
  );
});

test("new image/video families start with text and expose every sibling", () => {
  for (const media of ["image", "video"] as const) {
    for (const row of atlasCatalogRows(media)) {
      const text = atlasVariants(row.model).text;
      if (text) assert.equal(row.model.id, text.id);
    }
  }
  const text = getAtlasModel("google/nano-banana-2/text-to-image");
  const clips = atlasScalarParams(text).find((param) => param.name === "video_clips");
  assert.ok(clips, "video controls must remain reachable from text mode");
  const params = {
    video_clips: JSON.stringify([
      { url: "https://media.example/input.mp4", start: 0, ends: 0, fps: 1 },
    ]),
  };
  const reference = resolveAtlasVariant(text, 0, "Describe the video", params);
  assert.equal(reference.id, "google/nano-banana-2/reference-to-image");
  const body = request(reference.id, { ...params, prompt: "Describe the video" }, []);
  assert.deepEqual(body.video_clips, JSON.parse(params.video_clips));
});

test("Kling initializes visible subject enums and validates shot durations before submission", () => {
  const model = getAtlasModel("kwaivgi/kling-v3.0-pro/image-to-video");
  const elements = model.params.find((param) => param.name === "elements")!;
  const row = {
    ...defaultAtlasRecord(elements, 0),
    element_name: "hero",
    frontal_image: images[0],
    refer_images: [images[1]],
  };
  const body = request(
    model.id,
    { prompt: "<<<element_1>>> walks", elements: JSON.stringify([row]) },
    [images[0]],
  );
  assert.equal((body.elements as Array<Record<string, unknown>>)[0].reference_type, "image_refer");
  assert.throws(
    () =>
      request(model.id, { prompt: "walk", multi_shot: true, shot_type: "customize" }, [images[0]]),
    /shot prompts/,
  );
  assert.throws(
    () =>
      request(
        model.id,
        {
          prompt: "walk",
          duration: 5,
          multi_prompt: JSON.stringify([{ index: 1, prompt: "walk", duration: "3" }]),
        },
        [images[0]],
      ),
    /add up/,
  );
});

test("required video URLs and H3 mixed-reference rules refuse invalid requests", () => {
  assert.throws(
    () =>
      request(
        "minimax/h3/reference-to-video",
        { prompt: "walk", refers_audio_urls: ["https://media.example/a.mp3"] },
        [],
      ),
    /image or video/,
  );
  assert.throws(
    () =>
      request(
        "minimax/h3/reference-to-video",
        { prompt: "walk", refers_video_urls: ["javascript:bad"] },
        [],
      ),
    /HTTP/,
  );
  const body = request(
    "minimax/h3/reference-to-video",
    { prompt: "walk", refers_video_urls: ["https://media.example/a.mp4"] },
    [],
  );
  assert.deepEqual(body.refers, [{ url: "https://media.example/a.mp4", type: "video" }]);
});

test("saved Prime uppercase resolution keeps its tier after the schema casing change", () => {
  const body = request(
    "alibaba/wan-3.0-prime/image-to-video",
    { prompt: "walk", resolution: "720P" },
    [images[0]],
  );
  assert.equal(body.resolution, "720p");
});
