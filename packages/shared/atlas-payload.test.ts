import assert from "node:assert/strict";
import test from "node:test";

import {
  ATLAS_MODELS,
  ATLAS_PROMPT_PARAM,
  atlasMediaParams,
  atlasParam,
  getAtlasModel,
} from "./atlas-models";
import { defaultAtlasRecord } from "./atlas-records";
import { atlasDefaults, type AtlasModel, type AtlasParamValue } from "./atlas-models";
import { AtlasPayloadError, assignAtlasMedia, buildAtlasRequest } from "./atlas-payload";

function validInputs(model: AtlasModel): Record<string, AtlasParamValue> {
  const params = atlasDefaults(model);
  for (const param of model.params) {
    if (!param.required) continue;
    if (param.kind === "url") params[param.name] = "https://media.example/source.mp4";
    if (param.kind === "url-list") params[param.name] = ["https://media.example/source.mp4"];
    if (param.kind === "string") params[param.name] = "test prompt";
    if (param.kind === "string-list") params[param.name] = ["test prompt"];
    if (param.kind === "record-list") {
      const row = defaultAtlasRecord(param, 0);
      for (const field of param.fields ?? [])
        if (field.kind === "url") row[field.name] = "https://media.example/source.mp4";
      params[param.name] = JSON.stringify([row]);
    }
  }
  return params;
}

test("builds the exact body the vendor documents for Wan 2.2", () => {
  const request = buildAtlasRequest({
    model: "atlascloud/wan-2.2/image-to-video",
    params: { prompt: "a car in the desert", resolution: "720p", duration: 8, seed: -1 },
    referenceUrls: ["https://media.example/first.jpg"],
  });

  assert.equal(request.submitPath, "/api/v1/model/generateVideo");
  assert.deepEqual(request.body, {
    model: "atlascloud/wan-2.2/image-to-video",
    image: "https://media.example/first.jpg",
    prompt: "a car in the desert",
    resolution: "720p",
    duration: 8,
    seed: -1,
  });
});

test("parameters the model does not declare are dropped, not forwarded", () => {
  // The single most likely bug in a shared form: Seedance settings surviving a
  // switch to Wan, which rejects unknown properties outright.
  const request = buildAtlasRequest({
    model: "atlascloud/wan-2.2/image-to-video",
    params: { prompt: "x", bitrate_mode: "high", generate_audio: true, watermark: false },
    referenceUrls: ["https://media.example/a.jpg"],
  });

  assert.ok(!("bitrate_mode" in request.body));
  assert.ok(!("generate_audio" in request.body));
  assert.ok(!("watermark" in request.body));
});

test("illegal values are clamped rather than sent through", () => {
  const request = buildAtlasRequest({
    model: "atlascloud/wan-2.2/image-to-video",
    params: { prompt: "x", resolution: "4k", duration: 900 },
    referenceUrls: ["https://media.example/a.jpg"],
  });

  // 4k is not on this model, so it resets to the documented default.
  assert.equal(request.body.resolution, "480p");
  // 900s clamps to the longest legal length.
  assert.equal(request.body.duration, 10);
});

test("a missing required image is refused before the request is billed", () => {
  assert.throws(
    () =>
      buildAtlasRequest({
        model: "atlascloud/wan-2.2/image-to-video",
        params: { prompt: "x" },
        referenceUrls: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof AtlasPayloadError);
      assert.match(error.message, /attach a reference image/i);
      return true;
    },
  );
});

test("blank optional strings are omitted, required ones are not silently dropped", () => {
  const model = ATLAS_MODELS.find(
    (entry) =>
      entry.params.some((param) => param.name === "negative_prompt" && !param.required) &&
      entry.params.some((param) => param.name === "prompt" && param.required) &&
      atlasMediaParams(entry).length === 0,
  );
  assert.ok(model, "expected a text-to-X model with an optional negative prompt");

  const request = buildAtlasRequest({
    model: model.id,
    params: { prompt: "a cat", negative_prompt: "   " },
  });
  assert.equal(request.body.prompt, "a cat");
  assert.ok(!("negative_prompt" in request.body), "blank negative prompt should be omitted");
});

test("media slots fill in declaration order, and a list takes the remainder", () => {
  const model = getAtlasModel("atlascloud/wan-2.2/image-to-video");
  const single = assignAtlasMedia(model, ["a", "b", "c"]);
  // One slot, so only one URL is consumed and the rest are ignored rather than
  // stuffed into a field the model has never heard of.
  assert.deepEqual(single.values, { image: "a" });
  assert.equal(single.used, 1);

  const listModel = ATLAS_MODELS.find((entry) =>
    atlasMediaParams(entry).some((param) => param.kind === "media-list"),
  );
  assert.ok(listModel);
  const listParam = atlasMediaParams(listModel).find((param) => param.kind === "media-list");
  assert.ok(listParam);
  const many = assignAtlasMedia(listModel, ["a", "b", "c"]);
  assert.ok(Array.isArray(many.values[listParam.name]));
});

test("Seedance 2.5 sends all 30 documented image references", () => {
  const referenceUrls = Array.from(
    { length: 30 },
    (_, index) => `https://media.example/reference-${index + 1}.jpg`,
  );
  const request = buildAtlasRequest({
    model: "bytedance/seedance-2.5/reference-to-video",
    params: { prompt: "the character dances" },
    referenceUrls,
  });

  assert.deepEqual(request.body.reference_images, referenceUrls);
});

test("Wan 3.0 sends image references as typed mixed-media items", () => {
  const urls = ["https://media.example/person.jpg", "https://media.example/product.webp"];
  const request = buildAtlasRequest({
    model: "alibaba/wan-3.0/reference-to-video",
    params: {
      prompt: "keep the person and product consistent",
      duration: 30,
      resolution: "1080p",
      ratio: "adaptive",
      audio: true,
      enable_thinking: false,
      refers_video_urls: ["https://media.example/motion.mp4", "https://media.example/camera.mov"],
      refers_audio_urls: ["https://media.example/voice.mp3"],
    },
    referenceUrls: urls,
  });

  assert.deepEqual(request.body.refers, [
    { url: urls[0], type: "image" },
    { url: urls[1], type: "image" },
    { url: "https://media.example/motion.mp4", type: "video" },
    { url: "https://media.example/camera.mov", type: "video" },
    { url: "https://media.example/voice.mp3", type: "audio" },
  ]);
  assert.equal(request.body.duration, 30);
  assert.equal(request.body.audio, true);
});

test("Wan 3.0 and Prime translate editor image tags to title-cased ordinals", () => {
  for (const model of [
    "alibaba/wan-3.0/reference-to-video",
    "alibaba/wan-3.0-prime/reference-to-video",
  ]) {
    const request = buildAtlasRequest({
      model,
      params: {
        prompt: "the person from @image1 enters the room from @image2",
      },
      referenceUrls: ["https://media.example/person.jpg", "https://media.example/room.jpg"],
    });

    assert.equal(request.body.prompt, "the person from Image 1 enters the room from Image 2");
    assert.deepEqual(request.body.refers, [
      { url: "https://media.example/person.jpg", type: "image" },
      { url: "https://media.example/room.jpg", type: "image" },
    ]);
  }
});

test("Wan 3.0 refuses reference tags that do not point at an attached image", () => {
  for (const model of [
    "alibaba/wan-3.0/reference-to-video",
    "alibaba/wan-3.0-prime/reference-to-video",
  ]) {
    assert.throws(
      () =>
        buildAtlasRequest({
          model,
          params: { prompt: "use @image0" },
          referenceUrls: ["https://media.example/one.jpg"],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AtlasPayloadError);
        assert.match(error.message, /start at @image1/);
        return true;
      },
    );

    assert.throws(
      () =>
        buildAtlasRequest({
          model,
          params: { prompt: "use @image2" },
          referenceUrls: ["https://media.example/one.jpg"],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AtlasPayloadError);
        assert.match(error.message, /only 1 reference is attached/);
        return true;
      },
    );
  }
});

test("Wan 3.0 caps each mixed-media type and supports URL-only references", () => {
  const images = Array.from({ length: 10 }, (_, index) => `https://media.example/${index}.jpg`);
  const videos = Array.from({ length: 6 }, (_, index) => `https://media.example/${index}.mp4`);
  const audio = Array.from({ length: 6 }, (_, index) => `https://media.example/${index}.mp3`);
  const request = buildAtlasRequest({
    model: "alibaba/wan-3.0/reference-to-video",
    params: {
      prompt: "use every source",
      refers_video_urls: videos,
      refers_audio_urls: audio,
    },
    referenceUrls: images,
  });

  const refers = request.body.refers as { url: string; type: string }[];
  assert.equal(refers.length, 20);
  assert.deepEqual(
    refers.reduce<Record<string, number>>((counts, item) => {
      counts[item.type] = (counts[item.type] ?? 0) + 1;
      return counts;
    }, {}),
    { image: 10, video: 5, audio: 5 },
  );
  assert.equal("refers_video_urls" in request.body, false);
  assert.equal("refers_audio_urls" in request.body, false);

  const urlOnly = buildAtlasRequest({
    model: "alibaba/wan-3.0/reference-to-video",
    params: {
      prompt: "follow the clip and soundtrack",
      refers_video_urls: [videos[0]],
      refers_audio_urls: [audio[0]],
    },
  });
  assert.deepEqual(urlOnly.body.refers, [
    { url: videos[0], type: "video" },
    { url: audio[0], type: "audio" },
  ]);
});

test("Wan 3.0 accepts one document or webpage only in thinking mode", () => {
  const build = (params: Record<string, string | number | boolean | string[]>) =>
    buildAtlasRequest({
      model: "alibaba/wan-3.0/reference-to-video",
      params: { prompt: "turn this source into a video", ...params },
    });

  const document = build({
    enable_thinking: true,
    file: "https://media.example/brief.pdf",
  });
  assert.equal(document.body.file, "https://media.example/brief.pdf");

  const webpage = build({ enable_thinking: true, link: "https://example.com/report" });
  assert.equal(webpage.body.link, "https://example.com/report");

  assert.throws(
    () => build({ enable_thinking: false, link: "https://example.com/report" }),
    /Enable Thinking/,
  );
  assert.throws(
    () =>
      build({
        enable_thinking: true,
        file: "https://media.example/brief.pdf",
        link: "https://example.com/report",
      }),
    /either a document URL or a webpage/,
  );
});

test("Wan 3.0 refuses a prompt beyond its documented 20,000 characters", () => {
  const exact = buildAtlasRequest({
    model: "alibaba/wan-3.0/text-to-video",
    params: { prompt: "x".repeat(20_000) },
  });
  assert.equal(exact.body.prompt, "x".repeat(20_000));

  assert.throws(
    () =>
      buildAtlasRequest({
        model: "alibaba/wan-3.0/text-to-video",
        params: { prompt: "x".repeat(20_001) },
      }),
    /at most 20000 characters/,
  );
});

test("every model in the catalogue can build a request from its own defaults", () => {
  // A model that cannot be submitted from a fresh form is a model that should
  // not be in the picker. This is the broad sweep that proves it.
  let checked = 0;
  for (const model of ATLAS_MODELS) {
    const media = atlasMediaParams(model);
    // Give every slot a URL; a list slot is satisfied by one.
    const references = media.flatMap((param, index) =>
      Array.from(
        { length: Math.max(1, param.minItems ?? 1) },
        (_, i) => `https://media.example/${index}-${i}.jpg`,
      ),
    );
    const params = validInputs(model);
    for (const param of model.params) {
      // A fresh form's prompt box is empty — the vendor's example prompt never
      // reaches the bag (see the atlas-models test of the same name).
      if (param.name === ATLAS_PROMPT_PARAM) continue;
      if (param.default !== undefined) params[param.name] = param.default;
    }
    // Required free-text fields have no default on many models.
    for (const param of model.params) {
      if (param.kind === "string" && param.required) params[param.name] = "test prompt";
    }

    assert.doesNotThrow(
      () => buildAtlasRequest({ model: model.id, params, referenceUrls: references }),
      `${model.id} cannot be submitted from its own defaults`,
    );
    checked++;
  }
  assert.ok(checked > 100, "sweep did not cover the catalogue");
});

test("the model id is always present in the body", () => {
  for (const id of ["bytedance/seedance-2.0/text-to-video", "atlascloud/wan-2.2/image-to-video"]) {
    const model = getAtlasModel(id);
    const references = atlasMediaParams(model).map(() => "https://media.example/a.jpg");
    const request = buildAtlasRequest({
      model: id,
      params: { prompt: "x" },
      referenceUrls: references,
    });
    assert.equal(request.body.model, id);
  }
});

test("the prompt is rendered in the dialect each model documents", () => {
  // Seedance reads prose ordinals: "References like 'image 1' refer to inputs
  // in order." Sending our marker would put `@image1` in the prompt as text.
  const seedance = buildAtlasRequest({
    model: "bytedance/seedance-2.0/reference-to-video",
    params: { prompt: "a girl @image1 meets a guy @image2" },
    referenceUrls: ["https://media.example/a.jpg", "https://media.example/b.jpg"],
  });
  assert.equal(seedance.body.prompt, "a girl image 1 meets a guy image 2");

  // Seedance 2.5 reads `@imageN` as-is — no subject binding, no rewriting.
  const seedance25 = buildAtlasRequest({
    model: "bytedance/seedance-2.5/reference-to-video",
    params: { prompt: "the character in @image1 dances to @image2" },
    referenceUrls: ["https://media.example/a.jpg", "https://media.example/b.jpg"],
  });
  assert.equal(seedance25.body.prompt, "the character in @Image1 dances to @Image2");

  // Atlas documents Seedream Pro's multi-image prompts with ordinal prose,
  // even though its compact API schema only calls the field a positive prompt.
  // Keep the editor's visible tags as UX sugar and translate them at the wire.
  const seedreamPro = buildAtlasRequest({
    model: "bytedance/seedream-v5.0-pro/edit",
    params: { prompt: "put @image1 into the pose shown in @image2" },
    referenceUrls: ["https://media.example/person.jpg", "https://media.example/pose.jpg"],
  });
  assert.equal(seedreamPro.body.prompt, "put image 1 into the pose shown in image 2");
  assert.deepEqual(seedreamPro.body.images, [
    "https://media.example/person.jpg",
    "https://media.example/pose.jpg",
  ]);
});

test("optional tags are optional: Seedance 2.5 submits untagged", () => {
  // "Just use these as style references" is a legal 2.5 submission — the
  // vendor documents @-tags as available, not required, and its own example
  // prompt is prose. Blocking it locally was the bug.
  const untagged = buildAtlasRequest({
    model: "bytedance/seedance-2.5/reference-to-video",
    params: { prompt: "a moody rain-soaked alley in this style" },
    referenceUrls: ["https://media.example/a.jpg", "https://media.example/b.jpg"],
  });
  assert.equal(untagged.body.prompt, "a moody rain-soaked alley in this style");
});

test("models that read nothing get the tags removed, not forwarded", () => {
  // Seedream Lite's edit endpoint takes an ordered list but documents no way
  // to address one input in the prompt, so a tag left in is literal text.
  const edit = buildAtlasRequest({
    model: "bytedance/seedream-v5.0-lite/edit",
    params: { prompt: "make @image1 smile" },
    referenceUrls: ["https://media.example/a.jpg"],
  });
  assert.equal(edit.body.prompt, "make smile");
  assert.ok(!String(edit.body.prompt).includes("@image"));
});

test("every model either reads our tags or has them stripped", () => {
  // The sweep that makes the rule total: no model may receive `@image1` in a
  // prompt unless its own documentation says it reads that spelling.
  for (const model of ATLAS_MODELS) {
    const media = atlasMediaParams(model);
    const references = media.flatMap((param, index) =>
      Array.from(
        { length: Math.max(1, param.minItems ?? 1) },
        (_, i) => `https://media.example/${index}-${i}.jpg`,
      ),
    );
    const params = validInputs(model);
    for (const param of model.params) {
      if (param.default !== undefined) params[param.name] = param.default;
    }
    params.prompt = references.length ? "a girl @image1 walks" : "a girl walks";

    const request = buildAtlasRequest({ model: model.id, params, referenceUrls: references });
    const prompt = String(request.body.prompt ?? "");
    if (references.length && model.promptRefs === "at-tag-optional") {
      assert.ok(prompt.includes("@image1"), `${model.id} lost a tag it reads`);
    } else if (references.length && model.promptRefs === "at-tag-underscore") {
      assert.ok(prompt.includes("@image_1"), `${model.id} lost a tag it reads`);
      assert.ok(!prompt.includes("@image1"), `${model.id} received our spelling`);
    } else {
      assert.ok(!prompt.includes("@image"), `${model.id} received a tag it cannot read`);
    }
  }
});

test("Midjourney flag controls are folded into the prompt, never sent as fields", () => {
  const request = buildAtlasRequest({
    model: "midjourney/v8.2/text-to-image",
    params: {
      prompt: "a lighthouse in fog",
      aspect_ratio: "16:9",
      mj_raw: true,
      mj_no: "text,  watermark --seed 5",
      mj_exp: 25,
      mj_tile: false,
      mj_sw: 300,
    },
  });
  // --sw without a style reference is noise, and the exclusion cannot smuggle
  // a second flag in.
  assert.equal(
    request.body.prompt,
    "a lighthouse in fog --raw --no text, watermark seed 5 --exp 25",
  );
  assert.equal(request.body.aspect_ratio, "16:9");
  for (const key of Object.keys(request.body)) assert.ok(!key.startsWith("mj_"), key);

  const styled = buildAtlasRequest({
    model: "midjourney/v8.2/text-to-image",
    params: { prompt: "a lighthouse in fog", mj_sw: 300 },
    referenceUrls: ["https://media.example/style.jpg"],
  });
  assert.equal(styled.body.sref, "https://media.example/style.jpg");
  assert.equal(styled.body.prompt, "a lighthouse in fog --sw 300");

  // Defaults add nothing, and a flag typed by hand is not doubled.
  const untouched = buildAtlasRequest({
    model: "midjourney/v8.2/text-to-image",
    params: { prompt: "a lighthouse in fog --raw", mj_raw: true, mj_sw: 100, mj_exp: 0 },
  });
  assert.equal(untouched.body.prompt, "a lighthouse in fog --raw");

  // Image weight rides on the image prompt of image-to-image only.
  const edit = buildAtlasRequest({
    model: "midjourney/v8.2/image-to-image",
    params: { prompt: "as a watercolour", mj_iw: 2.5 },
    referenceUrls: ["https://media.example/photo.jpg"],
  });
  assert.equal(edit.body.image, "https://media.example/photo.jpg");
  assert.equal(edit.body.prompt, "as a watercolour --iw 2.5");

  // Flags do not count toward the vendor's 1024-character prompt limit.
  const atLimit = buildAtlasRequest({
    model: "midjourney/v8.2/text-to-image",
    params: { prompt: "x".repeat(1024), mj_raw: true },
  });
  assert.equal(atLimit.body.prompt, `${"x".repeat(1024)} --raw`);
  assert.throws(
    () =>
      buildAtlasRequest({
        model: "midjourney/v8.2/text-to-image",
        params: { prompt: "x".repeat(1025) },
      }),
    AtlasPayloadError,
  );
});

test("LTX refuses the combinations its documentation rules out, before billing", () => {
  const build = (model: string, params: Record<string, AtlasParamValue>, refs: string[] = []) =>
    buildAtlasRequest({
      model,
      params: { ...atlasDefaults(getAtlasModel(model)), prompt: "a lighthouse", ...params },
      referenceUrls: refs,
    });

  const fast = "ltx/ltx-2.5-fast/text-to-video";
  assert.equal(build(fast, { duration: 20, resolution: "1080p", fps: 25 }).body.duration, 20);
  assert.equal(build(fast, { duration: 10, resolution: "4k", fps: 50 }).body.resolution, "4k");
  assert.equal(build(fast, { duration: -1, resolution: "4k" }).body.duration, -1);
  assert.throws(() => build(fast, { duration: 12, resolution: "4k" }), /4K only up to 10 seconds/);
  assert.throws(() => build(fast, { duration: 12, fps: 48 }), /48 fps only up to 10 seconds/);

  // LTX-2.3 Fast cannot make audio, so its switch is not declared at all: a
  // value carried over from 2.3 Pro (audio on by default) is dropped, not sent.
  const silent = "ltx/ltx-2.3-fast/text-to-video";
  assert.equal(atlasParam(getAtlasModel(silent), "generate_audio"), undefined);
  assert.equal(build(silent, { generate_audio: true }).body.generate_audio, undefined);
  assert.equal(build("ltx/ltx-2.3-pro/text-to-video", {}).body.generate_audio, true);

  // Optional with no vendor default: unset unless chosen, never a forced dolly-in.
  assert.equal(build(fast, {}).body.camera_motion, undefined);
  assert.equal(build(fast, { camera_motion: "static" }).body.camera_motion, "static");

  const audio = "ltx/ltx-2.5-pro/audio-to-video";
  const track = { audio: "https://media.example/voice.mp3" };
  assert.equal(build(audio, track).body.audio, track.audio);
  // No prompt at all — the shape Convex stores for a blank optional prompt —
  // must not turn into the vendor's documentation example.
  assert.throws(
    () =>
      buildAtlasRequest({
        model: audio,
        params: { ...atlasDefaults(getAtlasModel(audio)), ...track },
      }),
    /prompt or a first-frame image/,
  );
  assert.throws(() => build(audio, { ...track, prompt: "" }), /prompt or a first-frame image/);
  assert.equal(
    build(audio, { ...track, prompt: "" }, ["https://media.example/face.jpg"]).body.image,
    "https://media.example/face.jpg",
  );
});

test("a blank optional prompt is omitted, never replaced by the vendor's example", () => {
  // Luma Ray 3.2 image-to-video ships "The scene comes alive…" as its default.
  const model = getAtlasModel("luma/ray-3.2/image-to-video");
  assert.ok(typeof atlasParam(model, "prompt")?.default === "string");
  const request = buildAtlasRequest({
    model: model.id,
    params: atlasDefaults(model),
    referenceUrls: ["https://media.example/frame.jpg"],
  });
  assert.equal(request.body.prompt, undefined);
});

test("optional enums without a vendor default are not sent until chosen", () => {
  const edit = getAtlasModel("google/nano-banana-2/edit");
  const request = buildAtlasRequest({
    model: edit.id,
    params: { ...atlasDefaults(edit), prompt: "make it night" },
    referenceUrls: ["https://media.example/source.jpg"],
  });
  assert.equal(request.body.aspect_ratio, undefined, "an edit follows its source image");

  // Kling's shot type is optional in isolation but required once multi-shot is on.
  const kling = getAtlasModel("kwaivgi/kling-v3.0-4k/image-to-video");
  const build = (params: Record<string, AtlasParamValue>) =>
    buildAtlasRequest({
      model: kling.id,
      params: { ...atlasDefaults(kling), prompt: "a dancer", ...params },
      referenceUrls: ["https://media.example/source.jpg"],
    });
  assert.equal(build({}).body.shot_type, undefined);
  assert.throws(() => build({ multi_shot: true }), /shot type/);
  assert.equal(
    build({ multi_shot: true, shot_type: "intelligence" }).body.shot_type,
    "intelligence",
  );
});

test("an unset seed is omitted so FLUX 3 does not repeat one result", () => {
  const model = getAtlasModel("black-forest-labs/flux-3/text-to-video");
  const request = buildAtlasRequest({
    model: model.id,
    params: { ...atlasDefaults(model), prompt: "waves at dusk" },
  });
  assert.equal(request.body.seed, undefined);
  const pinned = buildAtlasRequest({
    model: model.id,
    params: { ...atlasDefaults(model), prompt: "waves at dusk", seed: 7 },
  });
  assert.equal(pinned.body.seed, 7);
});

test("Kling 4.0 reads tags as @image_N", () => {
  const request = buildAtlasRequest({
    model: "kwaivgi/kling-v4.0/reference-to-video",
    params: { prompt: "@image1 hugs @image2 by the lake", duration: 5 },
    referenceUrls: ["https://media.example/a.jpg", "https://media.example/b.jpg"],
  });
  assert.equal(request.body.prompt, "@image_1 hugs @image_2 by the lake");
  assert.deepEqual(request.body.reference_images, [
    "https://media.example/a.jpg",
    "https://media.example/b.jpg",
  ]);
});

test("Kling 4.0 image-to-video puts the last image in the closing frame", () => {
  const model = getAtlasModel("kwaivgi/kling-v4.0/image-to-video");
  const two = assignAtlasMedia(model, ["first", "last"]);
  assert.deepEqual(two.values, { image: "first", last_image: "last" });
  assert.equal(two.used, 2);
  const four = assignAtlasMedia(model, ["first", "a", "b", "last"]);
  assert.deepEqual(four.values, { image: "first", middle_images: ["a", "b"], last_image: "last" });
  // One image is a first frame, as before.
  assert.deepEqual(assignAtlasMedia(model, ["only"]).values, { image: "only" });
  // A plain first/last pair is unchanged by the rule.
  const pair = getAtlasModel("bytedance/seedance-2.0/image-to-video");
  const slots = assignAtlasMedia(pair, ["a", "b"]).values;
  assert.equal(Object.values(slots).length, 2);
});
