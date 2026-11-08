#!/usr/bin/env node
/**
 * Regenerates packages/shared/atlas-catalog.generated.ts from Atlas Cloud's
 * live catalogue.
 *
 * Atlas is not like fal, where four endpoints were transcribed by hand: it
 * aggregates 300+ image and video models whose inputs share almost nothing —
 * 131 distinct parameter names across the catalogue, with per-model enums,
 * defaults and bounds. Hand-maintaining that is not a thing a person can do
 * correctly twice.
 *
 * They publish enough to avoid it. `GET /api/v1/models` needs no key and
 * returns every model with a link to its own OpenAPI document, and those
 * documents carry the enums, defaults, ranges and even UI hints. So the
 * registry is distilled from them and committed, which keeps the property the
 * fal registry has and a runtime fetch would lose: the form and the Convex
 * validator read the same frozen object, and a model that changes shape shows
 * up as a reviewable diff rather than a production surprise.
 *
 *   node scripts/sync-atlas-catalog.mjs
 *
 * Writes nothing when the fetch fails — a half-written catalogue is worse than
 * a stale one.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CATALOG_URL = "https://api.atlascloud.ai/api/v1/models";
const OUTPUT = join(import.meta.dirname, "..", "packages", "shared", "atlas-catalog.generated.ts");

/** Concurrent schema fetches. 310 documents at 16 at a time is about 20s. */
const CONCURRENCY = 16;
const TIMEOUT_MS = 30_000;

/**
 * Variants the vendor markets as running without its usual content filter.
 * They are not offered in this app, so they never enter the catalogue — not as
 * live models and not as retired ones carried over from an older copy. Atlas
 * exposes no category for them, so the slug and display name are matched.
 */
const EXCLUDED_MODEL_PATTERN = /spicy|uncensored|nsfw/i;

/** True for a catalogue entry (`model`/`displayName`) or a distilled model (`id`/`label`) to leave out. */
export function isExcludedModel(model) {
  const text = [model.model, model.id, model.displayName, model.label].filter(Boolean).join(" ");
  return EXCLUDED_MODEL_PATTERN.test(text);
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    const error = new Error(`GET ${url} → HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return await response.json();
}

/**
 * Sorts the per-model schema fetches into what can be written.
 *
 * A 404 is Atlas listing a model whose document it has not published — on
 * 2026-10-24 four of its own tools (Relight, Shot Reframe, Video Extend,
 * Video Analysis) were listed that way. That is a permanent state, not a
 * transient failure, and refusing the whole sync over it froze every other
 * model at its last copy. So a 404 is reported and skipped, and a model that
 * was already shipped keeps its previous entry rather than vanishing from
 * saved generations. Anything else — a timeout, a 5xx — still refuses to
 * write: a partial catalogue reads as Atlas having removed models.
 */
export function partitionSchemaResults(entries, results, previousModels, report) {
  const previous = new Map(
    previousModels.filter((model) => !isExcludedModel(model)).map((model) => [model.id, model]),
  );
  const schemas = [];
  const carried = [];
  let failures = 0;
  entries.forEach((entry, index) => {
    const result = results[index];
    if (result?.schema) {
      schemas.push({ entry, schema: result.schema });
      return;
    }
    if (result?.status === 404) {
      const kept = previous.get(entry.model);
      if (kept) {
        carried.push(kept);
        report.skipped.push(`${entry.model}: schema no longer published, kept the previous copy`);
      } else {
        report.skipped.push(`${entry.model}: Atlas publishes no schema for it`);
      }
      return;
    }
    failures++;
  });
  return { schemas, carried, failures };
}

/** Runs `task` over `items` with a fixed number of workers, preserving order. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Parameters that carry media, by exact name.
 *
 * `x-ui-component` would be the honest signal, but the vendor only sets it on
 * about a third of them: `image` appears 84 times without a hint and `images`
 * 33. Falling through to "string" would render a file slot as a text box the
 * user is invited to paste a URL into, so the names are matched instead —
 * exactly, not by prefix, because `image_seed` is an integer and `audio_type`
 * is an enum and neither is a file.
 */
const MEDIA_NAMES = new Set([
  "image",
  "images",
  "image_url",
  "image_urls",
  "start_image",
  "first_image",
  "end_image",
  "last_image",
  "mask_image",
  "reference_images",
  "reference_image_urls",
  "video",
  "videos",
  "video_url",
  "video_urls",
  "reference_videos",
  "audio",
  "audio_url",
  "reference_audios",
]);

/** LoRA stacks. Optional on every model that has them, and they need a picker
 *  this form does not have, so they are carried as unsupported rather than
 *  rendered as raw JSON. */
const LORA_NAMES = new Set(["loras", "high_noise_loras", "low_noise_loras"]);

/** `image-upload` is FLUX 3 First/Last Frame's spelling for its two frame slots,
 *  which fell through to URL text boxes that attached references never fill. */
const UPLOAD_HINTS = new Set([
  "uploader",
  "uploaders",
  "image",
  "image-upload",
  "audio",
  "file-upload",
]);

/**
 * Free-text pixel dimensions, spelled `1024*1024`.
 *
 * 26 models take their output size this way rather than as an enum, and left as
 * a plain string that is exactly what the form drew: a text box containing
 * `1024*1024` for the user to edit by hand. Recognised here so the renderer can
 * offer aspect-ratio presets and keep the typing for when it is really wanted.
 *
 * Matched on evidence, not on the name alone: nvidia/cosmos-3-super also calls
 * its parameter `image_size` but wants preset words like `landscape_16_9`, and
 * turning that into a pixel picker would produce a value it rejects.
 */
const DIMENSION_NAMES = new Set(["size", "image_size"]);

function looksLikeDimensions(name, property) {
  if (!DIMENSION_NAMES.has(name) || property.type !== "string") return false;
  if (typeof property.default === "string" && /^\d+\s*\*\s*\d+$/.test(property.default)) {
    return true;
  }
  const description = String(property.description ?? "").toLowerCase();
  if (description.includes("width*height") || description.includes("width x height")) return true;
  // "Output resolution (512-2048px)" — a size with no example, on the two Qwen
  // edit endpoints, where an empty value means "keep the source resolution".
  if (/resolution\s*\(\d+\s*-\s*\d+\s*px\)/.test(description)) return true;
  // flux-kontext-dev states neither a default nor a format, only "the size of
  // the generated image" — the same parameter its siblings spell out.
  return /size of the generated (image|media)|output image size/.test(description);
}

/**
 * Bounds the vendor states in prose, because there is nowhere else to put them.
 *
 * None of these appear as `minimum`/`maximum` in the schema — the constraint is
 * written into the description and nothing machine-readable carries it. Reading
 * it here is what lets the custom fields refuse a size the model would reject,
 * rather than discovering it as an HTTP 400 after the click.
 */
function dimensionLimits(property) {
  const description = String(property.description ?? "");
  const limits = {};

  const range = description.match(/(\d+)\s*-\s*(\d+)\s*px/i);
  if (range) {
    limits.minSide = Number(range[1]);
    limits.maxSide = Number(range[2]);
  }

  const minimum = description.match(/minimum\s+(\d[\d,]*)/i);
  if (minimum) limits.minSide = Number(minimum[1].replace(/,/g, ""));

  const area = description.match(/must not exceed\s+([\d,]+)/i);
  if (area) limits.maxPixels = Number(area[1].replace(/,/g, ""));

  // An empty string is a real, documented value on the Qwen edit endpoints:
  // "leave empty for original resolution of the last image".
  if (/leave empty|omit to let/i.test(description)) limits.allowAuto = true;
  const sides = description.match(/(\d+)\*(\d+)[–-](\d+)\*(\d+)/);
  if (sides) {
    limits.minSide = Number(sides[1]);
    limits.maxSide = Number(sides[3]);
  }
  if (typeof property.minimum === "number") limits.minSide = property.minimum;
  if (typeof property.maximum === "number") limits.maxSide = property.maximum;
  if (typeof property.totalMaximum === "number") limits.maxPixels = property.totalMaximum;

  return limits;
}

function itemType(property) {
  return property.items?.type ?? (property.items?.$ref ? "object" : undefined);
}

/**
 * A mixed-media reference list whose wire items are `{ url, type }` objects.
 *
 * Wan 3.0 calls this field `refers`. Treating every object array as an opaque
 * complex value hid its reference endpoint from the generic image picker even
 * though the picker can fill the image subset exactly. Keep the recognition
 * structural so the next Atlas model using the same schema works too.
 */
function isTypedMediaList(property) {
  const item = property.items;
  if (property.type !== "array" || item?.type !== "object") return false;
  const kinds = item.properties?.type?.enum;
  return (
    item.properties?.url?.type === "string" &&
    Array.isArray(kinds) &&
    kinds.includes("image") &&
    kinds.every((kind) => kind === "image" || kind === "video" || kind === "audio")
  );
}

/** An uploader that explicitly accepts no image format cannot be filled by the
 * app's image-only reference picker. It stays a string so a public document
 * URL can still be pasted into models such as Wan 3.0. */
function isNonImageUpload(property) {
  const accept = String(property["x-accept"] ?? "").toLowerCase();
  if (!accept) return false;
  // Two spellings in the catalogue: a list of extensions (".jpg,.png") and a
  // MIME pattern ("image/*"). Youchuan's `sref` uses the latter, and matching
  // only extensions rendered its style-reference slot as a text box asking for
  // a public https URL — which the reference picker can never produce.
  if (/(?:^|[,\s])image\//.test(accept)) return false;
  return !/\.(?:jpe?g|png|bmp|webp|gif|heic|heif|tiff?)\b/.test(accept);
}

/**
 * Which shape a schema property is.
 *
 * "complex" is the escape hatch: a handful of models take structured arrays —
 * Vidu's `subjects`, Gemini's `video_clips`, MiniMax's `refers` — that are
 * objects with their own fields, not something a generic control can collect.
 * Marking them keeps the model usable when they are optional and lets the
 * caller drop the model when they are not, instead of building a request the
 * vendor rejects.
 */
export function classify(rawName, property) {
  // Lower-cased before every lookup: `atlascloud/face-swap-image` names its
  // required target image `Image`, which fell through to "string" and rendered
  // a file slot as a text box — so every submission sent `"Image": ""` and was
  // rejected. One model today, and exactly the kind of thing a vendor adds
  // again next month.
  const name = rawName.toLowerCase();
  const ui = property["x-ui-component"];
  if (ui === "loras" || LORA_NAMES.has(name)) return "loras";
  if (Array.isArray(property.enum) && property.enum.length > 0) return "enum";

  const format = property["x-format"] ?? property.items?.["x-format"];
  if (format === "image") return property.type === "array" ? "media-list" : "media";
  if (format === "video" || format === "audio")
    return property.type === "array" ? "url-list" : "url";
  if (property.type === "array") {
    if (name === "images" && property.items?.properties?.image?.type === "string")
      return "image-record-list";
    if (name === "subjects" && property.items?.properties?.images?.type === "array")
      return "image-record-list";
    if (name === "video_clips" || name === "multi_prompt" || name === "elements")
      return "record-list";
    if (isTypedMediaList(property)) return "typed-media-list";
    // Objects stay complex even under a media name: Pixverse's `images` is a
    // list of {url, …} records, not a list of URLs.
    if (itemType(property) === "object") return "complex";
    // Arrays of plain strings: media when the name says so, otherwise a text
    // list — `prompt` is an array on four models.
    return MEDIA_NAMES.has(name) || ui === "uploaders" ? "media-list" : "string-list";
  }

  if (MEDIA_NAMES.has(name) && property.type === "string") return "media";
  if (UPLOAD_HINTS.has(ui)) return isNonImageUpload(property) ? "string" : "media";
  if (looksLikeDimensions(name, property)) return "dimensions";

  if (property.type === "boolean") return "boolean";
  if (property.type === "integer") return "integer";
  if (property.type === "number") return "number";
  if (property.type === "object") return "complex";
  return "string";
}

/**
 * Which media slot a parameter fills, so the form can label the thumbnails.
 * Atlas has no field for this; the names are the only signal, and they are
 * consistent enough across the catalogue to key on.
 */
function mediaRole(rawName) {
  const name = rawName.toLowerCase();
  if (/^(end|last)_?(image|frame)/.test(name)) return "end";
  if (/^(start|first)_?(image|frame)/.test(name)) return "start";
  if (/video/.test(name)) return "video";
  if (/audio/.test(name)) return "audio";
  return "image";
}

/**
 * Names whose humanised form says nothing. `sref` is Midjourney's own shorthand
 * for a style reference, and "Sref" on a thumbnail badge tells nobody what the
 * slot does.
 */
const LABEL_OVERRIDES = new Map([["sref", "Style reference"]]);

function humanize(name) {
  const override = LABEL_OVERRIDES.get(name.toLowerCase());
  if (override) return override;
  return name
    .split("_")
    .map((word) => (word.length <= 3 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * Trims a property down to what the form and the payload builder need.
 *
 * `enable_base64_output` and `enable_sync_mode` are dropped rather than
 * rendered: both change the transport, not the output, and this integration
 * always wants URLs from the async queue. Offering them would let a click
 * return a 40MB base64 blob into a Convex action.
 */
const TRANSPORT_ONLY = new Set(["enable_base64_output", "enable_sync_mode", "model"]);

/**
 * Switches that loosen or disable a vendor's content moderation.
 *
 * Not offered: the form never renders them and the payload never sends them,
 * so every request runs at the vendor's own default. A model that marks one of
 * them required keeps it, because leaving it out would fail every submission.
 */
const SAFETY_CONTROLS = new Set(["enable_safety_checker", "safety_tolerance", "moderation"]);

const MIXED_REFERENCE_LIMITS = new Map([
  ["alibaba/wan-3.0/reference-to-video", { image: 10, video: 5, audio: 5 }],
  ["alibaba/wan-3.0-prime/reference-to-video", { image: 10, video: 5, audio: 5 }],
]);

/**
 * A switch the vendor declares and then says it cannot honour.
 *
 * LTX-2.3 Fast lists `generate_audio` with "Audio generation is not supported
 * on ltx-2-3-fast; keep this false". Rendered, it is a toggle whose only other
 * position is a rejected request — and model switches carry booleans by name,
 * so coming from LTX-2.3 Pro (audio on by default) would arrive switched on.
 * Leaving it out sends nothing, which is the documented default.
 */
function isUnsupportedSwitch(property) {
  return (
    property.type === "boolean" &&
    property.default === false &&
    /\bnot supported\b[^.]*\bkeep (?:this|it) false\b/i.test(String(property.description ?? ""))
  );
}

function distillParam(modelId, name, property, required) {
  if (TRANSPORT_ONLY.has(name)) return null;
  if (!required && SAFETY_CONTROLS.has(name)) return null;
  if (!required && isUnsupportedSwitch(property)) return null;
  const kind = classify(name, property);
  const param = {
    name,
    kind,
    label: humanize(name),
    required,
  };
  if (property.description) param.description = property.description;
  // Uncollectable kinds carry structured defaults — a LoRA's {path, scale}, a
  // subject record — that nothing reads and that would not fit AtlasParamValue.
  // The parameter is still declared so the form can say it is unavailable.
  if (property.default !== undefined && kind !== "loras" && kind !== "complex") {
    param.default = property.default;
  }
  if (
    name === "seed" &&
    param.default === undefined &&
    /-1 means (?:a )?random seed/i.test(String(property.description ?? ""))
  ) {
    param.default = -1;
    param.min = -1;
  }
  const textLimit = String(property.description ?? "").match(/up to\s+(\d+)\s+characters/i);
  if (textLimit && (kind === "string" || kind === "string-list")) {
    param.maxLength = Number(textLimit[1]);
  }
  if (kind === "enum") {
    param.options = property.enum;
    // GPT Image 2.5 Flare Edit documents `1024x1024` as its default and omits
    // it from its own enum, while the description and every sibling list it as
    // a standard size. Left as is, the select renders with nothing chosen and
    // any carried-over size falls back to a value the options do not show. The
    // default is the documented half of that contradiction, so it is kept.
    if (
      param.default !== undefined &&
      param.default !== null &&
      param.options.every((option) => typeof option === typeof param.default) &&
      !param.options.includes(param.default)
    ) {
      param.options = [param.default, ...param.options];
    }
  }
  if (kind === "media" || kind === "media-list" || kind === "typed-media-list") {
    param.role = mediaRole(name);
  }
  // The reference picker produces images and nothing else — every blob it
  // stores is a JPEG. A `video` or `audio` slot filled from it would put an
  // image URL in a field the vendor reads as a clip or a track, and
  // assertRequired would wave it through because the arity matched.
  if (param.role === "video" || param.role === "audio") {
    param.kind = property.type === "array" ? "url-list" : "url";
  }
  if (kind === "url" || kind === "url-list") param.role = mediaRole(name);
  if (kind === "record-list" || kind === "image-record-list") {
    const properties = property.items.properties;
    const imageField =
      kind === "image-record-list" ? (properties.image ? "image" : "images") : undefined;
    if (imageField) {
      param.imageField = imageField;
      param.imageFieldArray = properties[imageField].type === "array";
      param.description = [property.description, properties[imageField].description]
        .filter(Boolean)
        .join(" ");
    }
    param.fields = Object.entries(properties)
      .filter(([field]) => field !== imageField)
      .map(([field, spec]) => {
        const child = distillParam(
          modelId,
          field,
          spec,
          (property.items.required ?? []).includes(field),
        );
        if (["url", "frontal_image"].includes(field)) child.kind = "url";
        if (["refer_images", "refer_videos"].includes(field)) child.kind = "url-list";
        return child;
      });
  }
  if (typeof property.minItems === "number") param.minItems = property.minItems;
  if (typeof property.maxItems === "number") param.maxItems = property.maxItems;
  if (typeof property.maxLength === "number") param.maxLength = property.maxLength;
  if (property.format === "uri" && kind === "string") param.kind = "url";
  if (name === "user_prompt") {
    param.name = "prompt";
    param.wireName = name;
    param.label = "Prompt";
  }
  if (typeof property.minimum === "number") param.min = property.minimum;
  if (typeof property.maximum === "number") param.max = property.maximum;
  if (
    (param.kind === "media-list" || param.kind === "typed-media-list") &&
    typeof property.maxItems === "number"
  ) {
    param.maxItems = property.maxItems;
  }
  if (param.kind === "typed-media-list") {
    const kinds = property.items.properties.type.enum;
    if (kinds.includes("video")) param.maxVideoItems = property.maxItems ?? 9;
    if (kinds.includes("audio")) param.maxAudioItems = property.maxItems ?? 9;
    const limits = MIXED_REFERENCE_LIMITS.get(modelId);
    if (limits) {
      param.maxImageItems = limits.image;
      param.maxVideoItems = limits.video;
      param.maxAudioItems = limits.audio;
    }
  }
  if (kind === "dimensions") {
    Object.assign(param, dimensionLimits(property));
    // MAI-Image-2.6 takes a size *or* one of the words `default` and `auto`
    // ("the model selects the output aspect ratio"), and its default is the
    // word. A pixel picker that only knows `W*H` turned both into 1024*1024.
    const special = property["x-special-values"];
    if (Array.isArray(special)) {
      const words = special.filter((value) => typeof value === "string" && value.trim() !== "");
      if (words.length > 0) param.specialValues = words;
    }
  }
  if (property["x-ui-component"] === "slider") param.slider = true;
  if (property["x-ui-component"] === "textarea") param.multiline = true;
  return param;
}

const VIDEO_SUBMIT_PATH = "/api/v1/model/generateVideo";
const IMAGE_SUBMIT_PATH = "/api/v1/model/generateImage";
const DEFAULT_POLL_PATH = "/api/v1/model/prediction/{request_id}";

/**
 * Where to poll this model's prediction.
 *
 * Two spellings are in use across the catalogue — `/model/prediction/{id}` on
 * 155 models and `/model/result/{id}` on 152 — so it has to be read per model
 * rather than assumed. One ships `/model/prediction{request_id}` with the
 * separator missing, which would poll a URL that 404s forever and read as a
 * hung job rather than a typo, so it is repaired here.
 */
function readPollPath(schema) {
  for (const [path, methods] of Object.entries(schema.paths ?? {})) {
    if (!methods.get) continue;
    return path.includes("/{request_id}") ? path : path.replace("{request_id}", "/{request_id}");
  }
  return DEFAULT_POLL_PATH;
}

/**
 * The submit path is derived from the catalogue's media type, not from the
 * schema's own POST path.
 *
 * Those two disagree on 24 of 310 models — Happy Horse's three video endpoints
 * claim `generateImage`, Seedream 5 Pro's two image endpoints claim
 * `generateVideo` — in a pattern that tracks the model family rather than
 * anything about the request, which makes it a template bug in their schema
 * generator rather than 24 genuine exceptions. The vendor's own written
 * documentation for a video model shows `generateVideo`, and `type` is what
 * their console groups by, so `type` wins and the disagreements are reported.
 */
function submitPathFor(entry) {
  return entry.type === "Video" ? VIDEO_SUBMIT_PATH : IMAGE_SUBMIT_PATH;
}

const THREE_D_CATEGORIES = new Set(["IMAGE-TO-3D", "TEXT-TO-3D"]);

/**
 * How this model expects the prompt to point at its reference images.
 *
 * Three dialects are in use across the catalogue and they are not
 * interchangeable — sending one model's spelling to another puts literal junk
 * in the prompt and is charged for:
 *
 *   ordinal  Seedance 2.0: "References like 'image 1', 'video 1' refer to
 *            inputs in order." Prose, no marker.
 *   ordinal-title  Wan 3.0: English prompts refer to ordered images as
 *            "Image 1", "Image 2", ... . Prose, no marker.
 *   at-tag-optional  Seedance 2.5: "Cite reference inputs in submission order
 *            with @-syntax: @Image1…". The marker is available, not required —
 *            the vendor's own example prompt is prose — so tags pass through
 *            verbatim and an untagged prompt still submits.
 *   none     The model documents no way to address one image from its list in
 *            the prompt.
 *
 * Read from the vendor's own description rather than assumed from the presence
 * of a list slot, because "none" is the majority case and guessing it wrong is
 * the expensive direction. A small override table covers models whose compact
 * schema omits a dialect Atlas documents elsewhere.
 */
const PROMPT_REFERENCE_DIALECT_OVERRIDES = new Map([
  // The schema only says "positive prompt", but Atlas's Seedream Pro prompt
  // library addresses inputs as "Image 1", "Image 2", ... . ArtSnack keeps
  // @imageN as editor sugar and translates it to those ordinals at submission.
  ["bytedance/seedream-v5.0-pro/edit", "ordinal"],
  // Atlas's compact schemas expose `refers` but omit Alibaba's documented
  // title-cased ordinal prompt syntax.
  ["alibaba/wan-3.0/reference-to-video", "ordinal-title"],
  ["alibaba/wan-3.0-prime/reference-to-video", "ordinal-title"],
  // "Refer to subjects from the reference images", and Vidu's own example
  // prompt names them by position: "the woman from the first image". There is
  // no marker syntax, so tags become the ordinals the prose already uses.
  ["vidu/q4-preview/reference-to-video", "ordinal"],
]);

function promptReferenceDialect(modelId, input) {
  const override = PROMPT_REFERENCE_DIALECT_OVERRIDES.get(modelId);
  if (override) return override;

  const prompt = String(input.properties?.prompt?.description ?? "");
  if (/<IMAGE_REF_/i.test(prompt)) return "image-ref-zero";
  if (/<IMAGE_/i.test(prompt)) return "image-zero";
  if (/character1/.test(prompt)) return "character";
  if (modelId.startsWith("pixverse/") && input.properties?.images?.items?.properties?.ref_name)
    return "named-reference";
  if (modelId.startsWith("vidu/") && input.properties?.subjects) return "subject";
  if (/@Image1/.test(prompt)) return "at-tag-title";
  // Kling 4.0: "Reference inputs with @image_N, @video_N, @element_N".
  if (/@image_(?:N|\d)/.test(prompt)) return "at-tag-underscore";
  if (/@\s?image\s?n|@image\d/i.test(prompt)) return "at-tag-optional";
  if (/refer to inputs in order|references like/i.test(prompt)) return "ordinal";
  // FLUX 3 Edit: "Refer to references by number: image 1 is the first entry";
  // Nano Banana 2.1: "Refer to multiple input images by their order".
  if (/refer to (?:references|multiple input images) by (?:number|their order)/i.test(prompt))
    return "ordinal";
  return "none";
}

export function distill(entry, schema, report) {
  if (isExcludedModel(entry)) {
    report.skipped.push(`${entry.model}: content-filter-free variant, not offered`);
    return null;
  }

  // Atlas files its 3D generators under type "Image". They return .glb meshes,
  // which the gallery cannot render and contentTypeFor would mislabel as PNG —
  // a paid job that lands as a broken tile.
  if ((entry.categories ?? []).some((category) => THREE_D_CATEGORIES.has(category))) {
    report.skipped.push(`${entry.model}: 3D output, which this app cannot display`);
    return null;
  }

  const input = schema.components?.schemas?.Input;
  if (!input?.properties) {
    report.skipped.push(`${entry.model}: schema declares no Input properties`);
    return null;
  }

  const required = new Set(input.required ?? []);
  const order = (input["x-order-properties"] ?? Object.keys(input.properties)).filter(
    (name) => !TRANSPORT_ONLY.has(name) && input.properties[name],
  );
  // Anything the vendor left out of x-order-properties still has to render;
  // several models omit half their inputs from it.
  for (const name of Object.keys(input.properties)) {
    if (!TRANSPORT_ONLY.has(name) && !order.includes(name)) order.push(name);
  }

  const params = order
    .map((name) => distillParam(entry.model, name, input.properties[name], required.has(name)))
    .filter(Boolean);

  // A required parameter this form cannot collect makes the model unusable:
  // every submission would be rejected. Better to leave it out of the picker
  // and say so than to ship a row that always fails.
  const blocking = params.filter(
    (param) => param.required && (param.kind === "complex" || param.kind === "loras"),
  );
  if (blocking.length > 0) {
    report.skipped.push(
      `${entry.model}: requires ${blocking.map((param) => `${param.name} (${param.kind})`).join(", ")}`,
    );
    return null;
  }

  const schemaPost = Object.entries(schema.paths ?? {}).find(([, methods]) => methods.post)?.[0];
  const submitPath = submitPathFor(entry);
  if (schemaPost && schemaPost !== submitPath) {
    report.pathMismatches.push(`${entry.model}: schema says ${schemaPost}, using ${submitPath}`);
  }

  const price = Number(entry.price?.actual?.base_price);
  const listPrice = Number(entry.price?.origin?.base_price);
  // Atlas discounts about 40% of the catalogue. `actual` is what we are charged
  // today; `origin` is what it reverts to when the promotion lapses, at which
  // point every quote for that model is silently low until someone re-syncs.
  // Recording both makes the gap visible in the committed diff.
  const discounted = Number.isFinite(listPrice) && listPrice > price;

  return {
    id: entry.model,
    label: entry.displayName || entry.model,
    media: entry.type === "Video" ? "video" : "image",
    submitPath,
    pollPath: readPollPath(schema),
    family: entry.familyDisplayName || entry.familyName || "",
    organization: entry.organization || "",
    categories: entry.categories ?? [],
    promptRefs: promptReferenceDialect(entry.model, input),
    basePrice: Number.isFinite(price) && price > 0 ? price : null,
    ...(discounted ? { listPrice } : {}),
    params,
  };
}

/** Stable, diff-friendly output. Key order comes from distill(), models from the sort. */
function serialize(models) {
  return JSON.stringify(models, null, 2);
}

async function main() {
  const snapshotDir = process.env.ATLAS_SNAPSHOT_DIR;
  const cachedSchemas = snapshotDir
    ? JSON.parse(readFileSync(join(snapshotDir, "schemas.json"), "utf8"))
    : null;
  const { ATLAS_CATALOG: previousModels } = await import(pathToFileURL(OUTPUT).href);
  process.stderr.write(`Fetching ${CATALOG_URL}\n`);
  const catalog = snapshotDir
    ? JSON.parse(readFileSync(join(snapshotDir, "catalog.json"), "utf8"))
    : await fetchJson(CATALOG_URL);
  const entries = (catalog.data ?? []).filter(
    (entry) => entry.type === "Image" || entry.type === "Video",
  );
  if (entries.length === 0) throw new Error("catalogue returned no image or video models");
  process.stderr.write(`${entries.length} media models; fetching schemas…\n`);

  const results = await mapLimit(entries, CONCURRENCY, async (entry) => {
    try {
      if (!entry.schema) throw new Error("Missing schema URL");
      const schema = cachedSchemas ? cachedSchemas[entry.model] : await fetchJson(entry.schema);
      if (!schema) throw new Error("Missing cached schema");
      return { schema };
    } catch (error) {
      process.stderr.write(`  ! ${entry.model}: ${error.message}\n`);
      return { status: error.status };
    }
  });

  const report = { skipped: [], pathMismatches: [] };
  const { schemas, carried, failures } = partitionSchemaResults(
    entries,
    results,
    previousModels,
    report,
  );
  const models = schemas
    .map(({ entry, schema }) => distill(entry, schema, report))
    .filter(Boolean)
    .concat(carried)
    .sort((a, b) => a.id.localeCompare(b.id));

  if (models.length === 0) throw new Error("no model survived distillation — refusing to write");
  // A partial catalogue silently drops models from the picker, which looks
  // like Atlas removed them. Loud, and the old file stays put.
  if (failures > 0) {
    throw new Error(`${failures} of ${entries.length} schemas failed to fetch — refusing to write`);
  }

  const liveIds = new Set(entries.map((entry) => entry.model));
  const retired = previousModels
    .filter((model) => !liveIds.has(model.id) && !isExcludedModel(model))
    .map((model) => ({ ...model, retired: true }));
  models.push(...retired);
  models.sort((a, b) => a.id.localeCompare(b.id));
  const videos = models.filter((model) => model.media === "video").length;

  const overrides =
    report.pathMismatches.length > 0
      ? ` *\n * ${report.pathMismatches.length} of these declare a POST path that contradicts their own\n` +
        ` * catalogue type; see submitPathFor. The type wins. Overridden:\n` +
        report.pathMismatches.map((line) => ` *   - ${line.split(":")[0]}`).join("\n") +
        "\n"
      : "";

  const banner = `/**
 * Atlas Cloud's image and video catalogue, distilled from their published
 * OpenAPI documents.
 *
 * GENERATED FILE — do not edit. Run \`bun run atlas:sync\` to refresh it.
 *
 * ${models.length} models (${videos} video, ${models.length - videos} image).
 * ${retired.length} historical endpoints are retained for saved generations but hidden from the picker.
 * ${report.skipped.length} were left out — run the script to see each one and why.
${overrides} */

import type { AtlasModel } from "./atlas-models";

export const ATLAS_CATALOG: readonly AtlasModel[] = ${serialize(models)};
`;

  writeFileSync(OUTPUT, banner);
  process.stderr.write(
    `Wrote ${OUTPUT}\n  ${models.length} models kept, ${failures} schema fetches failed\n`,
  );

  // Everything dropped is named. A catalogue that silently loses models reads
  // as "Atlas removed them" the next time someone goes looking.
  if (report.skipped.length > 0) {
    process.stderr.write(`\n  ${report.skipped.length} models left out:\n`);
    for (const line of report.skipped) process.stderr.write(`    - ${line}\n`);
  }
  if (report.pathMismatches.length > 0) {
    process.stderr.write(
      `\n  ${report.pathMismatches.length} schemas disagree with their catalogue type ` +
        `(see submitPathFor):\n`,
    );
    for (const line of report.pathMismatches) process.stderr.write(`    - ${line}\n`);
  }
}

if (import.meta.main)
  main().catch((error) => {
    process.stderr.write(`atlas:sync failed — ${error.message}\n`);
    process.exit(1);
  });
