import assert from "node:assert/strict";
import test from "node:test";

import {
  ATLAS_FANOUT_COUNTS,
  ATLAS_IMAGE_MODES,
  ATLAS_MODELS,
  ATLAS_PROMPT_PARAM,
  atlasBatchParam,
  atlasCatalogRows,
  atlasFamilyMaxReferences,
  atlasFamilyReadsTags,
  atlasFrameSlots,
  atlasImageModes,
  atlasVariants,
  atlasVendors,
  atlasParam,
  atlasPromptValue,
  atlasReferenceHint,
  resolveAtlasVariant,
  atlasSupportsPromptTags,
  atlasDefaults,
  atlasMaxReferences,
  atlasMediaParams,
  atlasSuccessor,
  atlasScalarParams,
  atlasUnsupportedParams,
  clampAtlasValue,
  defaultAtlasModel,
  getAtlasModel,
  isAtlasImageMode,
  normalizeAtlasParams,
  searchAtlasModels,
  type AtlasParam,
} from "./atlas-models";

/**
 * The catalogue is generated, so these are not tests of hand-written data —
 * they are the contract the generator has to keep. A schema change at Atlas
 * that breaks one of them should fail here rather than in production.
 */

test("every model carries the fields the request builder reads", () => {
  assert.ok(ATLAS_MODELS.length > 100, "catalogue looks truncated");
  for (const model of ATLAS_MODELS) {
    assert.ok(model.id.length > 0, "model has no id");
    assert.ok(model.label.length > 0, `${model.id} has no label`);
    assert.ok(model.media === "image" || model.media === "video", `${model.id} has odd media`);
    assert.match(model.submitPath, /^\/api\/v1\/model\/generate(Image|Video)$/, model.id);
    assert.ok(
      model.pollPath.includes("/{request_id}"),
      `${model.id} poll path is not a template: ${model.pollPath}`,
    );
    assert.ok(model.basePrice === null || model.basePrice > 0, `${model.id} has a zero price`);
  }
});

test("the submit path always matches the media type", () => {
  for (const model of ATLAS_MODELS) {
    const expected = model.media === "video" ? "generateVideo" : "generateImage";
    assert.ok(
      model.submitPath.endsWith(expected),
      `${model.id} is ${model.media} but posts to ${model.submitPath}`,
    );
  }
});

test("model ids are unique", () => {
  const seen = new Set<string>();
  for (const model of ATLAS_MODELS) {
    assert.ok(!seen.has(model.id), `duplicate model id: ${model.id}`);
    seen.add(model.id);
  }
});

test("enum parameters declare options, and their default is one of them", () => {
  for (const model of ATLAS_MODELS) {
    for (const param of model.params) {
      if (param.kind !== "enum") continue;
      assert.ok(
        param.options && param.options.length > 0,
        `${model.id}.${param.name} has no options`,
      );
      if (param.default !== undefined) {
        assert.ok(
          param.options.includes(param.default as string | number),
          `${model.id}.${param.name} defaults to ${String(param.default)}, not in its enum`,
        );
      }
    }
  }
});

test("no model requires a parameter the form cannot collect", () => {
  for (const model of ATLAS_MODELS) {
    for (const param of atlasUnsupportedParams(model)) {
      assert.equal(
        param.required,
        false,
        `${model.id} requires ${param.name} (${param.kind}), which nothing can fill`,
      );
    }
  }
});

test("media parameters never overlap with scalars", () => {
  for (const model of ATLAS_MODELS) {
    const media = new Set(atlasMediaParams(model).map((param) => param.name));
    for (const param of atlasScalarParams(model)) {
      assert.ok(!media.has(param.name), `${model.id}.${param.name} is both media and scalar`);
    }
  }
});

test("no content-filter-free variant is in the catalogue", () => {
  for (const model of ATLAS_MODELS) {
    assert.ok(!/spicy|uncensored|nsfw/i.test(`${model.id} ${model.label}`), model.id);
    assert.equal("uncensored" in model, false, `${model.id} still carries an uncensored flag`);
  }
});

test("no model offers a switch that loosens vendor moderation", () => {
  for (const model of ATLAS_MODELS) {
    for (const name of ["enable_safety_checker", "safety_tolerance", "moderation"]) {
      assert.equal(atlasParam(model, name), undefined, `${model.id}.${name}`);
    }
  }
});

test("Seedance 2.0 keeps the shape the vendor documents", () => {
  const model = getAtlasModel("bytedance/seedance-2.0/text-to-video");
  assert.equal(model.media, "video");
  const duration = model.params.find((param) => param.name === "duration");
  assert.equal(duration?.kind, "enum");
  assert.ok(duration?.options?.includes(15), "15s is missing from Seedance durations");
  const resolution = model.params.find((param) => param.name === "resolution");
  assert.ok(resolution?.options?.includes("1080p"), "1080p is missing from Seedance resolutions");
});

test("Seedance 2.5 keeps the shape the vendor documents", () => {
  // 2.5's headline: 30-second single-pass videos, but only 480p/720p on Atlas
  // (the "native 4K" language is about the model family, not this API), no
  // seed parameter, and reference-to-video reads @-tags rather than ordinals.
  for (const variant of ["text-to-video", "image-to-video", "reference-to-video"]) {
    const model = getAtlasModel(`bytedance/seedance-2.5/${variant}`);
    assert.equal(model.media, "video");
    const byName = new Map(model.params.map((param) => [param.name, param]));
    assert.ok(byName.get("duration")?.options?.includes(30), `${variant} lost 30s durations`);
    assert.ok(byName.get("duration")?.options?.includes(-1), `${variant} lost auto duration`);
    assert.deepEqual(byName.get("resolution")?.options, [
      "480p",
      "720p",
      "720p-sr",
      "720p-esr",
      "1080p",
      "1080p-sr",
      "1080p-esr",
      "1080p-esr & 60fps",
      "1440p-sr",
      "1440p-esr",
      "4k-esr",
    ]);
    assert.ok(!byName.has("seed"), `${variant} grew a seed parameter 2.5 does not document`);
  }
  const reference = getAtlasModel("bytedance/seedance-2.5/reference-to-video");
  assert.equal(reference.promptRefs, "at-tag-title");
  const references = reference.params.find((param) => param.name === "reference_images");
  assert.equal(references?.kind, "media-list");
  assert.equal(references?.required, false);
  assert.equal(references?.maxItems, 30);
  assert.equal(atlasMaxReferences(reference), 30);
  const firstFrame = getAtlasModel("bytedance/seedance-2.5/image-to-video");
  assert.equal(firstFrame.params.find((param) => param.name === "image")?.required, true);
  assert.equal(firstFrame.params.find((param) => param.name === "last_image")?.role, "end");
});

test("Wan 3.0 and Prime expose every Atlas input mode", () => {
  for (const base of ["alibaba/wan-3.0", "alibaba/wan-3.0-prime"]) {
    const text = getAtlasModel(`${base}/text-to-video`);
    const image = getAtlasModel(`${base}/image-to-video`);
    const reference = getAtlasModel(`${base}/reference-to-video`);

    for (const model of [text, image, reference]) {
      const duration = atlasParam(model, "duration");
      assert.ok(duration?.options?.includes(-1), `${model.id} lost smart duration`);
      assert.ok(duration?.options?.includes(30), `${model.id} lost its 30s maximum`);
      assert.equal(atlasParam(model, "audio")?.default, true, `${model.id} lost native audio`);
      assert.equal(atlasParam(model, "prompt")?.maxLength, 20_000);
      assert.equal(atlasParam(model, "seed")?.default, -1);
      assert.ok(
        atlasParam(model, "resolution")?.options?.some((value) => /1080/i.test(String(value))),
      );
    }

    assert.equal(atlasParam(image, "image")?.required, true);
    assert.equal(atlasParam(image, "last_image")?.role, "end");
    assert.deepEqual(atlasFrameSlots(image), ["Start", "End"]);

    const refers = atlasParam(reference, "refers");
    assert.equal(reference.promptRefs, "ordinal-title");
    assert.equal(atlasSupportsPromptTags(reference), true);
    assert.equal(atlasFamilyReadsTags(text), true);
    assert.match(atlasReferenceHint(reference, 10), /@image1/);
    assert.match(atlasReferenceHint(reference, 10), /Image 1/);
    // The family rests on text-to-video, which has no media slots of its own;
    // the hint must describe the sibling the attachments will route to, not
    // emit "takes , filled in the order you select them".
    assert.match(atlasReferenceHint(text, 10), /Image 1/);
    assert.equal(refers?.kind, "typed-media-list");
    assert.equal(refers?.maxItems, 20);
    assert.equal(refers?.maxImageItems, 10);
    assert.equal(refers?.maxVideoItems, 5);
    assert.equal(refers?.maxAudioItems, 5);
    assert.equal(atlasMaxReferences(reference), 10);
    assert.equal(atlasFamilyMaxReferences(image), 10);
    assert.equal(atlasParam(reference, "file")?.kind, "string");
    assert.equal(atlasParam(reference, "link")?.kind, "string");
    assert.equal(atlasParam(reference, "enable_thinking")?.kind, "boolean");
    const virtual = atlasScalarParams(reference).filter((param) => param.virtual);
    assert.deepEqual(
      virtual.map((param) => [param.virtual, param.maxItems]),
      [
        ["typed-video-urls", 5],
        ["typed-audio-urls", 5],
      ],
    );

    const familyScalars = atlasScalarParams(text);
    for (const name of ["enable_thinking", "file", "link"]) {
      assert.equal(
        familyScalars.find((param) => param.name === name)?.virtual,
        "reference-sibling",
      );
    }

    assert.equal(resolveAtlasVariant(image, 0, "make a new scene").id, text.id);
    assert.equal(resolveAtlasVariant(text, 1, "animate it").id, image.id);
    assert.equal(
      resolveAtlasVariant(image, 1, "the person from @image1 enters the room").id,
      reference.id,
    );
    assert.equal(resolveAtlasVariant(image, 2, "interpolate these frames").id, image.id);
    assert.equal(resolveAtlasVariant(image, 3, "keep these subjects consistent").id, reference.id);
    assert.equal(
      resolveAtlasVariant(text, 0, "follow this motion", {
        refers_video_urls: ["https://media.example/motion.mp4"],
      }).id,
      reference.id,
    );
    assert.equal(
      resolveAtlasVariant(text, 0, "use the research", {
        link: "https://example.com/research",
      }).id,
      reference.id,
    );
    assert.equal(
      resolveAtlasVariant(text, 0, "follow this soundtrack", {
        refers_audio_urls: ["https://media.example/voice.mp3"],
      }).id,
      reference.id,
    );
    assert.equal(
      resolveAtlasVariant(text, 0, "use the brief", {
        file: "https://media.example/brief.pdf",
      }).id,
      reference.id,
    );
  }

  assert.deepEqual(
    atlasParam(getAtlasModel("alibaba/wan-3.0/text-to-video"), "resolution")?.options,
    ["1080p", "720p", "480p", "720p-esr", "1080p-esr", "1440p-esr", "4k-esr"],
  );
  assert.deepEqual(
    atlasParam(getAtlasModel("alibaba/wan-3.0-prime/text-to-video"), "resolution")?.options,
    ["1080p", "720p", "480p", "720p-esr", "1080p-esr", "1440p-esr", "4k-esr"],
  );
});

test("string lists without a documented item limit keep every value", () => {
  const param: AtlasParam = {
    name: "prompt",
    kind: "string-list",
    label: "Prompt",
    required: true,
  };
  assert.deepEqual(clampAtlasValue(param, ["first", "second"]), ["first", "second"]);
});

test("string lists within their limit keep their identity", () => {
  const param: AtlasParam = {
    name: "refers_video_urls",
    kind: "string-list",
    label: "Reference Video URLs",
    required: false,
    maxItems: 5,
  };
  // Same reference back, not an equal copy: normalizeAtlasParams reports an
  // adjustment whenever clamping returns a new value, and a fresh array per
  // pass toasted a phantom "Reference Video URLs → " on every form edit.
  const value = ["https://media.example/a.mp4"];
  assert.equal(clampAtlasValue(param, value), value);
  assert.deepEqual(clampAtlasValue(param, ["a", "b", "c", "d", "e", "f"]), [
    "a",
    "b",
    "c",
    "d",
    "e",
  ]);
});

test("re-normalizing an unchanged bag reports no adjustments", () => {
  for (const id of ["alibaba/wan-3.0/text-to-video", "alibaba/wan-3.0/reference-to-video"]) {
    const model = getAtlasModel(id);
    const first = normalizeAtlasParams(model, undefined);
    const second = normalizeAtlasParams(model, first.params);
    assert.deepEqual(second.adjustments, [], `${id} reports phantom adjustments`);
  }
});

test("Wan 2.2 image-to-video keeps the shape its schema publishes", () => {
  // A check that the distiller reads schemas the way a human does.
  const model = getAtlasModel("atlascloud/wan-2.2/image-to-video");
  assert.equal(model.submitPath, "/api/v1/model/generateVideo");
  const byName = new Map(model.params.map((param) => [param.name, param]));

  assert.equal(byName.get("image")?.kind, "media");
  assert.equal(byName.get("image")?.required, true);
  assert.equal(byName.get("prompt")?.required, true);
  assert.deepEqual(byName.get("resolution")?.options, ["480p", "720p"]);
  assert.equal(byName.get("resolution")?.default, "480p");
  assert.equal(byName.get("duration")?.kind, "integer");
  assert.equal(byName.get("duration")?.min, 3);
  assert.equal(byName.get("duration")?.max, 10);
  assert.equal(byName.get("duration")?.default, 5);
  assert.equal(byName.get("seed")?.default, -1);
});

test("defaults are legal values for their own parameter", () => {
  for (const model of ATLAS_MODELS) {
    const defaults = atlasDefaults(model);
    for (const param of atlasScalarParams(model)) {
      // The prompt is owned by the composer's own box, never the bag.
      if (param.name === ATLAS_PROMPT_PARAM) continue;
      const value = defaults[param.name];
      assert.deepEqual(
        clampAtlasValue(param, value),
        value,
        `${model.id}.${param.name} default ${String(value)} does not survive clamping`,
      );
    }
  }
});

test("clamping snaps numeric enums and resets unrecognised strings", () => {
  const duration: AtlasParam = {
    name: "duration",
    kind: "enum",
    label: "Duration",
    required: false,
    default: 5,
    options: [5, 8],
  };
  // Ordered values clamp to the nearest, which is what the user meant.
  assert.equal(clampAtlasValue(duration, 7), 8);
  assert.equal(clampAtlasValue(duration, 100), 8);

  const resolution: AtlasParam = {
    name: "resolution",
    kind: "enum",
    label: "Resolution",
    required: false,
    default: "480p",
    options: ["480p", "720p"],
  };
  // "1080p" has no nearest — guessing between 720p and 720p-SR would be a
  // silent price change, so it resets to the default instead.
  assert.equal(clampAtlasValue(resolution, "1080p"), "480p");
  assert.equal(clampAtlasValue(resolution, "720p"), "720p");
});

test("clamping honours numeric bounds", () => {
  const seed: AtlasParam = {
    name: "seed",
    kind: "integer",
    label: "Seed",
    required: false,
    default: -1,
    min: -1,
    max: 4294967295,
  };
  assert.equal(clampAtlasValue(seed, -99), -1);
  assert.equal(clampAtlasValue(seed, 10 ** 12), 4294967295);
  assert.equal(clampAtlasValue(seed, 12.6), 13);
});

test("switching model keeps values the new one shares and drops the rest", () => {
  const seedance = getAtlasModel("bytedance/seedance-2.0/text-to-video");
  const wan = getAtlasModel("atlascloud/wan-2.2/image-to-video");

  const first = normalizeAtlasParams(seedance, {
    duration: 8,
    resolution: "1080p",
    bitrate_mode: "high",
  });
  assert.equal(first.params.duration, 8);

  const second = normalizeAtlasParams(wan, first.params);
  // Shared and legal, so it survives.
  assert.equal(second.params.duration, 8);
  // Wan has no bitrate_mode; sending it would fail the request.
  assert.ok(!("bitrate_mode" in second.params));
  // 1080p is not on Wan 2.2, so it resets and is reported.
  assert.equal(second.params.resolution, "480p");
  assert.ok(second.adjustments.some((line) => line.includes("Resolution")));
});

test("the default model for each media type is the cheapest live one", () => {
  for (const media of ["image", "video"] as const) {
    const model = defaultAtlasModel(media);
    assert.equal(model.media, media);
    assert.ok(!model.retired);
    const priced = ATLAS_MODELS.filter(
      (entry) => !entry.retired && entry.media === media && entry.basePrice !== null,
    );
    const cheapest = Math.min(...priced.map((entry) => entry.basePrice!));
    assert.equal(model.basePrice, cheapest, `${media} default is not the cheapest`);
  }
});

test("search filters by media and text", () => {
  const all = searchAtlasModels({ media: "video" });
  assert.ok(all.every((model) => model.media === "video"));
  // Cheapest sorts first, which makes the default the top row of the picker.
  assert.equal(all[0].id, defaultAtlasModel("video").id);
  assert.ok(all.every((model) => !model.retired));

  const wan = searchAtlasModels({ media: "video", query: "wan-3.0" });
  assert.ok(wan.length > 0);
  assert.ok(wan.every((model) => model.id.includes("wan-3.0")));

  assert.equal(searchAtlasModels({ media: "video", query: "no-such-model-xyz" }).length, 0);
});

test("reference capacity matches the declared media slots", () => {
  // Text-to-video takes none, so the picker stays hidden.
  assert.equal(atlasMaxReferences(getAtlasModel("bytedance/seedance-2.0/text-to-video")), 0);
  // One first-frame slot.
  assert.equal(atlasMaxReferences(getAtlasModel("atlascloud/wan-2.2/image-to-video")), 1);
  // Seedance 2.5 publishes a model-specific array limit instead of inheriting
  // the legacy nine-image ceiling used by Atlas models without maxItems.
  assert.equal(atlasMaxReferences(getAtlasModel("bytedance/seedance-2.5/reference-to-video")), 30);
  const legacyList = getAtlasModel("bytedance/seedance-2.0/reference-to-video");
  assert.equal(atlasMaxReferences(legacyList), 9);

  const listParam = atlasMediaParams(legacyList).find((param) => param.kind === "media-list");
  assert.ok(listParam);
  assert.equal(atlasMaxReferences({ ...legacyList, params: [{ ...listParam, maxItems: 3 }] }), 3);
  assert.equal(
    atlasMaxReferences({
      ...legacyList,
      params: [
        { ...listParam, name: "image", kind: "media" },
        { ...listParam, maxItems: 3 },
      ],
    }),
    4,
  );
  assert.equal(
    atlasMaxReferences({
      ...legacyList,
      params: [
        { ...listParam, name: "image", kind: "media" },
        { ...listParam, maxItems: 30 },
      ],
    }),
    31,
  );
  for (const model of ATLAS_MODELS) {
    assert.ok(atlasMaxReferences(model) >= 0, `${model.id} reports a negative capacity`);
  }
});

test("the vendor's example prompt never reaches the parameter bag", () => {
  // Atlas ships its documentation example as the `prompt` default. Collecting
  // it meant an empty prompt box submitted a stranger's sentence — and was
  // billed for it — on the 49 models where a prompt is optional.
  for (const model of ATLAS_MODELS) {
    assert.ok(
      !(ATLAS_PROMPT_PARAM in atlasDefaults(model)),
      `${model.id} carries a prompt default into the bag`,
    );
    const carried = normalizeAtlasParams(model, { prompt: "left over from another model" });
    assert.ok(
      !(ATLAS_PROMPT_PARAM in carried.params),
      `${model.id} carries a prompt across models`,
    );
  }
});

test("the prompt is rendered in the shape each model declares", () => {
  // Four models type `prompt` as an array. A bare string there was clamped away
  // and silently replaced by the schema default.
  const listModels = ATLAS_MODELS.filter((model) =>
    model.params.some((param) => param.name === "prompt" && param.kind === "string-list"),
  );
  assert.ok(listModels.length > 0, "expected at least one array-typed prompt");
  for (const model of listModels) {
    assert.deepEqual(atlasPromptValue(model, "a woman walking"), ["a woman walking"]);
    assert.deepEqual(atlasPromptValue(model, "   "), []);
  }

  const plain = getAtlasModel("atlascloud/wan-2.2/image-to-video");
  assert.equal(atlasPromptValue(plain, "a car"), "a car");
});

test("no model ships a media slot the reference picker cannot fill", () => {
  // The picker only ever produces images. A `video` or `audio` slot filled from
  // it would put a JPEG URL in a field the vendor reads as a clip.
  for (const model of ATLAS_MODELS) {
    for (const param of model.params) {
      if (param.kind !== "media" && param.kind !== "media-list") continue;
      assert.ok(
        param.role !== "video" && param.role !== "audio",
        `${model.id}.${param.name} is a ${param.role} slot`,
      );
    }
  }
});

test("media parameters are matched regardless of the vendor's casing", () => {
  // atlascloud/face-swap-image names its required target image `Image`, which
  // once fell through to a text box and made every submission fail.
  const model = getAtlasModel("atlascloud/face-swap-image");
  for (const name of ["image", "Image"]) {
    const param = model.params.find((entry) => entry.name === name);
    assert.equal(param?.kind, "media", `${name} should be a media slot`);
  }
});

test("3D generators are not shipped as image models", () => {
  for (const model of ATLAS_MODELS) {
    assert.ok(
      !model.categories.some((category) => category.endsWith("-3D")),
      `${model.id} produces 3D output the gallery cannot render`,
    );
  }
});

test("image models expose a count, either their own or ours", () => {
  // 82 of the 109 take no batch parameter, and before the fan-out was wired up
  // there was no way to ask an Atlas image model for more than one image.
  for (const model of ATLAS_MODELS) {
    if (model.media !== "image") continue;
    const batch = atlasBatchParam(model);
    if (batch) {
      assert.ok(
        batch.name === "num_images" || batch.name === "n",
        `${model.id} reported an odd batch parameter: ${batch.name}`,
      );
    }
  }
  // The fan-out list is what the form offers when there is no batch parameter.
  assert.deepEqual([...ATLAS_FANOUT_COUNTS], [1, 2, 3, 4, 6, 8, 10]);
});

test("free-text sizes are recognised, and preset-word sizes are left alone", () => {
  const withDimensions = ATLAS_MODELS.filter((model) =>
    model.params.some((param) => param.kind === "dimensions"),
  );
  assert.ok(withDimensions.length >= 20, `only ${withDimensions.length} models got a size picker`);

  // nvidia/cosmos-3-super calls its parameter `image_size` too, but wants words
  // like "landscape_16_9" — turning that into a pixel picker would send a value
  // the model rejects.
  const cosmos = getAtlasModel("nvidia/cosmos-3-super/text-to-image");
  assert.equal(atlasParam(cosmos, "image_size")?.kind, "string");
});

test("frame models get named slots and list models get counted ones", () => {
  // image + last_image is a first/last-frame pair: the badge has to say what
  // the image does, because "1" and "2" describe an ordering Seedance's
  // image-to-video endpoint does not have.
  assert.deepEqual(atlasFrameSlots(getAtlasModel("bytedance/seedance-2.0/image-to-video")), [
    "Start",
    "End",
  ]);

  // A reference list is exactly where the number is the meaning.
  assert.equal(atlasFrameSlots(getAtlasModel("bytedance/seedance-2.0/reference-to-video")), null);

  // Nothing to label on a text-to-video model.
  assert.equal(atlasFrameSlots(getAtlasModel("bytedance/seedance-2.0/text-to-video")), null);
});

test("slot names are unique, so two thumbnails never carry the same badge", () => {
  for (const model of ATLAS_MODELS) {
    const slots = atlasFrameSlots(model);
    if (!slots) continue;
    assert.equal(new Set(slots).size, slots.length, `${model.id} has duplicate slot names`);
    assert.equal(slots.length, atlasMaxReferences(model), `${model.id} slot count disagrees`);
  }
});

test("tagging is offered exactly where the vendor documents reading it", () => {
  for (const model of ATLAS_MODELS) {
    const offered = atlasSupportsPromptTags(model);
    if (offered) {
      assert.notEqual(model.promptRefs, "none", `${model.id} offers tags nothing reads`);
      assert.ok(
        atlasMediaParams(model).some(
          (param) =>
            param.kind === "media-list" ||
            param.kind === "typed-media-list" ||
            param.kind === "image-record-list",
        ),
        `${model.id} offers tags but takes no reference list`,
      );
    }
  }
  // The models this was reported broken on.
  assert.equal(
    atlasSupportsPromptTags(getAtlasModel("bytedance/seedance-2.0/reference-to-video")),
    true,
  );
  assert.equal(
    atlasSupportsPromptTags(getAtlasModel("bytedance/seedance-2.0/image-to-video")),
    false,
  );
  // Seedream's API takes an ordered images array, while Atlas's own prompt
  // examples address individual inputs as "Image 1", "Image 2", ... . The
  // editor should still offer its visual @ tags; the payload boundary rewrites
  // them into that ordinal wording.
  assert.equal(atlasSupportsPromptTags(getAtlasModel("bytedance/seedream-v5.0-pro/edit")), true);
  assert.equal(atlasFamilyReadsTags(getAtlasModel("bytedance/seedream-v5.0-pro/edit")), true);
});

test("the picker lists models, not endpoints", () => {
  // The reported symptom: searching "seedance 1." returned four rows that were
  // two models, each shown once per input shape.
  const rows = atlasCatalogRows("video");
  assert.ok(rows.length < ATLAS_MODELS.filter((m) => m.media === "video").length);

  const pro = rows.filter((row) => row.label === "Seedance v1.5 Pro");
  assert.equal(pro.length, 1, "text-to-video and image-to-video are one model");
  assert.deepEqual(pro[0].variants, ["text", "image"]);

  const seedance2 = rows.find((row) => row.label === "Seedance 2.0");
  assert.ok(seedance2);
  assert.deepEqual(seedance2.variants, ["text", "image", "reference"]);

  const seedance25 = rows.find((row) => row.label === "Seedance 2.5");
  assert.ok(seedance25);
  assert.equal(atlasMaxReferences(seedance25.model), 0, "row starts on the text endpoint");
  assert.equal(
    atlasFamilyMaxReferences(seedance25.model),
    30,
    "the picker must expose the reference sibling's capacity",
  );
});

test("every row is reachable, and every endpoint is behind exactly one row", () => {
  for (const media of ["image", "video"] as const) {
    const rows = atlasCatalogRows(media);
    const keys = new Set(rows.map((row) => row.key));
    assert.equal(keys.size, rows.length, `${media} rows have duplicate keys`);

    // Nothing is lost: every endpoint belongs to some row's family.
    const covered = new Set<string>();
    for (const row of rows) {
      const siblings = Object.values(atlasVariants(row.model));
      for (const sibling of siblings.length > 0 ? siblings : [row.model]) {
        covered.add(sibling.id);
      }
    }
    for (const model of ATLAS_MODELS.filter((entry) => !entry.retired && entry.media === media)) {
      assert.ok(covered.has(model.id), `${model.id} is unreachable from the picker`);
    }
  }
});

test("labels lose the endpoint suffix but keep what distinguishes the model", () => {
  const rows = atlasCatalogRows("video");
  for (const row of rows) {
    assert.ok(row.label.length > 0, `${row.key} has an empty label`);
    // Stripped only where the row stands for a family. On a lone endpoint the
    // suffix is what distinguishes it from its differently-named siblings.
    if (row.variants.length > 1) {
      assert.ok(
        !/-to-(video|image)$/i.test(row.label),
        `${row.key} still carries an endpoint suffix: ${row.label}`,
      );
    }
  }
  // No two rows may read the same, or the list is unusable.
  const labels = rows.map((row) => row.label);
  assert.equal(new Set(labels).size, labels.length, "two rows share a label");
  // "Fast" and "Mini" are the model, not the endpoint, so they must survive.
  assert.ok(rows.some((row) => row.label === "Seedance 2.0 Fast"));
  assert.ok(rows.some((row) => row.label === "Seedance 2.0 Mini"));
});

test("vendor counts add up to the rows they filter", () => {
  for (const media of ["image", "video"] as const) {
    const rows = atlasCatalogRows(media);
    const vendors = atlasVendors(media);
    assert.equal(
      vendors.reduce((total, entry) => total + entry.count, 0),
      rows.length,
      `${media} vendor counts do not sum to the row count`,
    );
  }
});

test("every still-image row has a tab, and the pairs Atlas does not route are split", () => {
  const rows = atlasCatalogRows("image");
  const modesOf = (key: string) => {
    const row = rows.find((candidate) => candidate.key === key);
    assert.ok(row, `${key} is not a row`);
    return atlasImageModes(row);
  };
  for (const row of rows) {
    const modes = atlasImageModes(row);
    assert.ok(modes.length > 0, `${row.key} is in no tab`);
    assert.ok(modes.every(isAtlasImageMode));
    // A tool is only a tool, never also a generator.
    if (modes.includes("tool")) assert.deepEqual(modes, ["tool"], row.key);
  }
  for (const mode of ATLAS_IMAGE_MODES) {
    assert.ok(
      rows.some((row) => atlasImageModes(row).includes(mode.id)),
      `${mode.id} would be an empty tab`,
    );
  }

  // The pair the picker exists to tell apart.
  assert.deepEqual(modesOf("bytedance/seedream-v5.0-pro/text-to-image"), ["text"]);
  assert.deepEqual(modesOf("bytedance/seedream-v5.0-pro/edit"), ["image"]);
  // Draws from text and takes pictures: in both.
  assert.deepEqual(modesOf("google/nano-banana-2.1/reference-to-image"), ["text", "image"]);
  assert.deepEqual(modesOf("black-forest-labs/flux-dev"), ["text", "image"]);
  // Utilities, whatever Atlas filed them under.
  for (const key of [
    "atlascloud/image-upscaler",
    "tencent/image/upscaler",
    "midjourney/v8.2/remove-background",
    "bytedance/seedream-v5.0-pro/layer-decomposition",
    "atlascloud/studio/image-clone",
  ]) {
    assert.deepEqual(modesOf(key), ["tool"], key);
  }
});

test("video rows have no image tabs", () => {
  for (const row of atlasCatalogRows("video")) assert.deepEqual(atlasImageModes(row), []);
});

test("Youchuan exposes Midjourney's prompt flags as controls, after its own fields", () => {
  const text = getAtlasModel("midjourney/v8.2/text-to-image");
  const image = getAtlasModel("midjourney/v8.2/image-to-image");
  const blend = getAtlasModel("midjourney/v8.2/blend");

  const flags = (model: typeof text) =>
    atlasScalarParams(model)
      .filter((param) => param.virtual === "midjourney-flag")
      .map((param) => param.name);
  assert.deepEqual(flags(text), ["mj_raw", "mj_no", "mj_sw", "mj_exp", "mj_tile"]);
  // Image weight only where there is an image prompt to weigh.
  assert.deepEqual(flags(image), ["mj_raw", "mj_no", "mj_sw", "mj_iw", "mj_exp", "mj_tile"]);
  // Blend's prompt is optional; nothing is appended to an empty one.
  assert.deepEqual(flags(blend), []);

  const scalars = atlasScalarParams(text);
  const lastVendorField = scalars.findIndex((param) => param.name === "seed");
  const firstFlag = scalars.findIndex((param) => param.virtual === "midjourney-flag");
  assert.ok(lastVendorField < firstFlag);

  // Defaults are part of a fresh form and survive a switch between siblings.
  const defaults = atlasDefaults(text);
  assert.equal(defaults.mj_raw, false);
  assert.equal(defaults.mj_sw, 100);
  const carried = normalizeAtlasParams(image, { ...defaults, mj_raw: true, mj_sw: 1500 });
  assert.equal(carried.params.mj_raw, true);
  assert.equal(carried.params.mj_sw, 1000);
  assert.equal(carried.params.mj_iw, 1);

  // Nothing app-only leaks into a model that does not read flags.
  const elsewhere = normalizeAtlasParams(getAtlasModel("atlascloud/wan-2.2/image-to-video"), {
    mj_raw: true,
  });
  assert.equal("mj_raw" in elsewhere.params, false);
});

test("Youchuan's style reference is a picker slot, not a URL to paste", () => {
  const text = getAtlasModel("midjourney/v8.2/text-to-image");
  const image = getAtlasModel("midjourney/v8.2/image-to-image");
  assert.equal(atlasParam(text, "sref")?.kind, "media");
  assert.equal(atlasMaxReferences(text), 1);
  assert.deepEqual(atlasFrameSlots(text), ["Style reference"]);
  assert.equal(atlasMaxReferences(image), 2);
  assert.deepEqual(atlasFrameSlots(image), ["Image", "Style reference"]);
  assert.match(atlasReferenceHint(image, 2), /takes an image and a style reference/);
  assert.match(atlasReferenceHint(text, 1), /takes a style reference, filled in the order/);
});

test("the 2026-09-25 families arrive as one picker row each, under the right vendor", () => {
  const rows = atlasCatalogRows("video");
  const row = (label: string) => rows.find((entry) => entry.label === label);
  assert.deepEqual(row("MiniMax H3 Fast")?.variants, ["text", "image", "reference"]);
  assert.deepEqual(row("MiniMax H3 Max Turbo")?.variants, ["text", "image"]);
  assert.deepEqual(row("Grok Imagine Video v1.5 Developer")?.variants, [
    "text",
    "image",
    "reference",
  ]);
  assert.deepEqual(row("Luma Ray 3.2")?.variants, ["text", "image"]);
  // Atlas files the new LTX endpoints under "LTX" and the older ones under
  // "LIGHTRICKS"; the rail must not show the same company twice.
  const ltx = rows.filter((entry) => entry.model.id.startsWith("ltx/"));
  assert.ok(ltx.length >= 7);
  assert.ok(ltx.every((entry) => entry.vendor === "Lightricks"));
  assert.ok(!atlasVendors("video").some((vendor) => vendor.name === "Ltx"));
});

test("MAI-Image-2.6's size words survive defaults, clamping and model switches", () => {
  const model = getAtlasModel("microsoft/mai-image-2.6/text-to-image");
  const size = atlasParam(model, "size")!;
  assert.equal(size.kind, "dimensions");
  assert.deepEqual(size.specialValues, ["default", "auto"]);
  assert.equal(atlasDefaults(model).size, "default");
  assert.equal(clampAtlasValue(size, "auto"), "auto");
  assert.equal(clampAtlasValue(size, "4000*4000"), "1536*1536");
  // A word is only legal where the vendor lists it.
  const older = atlasParam(getAtlasModel("microsoft/mai-image-2.5/text-to-image"), "size")!;
  assert.equal(clampAtlasValue(older, "auto"), "1024*1024");
});

test("a seed without a documented default is left to the vendor, not pinned at 0", () => {
  const flux = getAtlasModel("black-forest-labs/flux-3/text-to-video");
  const seed = atlasParam(flux, "seed")!;
  assert.equal(seed.default, undefined);
  assert.equal(atlasDefaults(flux).seed, "");
  assert.equal(clampAtlasValue(seed, 42), 42);
  // Documented "-1 means random" seeds keep their -1.
  assert.equal(atlasDefaults(getAtlasModel("atlascloud/wan-2.2/image-to-video")).seed, -1);
  // Arriving from an unset value is not an adjustment worth a toast.
  const grok = getAtlasModel("xai/grok-imagine-image-2.0/text-to-image");
  const carried = normalizeAtlasParams(grok, { aspect_ratio: "", seed: "" });
  assert.deepEqual(carried.adjustments, []);
});

test("a renamed Atlas endpoint resolves to its successor", () => {
  // Youchuan's Midjourney endpoints moved to midjourney/… on 2026-10-24.
  const old = getAtlasModel("youchuan/v8.2/text-to-image");
  assert.equal(old.retired, true);
  assert.equal(atlasSuccessor(old)?.id, "midjourney/v8.2/text-to-image");
  // Live models and retired models without a rename have none.
  assert.equal(atlasSuccessor(getAtlasModel("midjourney/v8.2/text-to-image")), undefined);
  assert.equal(atlasSuccessor(getAtlasModel("openai/gpt-image-1/text-to-image")), undefined);
});

test("Kling 4.0 takes at most ten images across references and keyframes", () => {
  // 10 references + first + 8 middle + last are declared; Kling caps the total.
  assert.equal(atlasMaxReferences(getAtlasModel("kwaivgi/kling-v4.0/reference-to-video")), 10);
  assert.equal(atlasMaxReferences(getAtlasModel("kwaivgi/kling-v4.0/image-to-video")), 10);
  assert.equal(
    getAtlasModel("kwaivgi/kling-v4.0/reference-to-video").promptRefs,
    "at-tag-underscore",
  );
});
