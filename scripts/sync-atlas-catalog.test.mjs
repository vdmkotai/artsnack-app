import assert from "node:assert/strict";
import test from "node:test";
import fixtures from "./fixtures/atlas-reference-schemas.json" with { type: "json" };
import {
  classify,
  distill,
  isExcludedModel,
  partitionSchemaResults,
} from "./sync-atlas-catalog.mjs";

// Official Atlas REST schemas captured 2026-09-05, before distillation.
const models = fixtures.map(({ entry, schema }) => {
  const report = { skipped: [], pathMismatches: [] };
  const model = distill(entry, schema, report);
  assert.deepEqual(report.skipped, []);
  return model;
});

test("sync preserves distinct named and zero-based reference contracts", () => {
  const pix = models.find((model) => model.id.startsWith("pixverse/"));
  assert.equal(pix.promptRefs, "named-reference");
  assert.equal(pix.params.find((param) => param.name === "images").imageField, "image");
  const vidu = models.find((model) => model.id.startsWith("vidu/"));
  assert.equal(vidu.promptRefs, "subject");
  assert.equal(vidu.params.find((param) => param.name === "subjects").imageFieldArray, true);
  const gemini = models.find((model) => model.id.startsWith("google/gemini"));
  assert.equal(gemini.promptRefs, "image-ref-zero");
  assert.equal(gemini.params.find((param) => param.name === "reference_videos").kind, "url-list");
});

test("sync collects required clip trims with numeric bounds and a URL field", () => {
  const clips = models
    .find((model) => model.id.startsWith("google/nano"))
    .params.find((param) => param.name === "video_clips");
  assert.equal(clips.kind, "record-list");
  assert.equal(clips.required, true);
  assert.equal(clips.maxItems, 1);
  assert.equal(clips.fields.find((field) => field.name === "url").kind, "url");
  assert.equal(clips.fields.find((field) => field.name === "fps").max, 24);
});

test("studio uploader formats distinguish image slots from source video URLs", () => {
  assert.equal(
    classify("product_image", {
      type: "array",
      items: { type: "string", "x-format": "image" },
      maxItems: 1,
    }),
    "media-list",
  );
  assert.equal(
    classify("reference_video", { type: "array", items: { type: "string", "x-format": "video" } }),
    "url-list",
  );
});

test("a MIME image accept makes an uploader a media slot, not a URL box", () => {
  // Youchuan spells its style reference `x-accept: image/*` where the rest of
  // the catalogue lists extensions; the slot must still be fillable from the
  // reference picker.
  const youchuan = models.find((model) => model.id === "youchuan/v8.2/text-to-image");
  const sref = youchuan.params.find((param) => param.name === "sref");
  assert.equal(sref.kind, "media");
  assert.equal(sref.role, "image");
  assert.equal(sref.label, "Style reference");
  assert.equal(
    classify("sref", { type: "string", "x-accept": "image/*", "x-ui-component": "uploader" }),
    "media",
  );
  assert.equal(
    classify("file", { type: "string", "x-accept": ".pdf,.docx", "x-ui-component": "uploader" }),
    "string",
  );
});

/** One-parameter model through the real distiller, for shapes no fixture has. */
function distillOne(name, property) {
  const report = { skipped: [], pathMismatches: [] };
  const model = distill(
    { model: "vendor/example/text-to-image", type: "Image", categories: [], price: {} },
    { components: { schemas: { Input: { properties: { [name]: property } } } }, paths: {} },
    report,
  );
  return model.params.find((param) => param.name === name);
}

test("an enum default the vendor left out of its own list is kept as an option", () => {
  // GPT Image 2.5 Flare Edit: default 1024x1024, enum without it.
  const size = distillOne("size", {
    type: "string",
    default: "1024x1024",
    enum: ["auto", "1024x768", "768x1024"],
  });
  assert.deepEqual(size.options, ["1024x1024", "auto", "1024x768", "768x1024"]);
  assert.equal(size.default, "1024x1024");

  const listed = distillOne("size", { type: "string", default: "auto", enum: ["auto", "1:1"] });
  assert.deepEqual(listed.options, ["auto", "1:1"]);
});

test("a pixel size keeps the named values the vendor accepts in its place", () => {
  // MAI-Image-2.6: `default` and `auto` are legal alongside width*height.
  const size = distillOne("size", {
    type: "string",
    default: "default",
    description: "Image dimensions in width*height format (e.g., 1024*1024).",
    minimum: 768,
    maximum: 2346,
    totalMaximum: 2359296,
    "x-special-values": ["default", "auto"],
  });
  assert.equal(size.kind, "dimensions");
  assert.deepEqual(size.specialValues, ["default", "auto"]);
  assert.equal(size.minSide, 768);
  assert.equal(size.maxPixels, 2359296);
});

test("an image-upload hint is a picker slot, and its role comes from the name", () => {
  // FLUX 3 First/Last Frame: both frames were URL text boxes the picker never fills.
  const start = distillOne("start_image_url", {
    type: "string",
    format: "uri",
    "x-ui-component": "image-upload",
  });
  assert.equal(start.kind, "media");
  assert.equal(start.role, "start");
});

test("a switch the vendor says it cannot honour is not offered", () => {
  // LTX-2.3 Fast: "Audio generation is not supported on ltx-2-3-fast; keep this false".
  assert.equal(
    distillOne("generate_audio", {
      type: "boolean",
      default: false,
      description:
        "Audio generation is not supported on ltx-2-3-fast; keep this false (silent video).",
    }),
    undefined,
  );
  assert.equal(
    distillOne("generate_audio", {
      type: "boolean",
      default: true,
      description: "Whether to generate AI audio.",
    }).kind,
    "boolean",
  );
});

test("moderation switches are not offered, so the vendor's default applies", () => {
  assert.equal(distillOne("enable_safety_checker", { type: "boolean", default: true }), undefined);
  assert.equal(
    distillOne("safety_tolerance", { type: "integer", default: 2, minimum: 0, maximum: 5 }),
    undefined,
  );
  assert.equal(
    distillOne("moderation", { type: "string", enum: ["auto", "low"], default: "auto" }),
    undefined,
  );
});

test("a default of another type is not mixed into an enum", () => {
  const duration = distillOne("duration", { type: "integer", default: "5", enum: [5, 10] });
  assert.deepEqual(duration.options, [5, 10]);
});

test("an unpublished schema is skipped, a shipped model keeps its copy, a failure still refuses", () => {
  const entries = [
    { model: "a/new" },
    { model: "a/shipped" },
    { model: "a/ok" },
    { model: "a/flaky" },
  ];
  const shipped = { id: "a/shipped", params: [] };
  const report = { skipped: [], pathMismatches: [] };
  const result = partitionSchemaResults(
    entries,
    [{ status: 404 }, { status: 404 }, { schema: { ok: true } }, { status: 503 }],
    [shipped],
    report,
  );
  assert.deepEqual(
    result.schemas.map(({ entry }) => entry.model),
    ["a/ok"],
  );
  assert.deepEqual(result.carried, [shipped]);
  assert.equal(result.failures, 1);
  assert.equal(report.skipped.length, 2);
});

test("prompt reference dialects are read from the vendor's own wording", () => {
  const entry = (model) => ({ model, type: "Image", displayName: model, categories: [] });
  const schema = (description) => ({
    components: {
      schemas: {
        Input: {
          properties: {
            prompt: { type: "string", description },
            reference_images: { type: "array", items: { type: "string" }, maxItems: 4 },
          },
        },
      },
    },
  });
  const dialect = (model, description) =>
    distill(entry(model), schema(description), { skipped: [], pathMismatches: [] }).promptRefs;
  assert.equal(
    dialect("kling/x", "Reference inputs with @image_N, @video_N and @element_N."),
    "at-tag-underscore",
  );
  assert.equal(
    dialect("flux/x", "Refer to references by number: image 1 is the first entry."),
    "ordinal",
  );
  assert.equal(
    dialect("nano/x", 'Refer to multiple input images by their order (e.g., "the first image").'),
    "ordinal",
  );
  assert.equal(dialect("vidu/q4-preview/reference-to-video", "Refer to subjects."), "ordinal");
});

test("content-filter-free variants are left out, live or carried over", () => {
  const schema = {
    components: { schemas: { Input: { properties: { prompt: { type: "string" } } } } },
    paths: {},
  };
  for (const entry of [
    { model: "vendor/wan-9-spicy/image-to-video", type: "Video", categories: [] },
    {
      model: "vendor/x/image-to-video",
      displayName: "X Uncensored",
      type: "Video",
      categories: [],
    },
    { model: "vendor/y-NSFW/text-to-image", type: "Image", categories: [] },
  ]) {
    const report = { skipped: [], pathMismatches: [] };
    assert.equal(distill(entry, schema, report), null, entry.model);
    assert.equal(report.skipped.length, 1);
  }
  const kept = distill(
    { model: "vendor/wan-9/image-to-video", displayName: "Wan 9", type: "Video", categories: [] },
    schema,
    { skipped: [], pathMismatches: [] },
  );
  assert.equal(kept.id, "vendor/wan-9/image-to-video");
  assert.equal("uncensored" in kept, false);

  // A previous catalogue's copy is not carried over either.
  assert.equal(isExcludedModel({ id: "vendor/z/image-to-video", label: "Z Spicy" }), true);
  const report = { skipped: [], pathMismatches: [] };
  const result = partitionSchemaResults(
    [{ model: "vendor/wan-9-spicy/image-to-video" }],
    [{ status: 404 }],
    [{ id: "vendor/wan-9-spicy/image-to-video", params: [] }],
    report,
  );
  assert.deepEqual(result.carried, []);
});
