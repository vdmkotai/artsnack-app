/**
 * Turns a form's parameter bag into an Atlas Cloud request body.
 *
 * The whole point of the generated catalogue is that this function never learns
 * a model's name. It walks the model's declared parameters, takes the value the
 * form collected for each, and drops anything the model did not declare —
 * Atlas rejects unknown properties, so a leftover `bitrate_mode` carried over
 * from Seedance would fail a Wan request that is otherwise fine.
 */

import {
  defaultAtlasRecord,
  readAtlasRecords,
  validateAtlasRecord,
  validateAtlasUrl,
} from "./atlas-records";
import {
  getGrokReferenceTagIndices,
  stripReferenceTags,
  toGrokApiPrompt,
  toTitleCaseOrdinalApiPrompt,
} from "./grok-prompt";
import {
  ATLAS_PROMPT_PARAM,
  atlasMediaParams,
  atlasPromptValue,
  atlasScalarParams,
  clampAtlasValue,
  getAtlasModel,
  type AtlasModel,
  type AtlasParam,
  type AtlasParamValue,
} from "./atlas-models";
import { TENCENT_UPSCALER, tencentSizing } from "./tencent-upscale";
import { midjourneyFlagParams, midjourneyFlagSuffix } from "./midjourney-flags";

/**
 * Renders the editor's `@imageN` tags in the dialect this model reads.
 *
 * The editor has one spelling and the vendors have three, so the translation
 * happens here, once, at the boundary — the same place buildSeedanceRequest
 * does it for fal. Getting it wrong is not a silent no-op: an untranslated tag
 * is nine literal characters inside a paid prompt.
 */
export function renderAtlasPrompt(model: AtlasModel, prompt: string): string {
  switch (model.promptRefs) {
    case "image-ref-zero":
      return prompt.replace(/@image\s?(\d+)\b/gi, (_, n) => `<IMAGE_REF_${Number(n) - 1}>`);
    case "image-zero":
      return prompt.replace(/@image\s?(\d+)\b/gi, (_, n) => `<IMAGE_${Number(n) - 1}>`);
    case "character":
      return prompt.replace(/@image\s?(\d+)\b/gi, (_, n) => `character${n}`);
    case "named-reference":
      return prompt.replace(/@image\s?(\d+)\b/gi, (_, n) => `@reference${n}`);
    case "subject":
      return prompt.replace(/@image\s?(\d+)\b/gi, (_, n) => `@subject${n}`);
    case "at-tag-title":
      return prompt.replace(/@image\s?(\d+)\b/gi, (_, n) => `@Image${n}`);
    case "at-tag-underscore":
      // Kling 4.0: "Reference inputs with @image_N, @video_N". Its videos are
      // URL fields the user tags by hand, so only the image tags move.
      return prompt.replace(/@image\s?(\d+)\b/gi, (_, n) => `@image_${n}`);
    case "ordinal":
      // Seedance: "References like 'image 1' refer to inputs in order."
      return toGrokApiPrompt(prompt);
    case "ordinal-title":
      // Wan 3.0: English prompts name ordered references as "Image 1".
      return toTitleCaseOrdinalApiPrompt(prompt);
    case "at-tag-optional":
      // Seedance 2.5 reads `@imageN` wherever it appears — no subject binding,
      // no requirement to tag at all — so the editor's spelling already is the
      // vendor's and passes through untouched.
      return prompt;
    case "none":
      // Nothing here reads them, so leaving them in would put `@image1` in the
      // prompt as prose. Stripped rather than sent.
      return stripReferenceTags(prompt);
  }
}

export type AtlasRequest = {
  submitPath: string;
  pollPath: string;
  body: Record<string, unknown>;
};

export class AtlasPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtlasPayloadError";
  }
}

/**
 * Whether a value is worth sending.
 *
 * An optional string left blank is omitted rather than sent as `""`: several
 * models treat an empty `negative_prompt` as a literal instruction to avoid
 * nothing, and at least one rejects the empty string outright. Required fields
 * are never dropped here — they are validated instead.
 */
function isEmpty(value: AtlasParamValue): boolean {
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Distributes reference URLs across the model's media slots, in declaration
 * order.
 *
 * Single slots take one URL each and a list slot takes everything left, which
 * matches how the models are actually shaped: `image` then `end_image` on a
 * first/last-frame model, a lone `images` on a reference-to-video one. The
 * order is the schema's, so the badge the form draws on a thumbnail is the slot
 * the URL really fills.
 *
 * One exception: a frame model whose closing frame comes after a list of
 * middle frames — Kling 4.0's `image`, `middle_images`, `last_image`. Filled
 * in order, two images would become a first and a middle keyframe and the last
 * frame would never be set, so the last image goes to the closing slot and the
 * ones between become the middle frames.
 */
export function assignAtlasMedia(
  model: AtlasModel,
  referenceUrls: readonly string[],
  params: Record<string, AtlasParamValue> = {},
): { values: Record<string, unknown>; used: number } {
  const values: Record<string, unknown> = {};
  let cursor = 0;

  const slots = atlasMediaParams(model);
  const closing = slots.at(-1);
  if (
    closing?.kind === "media" &&
    closing.role === "end" &&
    slots[0]?.kind === "media" &&
    slots.some((param) => param.kind === "media-list") &&
    referenceUrls.length >= 2
  ) {
    values[closing.name] = referenceUrls.at(-1);
    const rest = assignAtlasMedia(
      { ...model, params: model.params.filter((param) => param !== closing) },
      referenceUrls.slice(0, -1),
      params,
    );
    return { values: { ...rest.values, ...values }, used: rest.used + 1 };
  }

  for (const param of slots) {
    if (cursor >= referenceUrls.length) break;
    const capacity = param.maxImageItems ?? param.maxItems ?? 9;
    if (param.kind === "image-record-list") {
      const details = readAtlasRecords(params[`${param.name}_details`]);
      const urls = referenceUrls.slice(cursor, cursor + capacity);
      const records = urls.map((url, index) => ({
        ...validateAtlasRecord(
          param,
          { ...defaultAtlasRecord(param, index), ...details[index] },
          index,
        ),
        [param.imageField!]: param.imageFieldArray ? [url] : url,
      }));
      if (param.imageFieldArray) {
        const groups = new Map<string, Record<string, unknown>>();
        for (const record of records) {
          const id = String(record.id);
          const existing = groups.get(id);
          if (existing) {
            const images = existing[param.imageField!] as string[];
            images.push(...(record[param.imageField!] as string[]));
            if (images.length > 3)
              throw new AtlasPayloadError("Each subject supports at most three images.");
          } else groups.set(id, record);
        }
        values[param.name] = [...groups.values()];
      } else {
        if (
          model.promptRefs === "named-reference" &&
          new Set(records.map((row) => row.ref_name)).size !== records.length
        )
          throw new AtlasPayloadError("Each reference needs a unique name.");
        values[param.name] = records;
      }
      cursor += urls.length;
    } else if (param.kind === "typed-media-list") {
      values[param.name] = referenceUrls
        .slice(cursor, cursor + capacity)
        .map((url) => ({ url, type: "image" }));
      cursor += (values[param.name] as unknown[]).length;
    } else if (param.kind === "media-list") {
      values[param.name] = referenceUrls.slice(cursor, cursor + capacity);
      cursor += (values[param.name] as unknown[]).length;
    } else {
      values[param.name] = referenceUrls[cursor];
      cursor += 1;
    }
  }

  return { values, used: cursor };
}

export function buildAtlasRequest(options: {
  model: string;
  /** Scalar values as collected by the form. Clamped again here — the form is
   *  not the only caller, and a stored record can predate a schema change. */
  params: Record<string, AtlasParamValue>;
  /** Public URLs for attached references, in the order the user arranged them. */
  referenceUrls?: readonly string[];
}): AtlasRequest {
  const model = getAtlasModel(options.model);
  const body: Record<string, unknown> = { model: model.id };

  const media = assignAtlasMedia(model, options.referenceUrls ?? [], options.params);
  Object.assign(body, media.values);
  assertReferenceTagsInRange(model, options.params.prompt, media.used);

  for (const param of atlasScalarParams(model)) {
    if (param.virtual || param.kind === "image-record-list") continue;
    // A missing prompt is an empty one. Clamping `undefined` would substitute
    // the schema default, which on Atlas is the vendor's documentation example
    // — sent and billed whenever an optional prompt was left blank, because
    // Convex only stores the prompt when there is one (see ATLAS_PROMPT_PARAM).
    const raw =
      param.name === ATLAS_PROMPT_PARAM
        ? (options.params[param.name] ?? atlasPromptValue(model, ""))
        : options.params[param.name];
    let value = clampAtlasValue(param, raw);
    // The one value that is not passed through verbatim: the editor writes
    // `@imageN` and each model reads a different dialect of it, or none.
    if (param.name === "prompt") {
      if (["subject", "named-reference"].includes(model.promptRefs) && typeof value === "string") {
        const param = atlasMediaParams(model).find((entry) => entry.kind === "image-record-list")!;
        const details = readAtlasRecords(options.params[`${param.name}_details`]);
        value = value.replace(/@image\s?(\d+)\b/gi, (_, n) => {
          const index = Number(n) - 1;
          const row = { ...defaultAtlasRecord(param, index), ...details[index] };
          const name = model.promptRefs === "subject" ? row.id : row.ref_name || `reference${n}`;
          return `@${name}${model.promptRefs === "named-reference" ? " " : ""}`;
        });
      } else value = renderPrompt(model, value);
    }
    if (param.kind === "record-list") {
      const rows = readAtlasRecords(value);
      if (rows.length)
        body[param.name] = rows.map((row, index) => validateAtlasRecord(param, row, index));
      continue;
    }
    if (param.kind === "url" && value !== "") validateAtlasUrl(value, param.label);
    if (param.kind === "url-list" && Array.isArray(value))
      value.forEach((url) => validateAtlasUrl(url, param.label));
    if (!param.required && isEmpty(value)) continue;
    body[param.wireName ?? param.name] = value;
  }

  appendTypedMediaUrls(model, body, options.params);

  if (model.id === TENCENT_UPSCALER) {
    const sizing = tencentSizing(body as Record<string, AtlasParamValue>);
    for (const key of ["mode", "percent", "width", "height", "long_side", "short_side"])
      delete body[key];
    Object.assign(body, sizing);
    if (body.mode !== "percent" && Object.keys(sizing).length === 1) {
      throw new AtlasPayloadError("Choose an output size for the Tencent upscaler.");
    }
  }

  assertRequired(model, body);
  assertTextLimits(model, body);
  assertInputRelationships(model, body);
  for (const param of model.params) {
    const value = body[param.wireName ?? param.name];
    if (
      Array.isArray(value) &&
      ((param.maxItems !== undefined && value.length > param.maxItems) ||
        (param.minItems !== undefined && value.length < param.minItems))
    ) {
      throw new AtlasPayloadError(
        `${param.label} needs ${param.minItems ?? 0}–${param.maxItems ?? "more"} entries`,
      );
    }
  }
  if (media.used < (options.referenceUrls?.length ?? 0))
    throw new AtlasPayloadError("Too many reference images for this model");
  appendMidjourneyFlags(model, body, options.params);
  return { submitPath: model.submitPath, pollPath: model.pollPath, body };
}

/**
 * Folds the app-only `mj_*` controls into the prompt as Midjourney flags.
 *
 * After the length check on purpose: the vendor says flags are not counted
 * toward the 1024-character limit, so a prompt at the limit plus `--raw` is
 * legal, and refusing it here would be stricter than the model.
 */
function appendMidjourneyFlags(
  model: AtlasModel,
  body: Record<string, unknown>,
  params: Record<string, AtlasParamValue>,
): void {
  if (typeof body.prompt !== "string") return;
  const values: Record<string, AtlasParamValue> = {};
  for (const param of midjourneyFlagParams(model)) {
    values[param.name] = clampAtlasValue(param, params[param.name]);
  }
  const suffix = midjourneyFlagSuffix(model, values, {
    prompt: body.prompt,
    hasStyleReference: typeof body.sref === "string" && body.sref.length > 0,
  });
  if (suffix) body.prompt = `${body.prompt}${suffix}`;
}

function assertTextLimits(model: AtlasModel, body: Record<string, unknown>): void {
  for (const param of model.params) {
    if (!param.maxLength) continue;
    const value = body[param.name];
    const tooLong =
      (typeof value === "string" && value.length > param.maxLength) ||
      (Array.isArray(value) &&
        value.some((entry) => typeof entry === "string" && entry.length > param.maxLength!));
    if (tooLong) {
      throw new AtlasPayloadError(
        `${model.label} accepts at most ${param.maxLength} characters in ${param.label}.`,
      );
    }
  }
}

function appendTypedMediaUrls(
  model: AtlasModel,
  body: Record<string, unknown>,
  params: Record<string, AtlasParamValue>,
): void {
  const target = model.params.find((param) => param.kind === "typed-media-list");
  if (!target) return;

  const existing = body[target.name];
  const items = Array.isArray(existing) ? [...existing] : [];
  for (const param of atlasScalarParams(model)) {
    if (param.virtual !== "typed-video-urls" && param.virtual !== "typed-audio-urls") continue;
    const urls = clampAtlasValue(param, params[param.name]);
    if (!Array.isArray(urls)) continue;
    const type = param.virtual === "typed-video-urls" ? "video" : "audio";
    urls.forEach((url) => validateAtlasUrl(url, param.label));
    items.push(...urls.map((url) => ({ url, type })));
  }
  if (items.length > 0) body[target.name] = items;
}

/** Atlas expresses these relationships with JSON Schema conditionals, which
 * are not scalar values and therefore do not belong in the generated form
 * descriptor. Refuse the two invalid Wan 3.0 combinations before billing.
 * Gated on `enable_thinking`, the field that marks this family: `file` and
 * `link` are generic names, and a future synced model that declares its own
 * must not inherit Wan's mutual exclusion. */
function assertInputRelationships(model: AtlasModel, body: Record<string, unknown>): void {
  // Kling's shot_type is optional with no default, so it starts unset — but
  // "Required when multi_shot=true".
  if (
    body.multi_shot === true &&
    !body.shot_type &&
    model.params.some((param) => param.name === "shot_type")
  )
    throw new AtlasPayloadError("Multi-shot needs a shot type: customize or intelligence.");
  if (body.multi_shot === true && body.shot_type === "customize" && !body.multi_prompt)
    throw new AtlasPayloadError("Custom multi-shot mode needs shot prompts and durations.");
  if (Array.isArray(body.multi_prompt) && body.multi_prompt.length) {
    const shots = body.multi_prompt as Array<{ duration?: number | string }>;
    if (
      shots.some(
        (shot) =>
          !Number.isInteger(Number(shot.duration)) ||
          Number(shot.duration) < 1 ||
          Number(shot.duration) > 15,
      )
    )
      throw new AtlasPayloadError("Each shot must last between 1 and 15 seconds.");
    const total = shots.reduce((sum, shot) => sum + Number(shot.duration), 0);
    if (body.duration !== undefined && total !== Number(body.duration))
      throw new AtlasPayloadError("Shot durations must add up to the total video duration.");
  }
  if (Array.isArray(body.elements)) {
    for (const row of body.elements as Array<Record<string, unknown>>) {
      if (row.element_id !== undefined) {
        if (!Number.isSafeInteger(row.element_id) || Number(row.element_id) < 1 || row.element_name)
          throw new AtlasPayloadError(
            "Use either a valid existing element ID or a new element name.",
          );
      } else if (
        !row.element_name ||
        !row.reference_type ||
        (row.reference_type === "image_refer" &&
          (!row.frontal_image || !(row.refer_images as string[] | undefined)?.length)) ||
        (row.reference_type === "video_refer" &&
          !(row.refer_videos as string[] | undefined)?.length)
      )
        throw new AtlasPayloadError(
          "A new element needs a name and its image or video references.",
        );
    }
    for (const text of [
      body.prompt,
      ...(Array.isArray(body.multi_prompt)
        ? body.multi_prompt.map((shot: { prompt: string }) => shot.prompt)
        : []),
    ]) {
      for (const match of String(text ?? "").matchAll(/<<<element_(\d+)>>>/g))
        if (Number(match[1]) < 1 || Number(match[1]) > body.elements.length)
          throw new AtlasPayloadError("An element tag points to a missing subject.");
    }
  }
  if (Array.isArray(body.video_clips)) {
    for (const clip of body.video_clips as Array<{ start: number; ends: number }>) {
      if (clip.ends !== 0 && clip.ends <= clip.start)
        throw new AtlasPayloadError("A video clip must end after its start time.");
      if (model.id.includes("omni") && clip.ends - clip.start > 10)
        throw new AtlasPayloadError("Each video clip can be at most 10 seconds.");
    }
  }
  if (
    model.id.includes("seedream-v4.7") &&
    Array.isArray(body.images) &&
    body.images.length + Number(body.num_images ?? 1) > 15
  )
    throw new AtlasPayloadError("Reference images and generated images together cannot exceed 15.");
  if (
    model.id.startsWith("minimax/h3") &&
    Array.isArray(body.refers) &&
    !body.refers.some((item: { type: string }) => item.type === "image" || item.type === "video")
  )
    throw new AtlasPayloadError("H3 needs at least one image or video reference.");
  if (model.id.startsWith("ltx/")) assertLtxLimits(model, body);
  if (!model.params.some((param) => param.name === "enable_thinking")) return;

  const file = typeof body.file === "string" ? body.file.trim() : "";
  const link = typeof body.link === "string" ? body.link.trim() : "";
  if (!file && !link) return;

  if (file && link) {
    throw new AtlasPayloadError(
      `${model.label} accepts either a document URL or a webpage, not both.`,
    );
  }
  if (body.enable_thinking !== true) {
    throw new AtlasPayloadError(
      `${model.label} needs Enable Thinking turned on to read a document or webpage.`,
    );
  }
}

/**
 * LTX-2.3/2.5 state their combination limits in prose, where no enum carries
 * them: "Durations above 10s (12–20) require 720p or 1080p at 24/25 fps", and
 * the audio-driven endpoints need a first frame when the prompt is empty. Each
 * combination is otherwise a paid request the vendor rejects. (LTX-2.3 Fast's
 * unsupported audio switch is dropped by the sync, so it cannot be sent.)
 */
function assertLtxLimits(model: AtlasModel, body: Record<string, unknown>): void {
  const seconds = Number(body.duration);
  if (Number.isFinite(seconds) && seconds > 10) {
    const resolution = String(body.resolution ?? "").toLowerCase();
    if (resolution && resolution !== "720p" && resolution !== "1080p")
      throw new AtlasPayloadError(
        `${model.label} renders ${resolution.toUpperCase()} only up to 10 seconds.`,
      );
    const fps = Number(body.fps);
    if (Number.isFinite(fps) && fps > 25)
      throw new AtlasPayloadError(`${model.label} renders ${fps} fps only up to 10 seconds.`);
  }
  if (
    model.id.endsWith("/audio-to-video") &&
    !String(body.prompt ?? "").trim() &&
    !String(body.image ?? "").trim()
  )
    throw new AtlasPayloadError(`${model.label} needs a prompt or a first-frame image.`);
}

/** Applies the dialect to whichever shape this model's prompt takes. */
function renderPrompt(model: AtlasModel, value: AtlasParamValue): AtlasParamValue {
  if (typeof value === "string") return renderAtlasPrompt(model, value);
  // Four models type the prompt as an array; each entry is still a prompt.
  if (Array.isArray(value)) return value.map((entry) => renderAtlasPrompt(model, entry));
  return value;
}

/**
 * Refuse dangling editor tags at the shared boundary used by web, native, and
 * server-side retries. Some UI paths submit Atlas before their local prompt
 * validation, and an invalid ordinal would otherwise survive as paid vendor
 * syntax such as `Image 2` with only one attached reference.
 */
function assertReferenceTagsInRange(
  model: AtlasModel,
  prompt: AtlasParamValue | undefined,
  referenceCount: number,
): void {
  if (model.promptRefs === "none") return;
  const prompts = typeof prompt === "string" ? [prompt] : Array.isArray(prompt) ? prompt : [];
  const indices = prompts.flatMap(getGrokReferenceTagIndices);
  if (indices.some((index) => index < 1)) {
    throw new AtlasPayloadError(`${model.label} image tags start at @image1.`);
  }

  const maxIndex = Math.max(0, ...indices);
  if (maxIndex > referenceCount) {
    throw new AtlasPayloadError(
      `${model.label} prompt references @image${maxIndex}, but only ${referenceCount} ` +
        `reference${referenceCount === 1 ? " is" : "s are"} attached.`,
    );
  }
}

/**
 * Fails before the request rather than after the rejection.
 *
 * A missing required field is the one error worth catching locally: Atlas bills
 * nothing for it, but the round trip turns a fixable "attach an image" into an
 * opaque HTTP 400 in the history list.
 */
function assertRequired(model: AtlasModel, body: Record<string, unknown>): void {
  const missing: AtlasParam[] = [];
  for (const param of model.params) {
    const value = body[param.wireName ?? param.name];
    if (
      !param.required ||
      (value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0))
    )
      continue;
    missing.push(param);
  }
  if (missing.length === 0) return;

  const media = missing.filter(
    (param) =>
      param.kind === "media" || param.kind === "media-list" || param.kind === "typed-media-list",
  );
  if (media.length === missing.length) {
    throw new AtlasPayloadError(
      `${model.label} needs ${describeSlots(media)} — attach ${
        media.length === 1 ? "a reference image" : "the reference images"
      } before generating.`,
    );
  }
  throw new AtlasPayloadError(
    `${model.label} is missing required input: ${missing.map((param) => param.name).join(", ")}`,
  );
}

function describeSlots(params: readonly AtlasParam[]): string {
  return params
    .map((param) => {
      switch (param.role) {
        case "start":
          return "a start frame";
        case "end":
          return "an end frame";
        case "video":
          return "a source video";
        case "audio":
          return "an audio track";
        default:
          return param.kind === "media-list" || param.kind === "typed-media-list"
            ? "reference images"
            : "an image";
      }
    })
    .join(" and ");
}
