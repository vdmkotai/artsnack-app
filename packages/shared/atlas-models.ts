/**
 * Atlas Cloud's model registry: the types the generated catalogue is written
 * against, and the lookups the form and the Convex mutations share.
 *
 * The other three providers are hand-transcribed in api-models.ts because each
 * offers a handful of endpoints whose shapes barely move. Atlas offers 300+,
 * and the parameters are not a superset of each other — one Wan variant takes
 * `image` + `resolution` + `duration`, another adds `loras`, Seedance adds
 * `bitrate_mode`, `ratio`, `watermark` and `return_last_frame`, and MiniMax
 * spells the aspect ratio `aspect_ratio` where Seedance spells it `ratio`.
 *
 * So this file deliberately does *not* enumerate capabilities. It describes the
 * shape of a parameter, and everything downstream — the form controls, the
 * clamping, the request body — is derived from that description. Adding a model
 * to the app is then a matter of re-running the sync script, not writing code.
 */

import { ATLAS_CATALOG } from "./atlas-catalog.generated";
import { clampDimensions, defaultDimensionValue, formatDimensions } from "./atlas-dimensions";
import { midjourneyFlagParams } from "./midjourney-flags";

export const ATLAS_PROVIDER = "atlas" as const;

/**
 * How a parameter is collected from the user.
 *
 * `media` and `media-list` are the load-bearing ones: they are filled from the
 * reference picker and carry B2 URLs, never text the user typed.
 *
 * Structured reference and storyboard arrays have record editors. `complex`
 * and `loras` remain uncollected optional inputs; required unsupported shapes
 * are reported by the sync instead of appearing as unusable picker entries.
 */
export type AtlasParamKind =
  | "enum"
  | "boolean"
  | "integer"
  | "number"
  | "string"
  /** Array of plain strings that is not media — `prompt` is one on four models. */
  | "string-list"
  /**
   * Free-text pixel dimensions, spelled `1024*1024`.
   *
   * A string as far as the wire is concerned, but rendering it as one meant a
   * text box the user had to edit by hand. See atlas-dimensions.ts.
   */
  | "dimensions"
  | "url"
  | "url-list"
  | "record-list"
  | "image-record-list"
  | "media"
  | "media-list"
  /** Mixed image/video/audio references sent as `{ url, type }` objects.
   * The current picker fills the image subset. */
  | "typed-media-list"
  | "loras"
  | "complex";

/** Which slot a media parameter fills, so thumbnails can be labelled. */
export type AtlasMediaRole = "image" | "start" | "end" | "video" | "audio";

export type AtlasParamValue = string | number | boolean | string[];

export type AtlasParam = {
  /** Wire name, sent verbatim in the request body. */
  name: string;
  wireName?: string;
  fields?: readonly AtlasParam[];
  imageField?: string;
  imageFieldArray?: boolean;
  minItems?: number;
  kind: AtlasParamKind;
  /** Humanised `name`, used as the control's label. */
  label: string;
  description?: string;
  required: boolean;
  default?: AtlasParamValue;
  /** Present exactly when `kind` is "enum". */
  options?: readonly (string | number)[];
  role?: AtlasMediaRole;
  min?: number;
  max?: number;
  /** Maximum entries accepted by an array-valued media parameter. */
  maxItems?: number;
  /** Image-only subset of a mixed-media list, when it is lower than maxItems. */
  maxImageItems?: number;
  maxVideoItems?: number;
  maxAudioItems?: number;
  /** Maximum characters accepted by a string or each string-list item. */
  maxLength?: number;
  /** App-only scalar that is folded into a structured wire parameter, kept
   * visible until automatic family routing selects the endpoint that owns it,
   * or appended to the prompt as a Midjourney `--flag` (see midjourney-flags.ts). */
  virtual?:
    | "typed-video-urls"
    | "typed-audio-urls"
    | "reference-sibling"
    | "image-record-details"
    | "midjourney-flag";
  /** The vendor asked for a slider rather than a segmented control. */
  slider?: boolean;
  /** The vendor asked for a textarea — long prompts and negative prompts. */
  multiline?: boolean;

  // --- "dimensions" only. Stated in prose by the vendor, never in the schema. ---
  /** Shortest side the model accepts. */
  minSide?: number;
  /** Longest side the model accepts. */
  maxSide?: number;
  /** Cap on width x height, which two of them state and no other limit implies. */
  maxPixels?: number;
  /** An empty value is legal and means "keep the source resolution". */
  allowAuto?: boolean;
  /** Words accepted in place of a size — MAI-Image-2.6's `default` and `auto`. */
  specialValues?: readonly string[];
};

export type AtlasModel = {
  /** Wire id, e.g. "atlascloud/wan-2.2/image-to-video". Also our registry key. */
  id: string;
  retired?: boolean;
  label: string;
  media: "image" | "video";
  /** POST path from the model's own document — image and video differ. */
  submitPath: string;
  /** GET path. Two spellings exist in the catalogue, so it is read per model. */
  pollPath: string;
  family: string;
  organization: string;
  categories: readonly string[];
  /**
   * How the prompt is expected to point at the reference images.
   *
   * "ordinal" is Seedance 2.0's prose form ("image 1"), "ordinal-title" is
   * Wan 3.0's title-cased form ("Image 1"), "at-tag-optional" is Seedance
   * 2.5's take — `@imageN` is read when present but an untagged prompt is
   * legal — "at-tag-underscore" is Kling 4.0's
   * `@image_N`, and "none" means the model parses
   * nothing out of the prompt and an editor tag would reach it as text.
   * See promptReferenceDialect in scripts/sync-atlas-catalog.mjs.
   */
  promptRefs:
    | "ordinal"
    | "ordinal-title"
    | "at-tag-optional"
    | "at-tag-underscore"
    | "at-tag-title"
    | "image-ref-zero"
    | "image-zero"
    | "character"
    | "subject"
    | "named-reference"
    | "none";
  /**
   * USD per second for video, per image for images. Null when the vendor
   * publishes no figure, which is not the same as free — the estimate is
   * withheld rather than shown as zero.
   */
  basePrice: number | null;
  /**
   * The undiscounted rate, present only while `basePrice` is a promotional one.
   *
   * Atlas discounts roughly 40% of its catalogue, and the committed registry
   * freezes whatever was current at sync time. When a promotion lapses every
   * quote for that model is quietly low until someone re-runs the sync, so the
   * list price is carried alongside to make the exposure visible in the diff.
   */
  listPrice?: number;
  params: readonly AtlasParam[];
};

export const ATLAS_MODELS: readonly AtlasModel[] = ATLAS_CATALOG;

const BY_ID = new Map(ATLAS_MODELS.map((model) => [model.id, model]));

export function isAtlasModelId(value: string): boolean {
  return BY_ID.has(value);
}

/** Throws on an unknown id: an unregistered model is a bug, not a runtime state. */
export function getAtlasModel(id: string): AtlasModel {
  const model = BY_ID.get(id);
  if (!model) throw new Error(`Unknown Atlas model: ${id}`);
  return model;
}

export function atlasModelsFor(media: "image" | "video"): AtlasModel[] {
  return ATLAS_MODELS.filter((model) => !model.retired && model.media === media);
}

/**
 * The model the picker opens on for a media type.
 *
 * The cheapest one — an accidental first click should not be the most
 * expensive one in the catalogue.
 */
export function defaultAtlasModel(media: "image" | "video"): AtlasModel {
  const candidates = atlasModelsFor(media);
  return candidates.reduce((best, model) => {
    if (best.basePrice === null) return model;
    if (model.basePrice === null) return best;
    return model.basePrice < best.basePrice ? model : best;
  }, candidates[0]);
}

// ---------------------------------------------------------------------------
// Parameter access
// ---------------------------------------------------------------------------

export function atlasParam(model: AtlasModel, name: string): AtlasParam | undefined {
  return model.params.find((param) => param.name === name);
}

/** Kinds the form has no control for and the payload never carries. */
const UNCOLLECTABLE: ReadonlySet<AtlasParamKind> = new Set(["loras", "complex"]);

export function isCollectableAtlasParam(param: AtlasParam): boolean {
  return !UNCOLLECTABLE.has(param.kind);
}

/** Scalars the form renders as controls — not media slots, not the uncollectable. */
export function atlasScalarParams(model: AtlasModel): AtlasParam[] {
  const scalars = model.params.filter(
    (param) =>
      param.kind !== "media" &&
      param.kind !== "media-list" &&
      param.kind !== "typed-media-list" &&
      param.kind !== "image-record-list" &&
      isCollectableAtlasParam(param),
  );

  for (const param of model.params.filter((entry) => entry.kind === "image-record-list")) {
    scalars.push({
      ...param,
      name: `${param.name}_details`,
      required: false,
      virtual: "image-record-details",
    });
  }

  const typedMedia = atlasTypedMediaParam(model);
  if (typedMedia) {
    const param = typedMedia;
    if (param.maxVideoItems) {
      scalars.push({
        name: `${param.name}_video_urls`,
        kind: "string-list",
        label: "Reference Video URLs",
        description: `Public video URLs. Up to ${param.maxVideoItems} in this form. ${param.description ?? ""}`,
        required: false,
        maxItems: param.maxVideoItems,
        virtual: "typed-video-urls",
      });
    }
    if (param.maxAudioItems) {
      scalars.push({
        name: `${param.name}_audio_urls`,
        kind: "string-list",
        label: "Reference Audio URLs",
        description: `Public audio URLs. Up to ${param.maxAudioItems} in this form. ${param.description ?? ""}`,
        required: false,
        maxItems: param.maxAudioItems,
        virtual: "typed-audio-urls",
      });
    }

    // Wan's document/webpage controls live only on reference-to-video, while
    // the catalogue deliberately shows one row for the whole family. Keep
    // those controls available on its text/image siblings; resolveAtlasVariant
    // moves the request before the payload is built, so unknown fields never
    // reach the wrong endpoint.
    const reference = atlasVariants(model).reference;
    if (reference && reference.id !== model.id) {
      const ownNames = new Set(scalars.map((candidate) => candidate.name));
      for (const siblingParam of reference.params) {
        if (!REFERENCE_SIBLING_FIELDS.has(siblingParam.name) || ownNames.has(siblingParam.name)) {
          continue;
        }
        scalars.push({ ...siblingParam, virtual: "reference-sibling" });
      }
    }
  }
  const reference = atlasVariants(model).reference;
  if (reference && reference.id !== model.id) {
    const names = new Set(scalars.map((param) => param.name));
    for (const param of reference.params) {
      if (
        (param.kind === "url" || param.kind === "url-list" || param.name === "video_clips") &&
        !names.has(param.name)
      ) {
        scalars.push({ ...param, required: false, virtual: "reference-sibling" });
      }
    }
  }
  // Midjourney's own settings that Atlas leaves to the prompt. Last, after the
  // vendor's fields, so the schema's controls keep their order.
  scalars.push(...midjourneyFlagParams(model));
  return scalars;
}

const REFERENCE_SIBLING_FIELDS = new Set(["enable_thinking", "file", "link"]);

/** Declared but not collectable, so the form can say so instead of hiding it. */
export function atlasUnsupportedParams(model: AtlasModel): AtlasParam[] {
  return model.params.filter((param) => !isCollectableAtlasParam(param));
}

/** Media slots, in declaration order, which is the order the form fills them. */
export function atlasMediaParams(model: AtlasModel): AtlasParam[] {
  return model.params.filter(
    (param) =>
      param.kind === "media" ||
      param.kind === "media-list" ||
      param.kind === "typed-media-list" ||
      param.kind === "image-record-list",
  );
}

/**
 * How many references this model can take.
 *
 * A `media-list` uses its schema's `maxItems` when Atlas publishes one. Older
 * catalogue entries without that field keep the previous ceiling, while
 * single `media` slots count one each. Returns 0 for pure text-to-X models,
 * which is what hides the picker.
 */
export const ATLAS_MAX_LIST_REFERENCES = 9;

export function atlasMaxReferences(model: AtlasModel): number {
  let total = 0;
  for (const param of atlasMediaParams(model)) {
    const capacity =
      param.kind === "media-list" ||
      param.kind === "typed-media-list" ||
      param.kind === "image-record-list"
        ? (param.maxImageItems ?? param.maxItems ?? ATLAS_MAX_LIST_REFERENCES)
        : 1;
    total += capacity;
  }
  const cap = ATLAS_TOTAL_IMAGE_CAPS.find(([pattern]) => pattern.test(model.id))?.[1];
  return cap === undefined ? total : Math.min(total, cap);
}

/**
 * Ceilings the vendor states across all of a model's image slots together,
 * which no single slot's `maxItems` expresses.
 *
 * Kling 4.0: "Up to 10 images in total including keyframes". Its reference
 * endpoint declares a 10-image list, a first frame, 8 middle frames and a last
 * frame — 20 slots that would let a submission through which Kling refuses.
 */
const ATLAS_TOTAL_IMAGE_CAPS: readonly [RegExp, number][] = [[/^kwaivgi\/kling-v4\.0\//, 10]];

/**
 * Endpoints Atlas moved to a new id, so a saved form or a reproduced row on the
 * old one lands on its successor rather than on a "no longer listed" notice.
 *
 * Youchuan's Midjourney endpoints were renamed on 2026-10-24 —
 * `youchuan/v8.2/text-to-image` is now `midjourney/v8.2/text-to-image`, with
 * the same parameters.
 */
const ATLAS_RENAMES: readonly [RegExp, string][] = [[/^youchuan\//, "midjourney/"]];

/** The live endpoint a retired one was renamed to, if Atlas renamed it. */
export function atlasSuccessor(model: AtlasModel): AtlasModel | undefined {
  if (!model.retired) return undefined;
  for (const [pattern, replacement] of ATLAS_RENAMES) {
    if (!pattern.test(model.id)) continue;
    const successor = BY_ID.get(model.id.replace(pattern, replacement));
    if (successor && !successor.retired) return successor;
  }
  return undefined;
}

/**
 * How many references the model family can accept after automatic routing.
 *
 * The composer stores one concrete endpoint, but a catalogue row can represent
 * text-, first-frame- and reference-input siblings. Its attachment picker must
 * use the largest capacity in that family: otherwise a two-frame endpoint makes
 * the third image impossible to attach, so `resolveAtlasVariant` can never move
 * the form to the 30-image reference endpoint.
 */
export function atlasFamilyMaxReferences(model: AtlasModel): number {
  const family = Object.values(atlasVariants(model));
  if (family.length === 0) return atlasMaxReferences(model);
  return Math.max(...family.map(atlasMaxReferences));
}

/**
 * The model's own batch parameter, if it has one.
 *
 * 27 of the 109 image models take `num_images` or `n` and return several images
 * from one request; the other 82 take nothing, so several images means several
 * requests — the same fan-out Higgsfield needs, for the same reason. The form
 * shows one "Images per tap" control either way and this decides which of the
 * two it drives.
 */
const BATCH_PARAMS = ["num_images", "n"] as const;

export function atlasBatchParam(model: AtlasModel): AtlasParam | undefined {
  for (const name of BATCH_PARAMS) {
    const param = atlasParam(model, name);
    if (param) return param;
  }
  return undefined;
}

/**
 * Images per tap the form offers on every Atlas image model.
 *
 * Without a batch parameter each image is a separate job and charge; with one,
 * the count is split by `atlasBatchSplit`. Either way the buttons show totals.
 * Atlas publishes no numeric limits ("per account and per model", 429 past
 * them); the submit retries a 429, which is the one refusal that queued nothing.
 */
export const ATLAS_FANOUT_COUNTS = [1, 2, 3, 4, 6, 8, 10] as const;

/**
 * Any whole count up to the last button is legal, on or off the list: a
 * restored row can carry a batch of 5, which used to reproduce as 5.
 */
export function isAtlasImageCount(count: number): boolean {
  return (
    Number.isInteger(count) &&
    count >= 1 &&
    count <= ATLAS_FANOUT_COUNTS[ATLAS_FANOUT_COUNTS.length - 1]
  );
}

/** The count buttons, plus the current value when it is legal but off the list. */
export function atlasCountOptions(current: number): number[] {
  const options: number[] = [...ATLAS_FANOUT_COUNTS];
  if (isAtlasImageCount(current) && !options.includes(current)) {
    options.push(current);
    options.sort((a, b) => a - b);
  }
  return options;
}

/** The batch sizes one request may ask for, ascending. */
function atlasBatchSizes(param: AtlasParam): number[] {
  if (param.options) {
    return param.options
      .map(Number)
      .filter((value) => Number.isInteger(value) && value >= 1)
      .sort((a, b) => a - b);
  }
  const min = Math.max(1, Math.ceil(param.min ?? 1));
  const max = Math.floor(param.max ?? min);
  return Array.from({ length: Math.max(0, max - min + 1) }, (_, index) => min + index);
}

/**
 * How a model with its own batch parameter makes `images` images: `requests`
 * identical submissions of `perRequest` each.
 *
 * Qwen Image 3.0 stops at 4 per request, so 10 is five requests of 2 rather
 * than 4 + 4 + 2. Equal requests are what keep the fan-out "N copies of one
 * submission": every row carries the same parameters, the quote is the one
 * request's price times N, and the server needs no notion of a split. The
 * largest size that divides the count keeps the requests few.
 */
export function atlasBatchSplit(
  model: AtlasModel,
  images: number,
): { param: AtlasParam; perRequest: number; requests: number } | null {
  const param = atlasBatchParam(model);
  if (!param) return null;
  const total = Math.max(1, Math.round(images));
  const sizes = atlasBatchSizes(param);
  const fits = sizes.filter((size) => total % size === 0);
  const perRequest = fits[fits.length - 1] ?? 1;
  return { param, perRequest, requests: total / perRequest };
}

/** The hint beside an image model's count, shared so every client says the same. */
export function atlasImageCountHint(model: AtlasModel): string {
  const batch = atlasBatchParam(model);
  if (!batch) {
    return "Each request is a separate run and charge. A model's Maximum images is an output cap within each run, not a guaranteed image count.";
  }
  const sizes = atlasBatchSizes(batch);
  const most = sizes[sizes.length - 1] ?? 1;
  return most <= 1
    ? "This model returns one image per request, so each image is a separate run and charge."
    : `This model returns up to ${most} images per request, so a larger count is sent as equal requests, each a separate charge.`;
}

/**
 * The scalars a form draws as controls: not the prompt, which has its own box,
 * and not an image model's batch parameter, which follows "Number of images"
 * (see atlasBatchSplit) — two counts on one panel meant different things.
 */
export function atlasFormParams(model: AtlasModel): AtlasParam[] {
  const batch = model.media === "image" ? atlasBatchParam(model) : undefined;
  return atlasScalarParams(model).filter((param) => param.name !== "prompt" && param !== batch);
}

/** The split's size in the type the schema declares — an enum may list strings. */
export function atlasBatchValue(param: AtlasParam, perRequest: number): AtlasParamValue {
  return param.options?.find((option) => Number(option) === perRequest) ?? perRequest;
}

/**
 * Names for the positional media slots, or null where the model takes a list.
 *
 * The difference is what the thumbnail badge says, and it is not cosmetic: on a
 * frame model the first image is the opening frame and the second is the
 * closing one, so a badge reading "1" and "2" describes an ordering the vendor
 * does not have. Returns null for list models — there the number really is the
 * meaning — and for models that take no media at all.
 *
 * Labels repeat on one model in the catalogue (`face-swap-image` declares both
 * `image` and `Image`), so colliding names are numbered rather than left
 * ambiguous.
 */
export function atlasFrameSlots(model: AtlasModel): string[] | null {
  const media = atlasMediaParams(model);
  if (media.length === 0) return null;
  if (
    media.some(
      (param) =>
        (param.kind === "media-list" && param.maxItems !== 1) ||
        param.kind === "typed-media-list" ||
        param.kind === "image-record-list",
    )
  ) {
    return null;
  }

  const labels = media.map((param) => {
    if (param.role === "end") return "End";
    if (param.role === "start") return "Start";
    // A lone image on a video model is the opening frame, whatever it is named.
    if (
      (param.name === "image" || param.name === "image_url") &&
      model.media === "video" &&
      (media.some((slot) => slot.role === "end") || variantOf(model.id)?.variant === "image")
    )
      return "Start";
    return param.label;
  });

  return labels.map((label, index) =>
    labels.filter((other) => other === label).length > 1
      ? `${label} ${labels.slice(0, index + 1).filter((other) => other === label).length}`
      : label,
  );
}

/**
 * The caption beside a model's reference slots — what the slots mean and how
 * the prompt refers to them.
 *
 * Written from the model's own declared media parameters rather than from a
 * fixed sentence, because the shapes genuinely differ across the catalogue: one
 * `image`, an `image` plus an `end_image`, or a single open `images` list. And
 * the list models split three ways on the prompt dialect, where getting it
 * wrong is a refusal or a wasted run rather than a cosmetic slip.
 */
export function atlasReferenceHint(model: AtlasModel, capacity: number): string {
  if (capacity === 0) return `${model.label} takes no reference images.`;

  const slots = atlasMediaParams(model);
  // A nonzero capacity with no slots of its own means the capacity belongs to
  // a sibling endpoint: mixed-reference families rest on text-to-video, and
  // attaching anything routes to the frame or reference variant. Describe the
  // sibling that will actually take the references, not this model.
  if (slots.length === 0) {
    const sibling = Object.values(atlasVariants(model))
      .filter((candidate) => atlasMediaParams(candidate).length > 0)
      .sort((a, b) => atlasMaxReferences(b) - atlasMaxReferences(a))[0];
    if (sibling) return atlasReferenceHint(sibling, capacity);
    return `${model.label} takes no reference images.`;
  }
  const list = slots.find(
    (param) =>
      param.kind === "media-list" ||
      param.kind === "typed-media-list" ||
      param.kind === "image-record-list",
  );
  if (list) {
    if (
      [
        "image-ref-zero",
        "image-zero",
        "character",
        "subject",
        "named-reference",
        "at-tag-title",
        "at-tag-underscore",
      ].includes(model.promptRefs)
    ) {
      return `Attach up to ${capacity} references in order. Type @ to tag an image; the app converts @image1 to this model's reference syntax.`;
    }
    if (model.promptRefs === "at-tag-optional") {
      return `${model.label} takes up to ${capacity} reference${capacity === 1 ? "" : "s"}. Call one out with @image1, @image2… if the prompt needs it — untagged references still apply, in order.`;
    }
    if (model.promptRefs === "ordinal" || model.promptRefs === "ordinal-title") {
      const first = model.promptRefs === "ordinal-title" ? "Image 1" : "image 1";
      const second = model.promptRefs === "ordinal-title" ? "Image 2" : "image 2";
      return `${model.label} takes up to ${capacity} reference${capacity === 1 ? "" : "s"}. Tag them with @image1, @image2… and they are sent as "${first}", "${second}" — the wording it reads.`;
    }
    return `${model.label} takes up to ${capacity} reference${capacity === 1 ? "" : "s"} as a set — order matters, tagging does not.`;
  }

  const named = slots.map((param) => {
    switch (param.role) {
      case "end":
        return "an end frame";
      case "start":
        return "a start frame";
      case "video":
        return "a source video";
      case "audio":
        return "an audio track";
      default:
        // The slot's own name: "an image" on most models, but Midjourney's lone
        // slot is a style reference and its edit sibling takes an image *and*
        // one, and "an image and an image" tells the user nothing.
        return withArticle(param.label.toLowerCase());
    }
  });
  return `${model.label} takes ${named.join(" and ")}, filled in the order you select them.`;
}

function withArticle(noun: string): string {
  return `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`;
}

/**
 * Whether the editor should offer @-tagging for this model.
 *
 * Only where the vendor documents a way to read the tags back. Offering it
 * anywhere else highlights `@image1` as meaningful and then sends those nine
 * characters to the model as part of the prompt.
 */
export function atlasSupportsPromptTags(model: AtlasModel): boolean {
  return (
    model.promptRefs !== "none" &&
    atlasMediaParams(model).some(
      (param) =>
        param.kind === "media-list" ||
        param.kind === "typed-media-list" ||
        param.kind === "image-record-list",
    )
  );
}

/** The prompt field. Absent on a few edit models. */
export function atlasPromptParam(model: AtlasModel): AtlasParam | undefined {
  return atlasParam(model, "prompt");
}

/**
 * The prompt is never carried in the parameter bag.
 *
 * It has its own box in the composer, with saved prompts attached, and the
 * submission sets it from there. Collecting it here as well was actively
 * harmful: Atlas ships its documentation *example* as the `prompt` default, so
 * `atlasDefaults` picked up a stranger's sentence, the renderer hid the field,
 * and `normalizeAtlasParams` carried it from model to model. On the 49 models
 * where a prompt is optional, submitting with an empty box then sent that
 * example to the vendor and billed for it.
 */
export const ATLAS_PROMPT_PARAM = "prompt";

/**
 * Renders the prompt as the selected model declares it.
 *
 * The `infinite-image-to-video` models type `prompt` as an array of strings. Sending a bare string there failed
 * `clampAtlasValue` and silently substituted the schema default, so the user's
 * text was replaced by the vendor's example prompt and charged for.
 */
export function atlasPromptValue(model: AtlasModel, prompt: string): AtlasParamValue | undefined {
  const param = atlasPromptParam(model);
  if (!param) return undefined;
  const trimmed = prompt.trim();
  if (param.kind === "string-list" || param.kind === "url-list") return trimmed ? [trimmed] : [];
  return trimmed;
}

// ---------------------------------------------------------------------------
// Defaults and clamping
// ---------------------------------------------------------------------------

/**
 * An optional enum the vendor gave no default: nothing is sent unless the user
 * picks a value.
 *
 * This used to fall back to the first option, which turned "optional" into a
 * forced choice nobody made — every LTX clip went out with `camera_motion:
 * dolly_in`, every Seedance v1 Pro Fast animation was cropped to 21:9, and
 * Nano Banana 2 edits to 1:1 instead of following the source image. Omitted,
 * the model applies its own behaviour, which is what the schema describes.
 *
 * Fields inside a structured row are the exception and keep their first
 * option: a row is built whole, and a Kling element without a reference_type
 * or a Pixverse reference without a type is not a row the vendor accepts.
 */
export function atlasEnumIsUnset(param: AtlasParam): boolean {
  return (
    param.kind === "enum" &&
    !param.required &&
    param.default === undefined &&
    !RECORD_FIELDS.has(param)
  );
}

const RECORD_FIELDS: ReadonlySet<AtlasParam> = new Set(
  ATLAS_MODELS.flatMap((model) => model.params.flatMap((param) => param.fields ?? [])),
);

function fallbackValue(param: AtlasParam): AtlasParamValue {
  if (param.options && param.options.length > 0) {
    return atlasEnumIsUnset(param) ? "" : param.options[0];
  }
  switch (param.kind) {
    case "dimensions":
      return defaultDimensionValue(param);
    case "boolean":
      return false;
    case "integer":
    case "number":
      // A seed with no documented default is left to the vendor, which
      // randomises it. Falling back to its minimum sent `seed: 0` on 30 models,
      // so every run of FLUX 3, Veo 3.1 or Pixverse repeated the same result.
      if (param.name === "seed" && !param.required) return "";
      return param.min ?? 0;
    case "string-list":
    case "url-list":
      return [];
    case "record-list":
    case "image-record-list":
      return "[]";
    default:
      return "";
  }
}

export function atlasDefaultValue(param: AtlasParam): AtlasParamValue {
  // Dimensions always go through their own normaliser, so a vendor default of
  // "1024 * 1024" or "1024x1024" lands in the one spelling the API accepts.
  if (param.kind === "dimensions") return defaultDimensionValue(param);
  return param.default ?? fallbackValue(param);
}

/** Every scalar at its documented default — the starting state of a fresh form. */
export function atlasDefaults(model: AtlasModel): Record<string, AtlasParamValue> {
  const values: Record<string, AtlasParamValue> = {};
  for (const param of atlasScalarParams(model)) {
    if (param.name === ATLAS_PROMPT_PARAM) continue;
    values[param.name] = atlasDefaultValue(param);
  }
  return values;
}

function nearestNumber(target: number, allowed: readonly number[]): number {
  return allowed.reduce((best, candidate) =>
    Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best,
  );
}

/**
 * Forces one value into what the schema accepts.
 *
 * Enums are matched exactly and otherwise fall back to the default rather than
 * to something "close": "720p" and "720p-SR" are both legal on Seedance and
 * mean different prices, so guessing between them is worse than resetting.
 * Numeric enums are the exception — durations are ordered, and clamping 20s to
 * the nearest legal 15s is what the user meant.
 */
export function clampAtlasValue(param: AtlasParam, value: AtlasParamValue | undefined) {
  const fallback = atlasDefaultValue(param);
  if (value === undefined || value === null) return fallback;

  if (param.options && param.options.length > 0) {
    if (param.options.includes(value as string | number)) return value;
    // Atlas changed Prime's wire tiers from 720P to 720p. Preserve that tier
    // in saved forms and stale clients instead of resetting it to 1080p.
    if (param.name === "resolution" && typeof value === "string") {
      const sameTier = param.options.find(
        (option) => typeof option === "string" && option.toLowerCase() === value.toLowerCase(),
      );
      if (sameTier !== undefined) return sameTier;
    }
    const numeric = param.options.filter((option): option is number => typeof option === "number");
    if (numeric.length > 0 && typeof value === "number") return nearestNumber(value, numeric);
    return fallback;
  }

  switch (param.kind) {
    case "boolean":
      return typeof value === "boolean" ? value : fallback;
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
      let next = param.kind === "integer" ? Math.round(value) : value;
      if (typeof param.min === "number") next = Math.max(param.min, next);
      if (typeof param.max === "number") next = Math.min(param.max, next);
      return next;
    }
    case "string-list":
    case "url-list":
      // Same reference when nothing is trimmed: normalizeAtlasParams detects
      // adjustments by identity, and a fresh copy per pass reads as a phantom
      // "adjusted" toast on every form edit.
      return Array.isArray(value) && value.every((item) => typeof item === "string")
        ? param.maxItems !== undefined && value.length > param.maxItems
          ? value.slice(0, param.maxItems)
          : value
        : fallback;
    case "dimensions": {
      if (typeof value === "string" && param.specialValues?.includes(value)) return value;
      // An empty value is a documented "keep the source resolution" on the two
      // Qwen edit endpoints, and meaningless anywhere else.
      if (typeof value === "string" && value.trim() === "") {
        return param.allowAuto ? "" : fallback;
      }
      const size = clampDimensions(param, value);
      return size ? formatDimensions(size) : fallback;
    }
    default:
      return typeof value === "string" ? value : fallback;
  }
}

/**
 * Carries a parameter bag across a model switch.
 *
 * Values are kept by name, so switching between two Wan variants preserves the
 * resolution and duration the user picked, and anything the new model does not
 * declare is dropped rather than sent — Atlas rejects unknown properties.
 *
 * A bag that comes through unchanged is returned as the same object. The form
 * is normalised on every keystroke in the prompt, and a fresh bag each time
 * gave every control reading it new props — the whole parameter panel
 * re-rendered per character typed.
 */
export function normalizeAtlasParams(
  model: AtlasModel,
  previous: Record<string, AtlasParamValue> | undefined,
): { params: Record<string, AtlasParamValue>; adjustments: string[] } {
  const params: Record<string, AtlasParamValue> = {};
  const adjustments: string[] = [];

  for (const param of atlasScalarParams(model)) {
    // Owned by the composer's prompt box, not by the bag. See ATLAS_PROMPT_PARAM.
    if (param.name === ATLAS_PROMPT_PARAM) continue;
    const carried = previous?.[param.name];
    const next = clampAtlasValue(param, carried);
    params[param.name] = next;
    // "" is "not set" (an optional enum or seed left to the vendor), so moving
    // from it is not an adjustment the user needs to hear about.
    if (carried !== undefined && carried !== "" && carried !== next) {
      adjustments.push(`${param.label} ${String(carried)} → ${String(next)}`);
    }
  }

  return { params: previous && sameBag(previous, params) ? previous : params, adjustments };
}

/** Same keys, and every value the identical one (lists are kept by reference when untrimmed). */
function sameBag(a: Record<string, AtlasParamValue>, b: Record<string, AtlasParamValue>): boolean {
  const keys = Object.keys(b);
  if (Object.keys(a).length !== keys.length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(a, key) && a[key] === b[key]);
}

// ---------------------------------------------------------------------------
// Search, for a picker over 300 models
// ---------------------------------------------------------------------------

export type AtlasFilter = {
  media: "image" | "video";
  /** Free text over id, label and family. */
  query?: string;
};

/**
 * Ranked matches for the picker.
 *
 * Ordering is cheapest, then alphabetical — the same priority defaultAtlasModel
 * uses, so the default is always the top row rather than something the user has
 * to scroll to.
 */
export function searchAtlasModels(filter: AtlasFilter): AtlasModel[] {
  const needle = filter.query?.trim().toLowerCase() ?? "";
  return atlasModelsFor(filter.media)
    .filter((model) => {
      if (!needle) return true;
      return `${model.id} ${model.label} ${model.family} ${model.organization}`
        .toLowerCase()
        .includes(needle);
    })
    .sort((a, b) => {
      const priceA = a.basePrice ?? Number.POSITIVE_INFINITY;
      const priceB = b.basePrice ?? Number.POSITIVE_INFINITY;
      if (priceA !== priceB) return priceA - priceB;
      return a.label.localeCompare(b.label);
    });
}

/** Families present for a media type, for the picker's grouping headers. */
export function atlasFamilies(media: "image" | "video"): string[] {
  const seen = new Set<string>();
  for (const model of atlasModelsFor(media)) {
    if (model.family) seen.add(model.family);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Sibling endpoints
// ---------------------------------------------------------------------------

/**
 * Atlas splits one model into separate endpoints per input shape, and 38
 * families in the catalogue are split that way.
 *
 * `bytedance/seedance-2.0` is three: `/text-to-video` takes nothing,
 * `/image-to-video` takes a first and last frame, `/reference-to-video` takes a
 * list and reads "image 1" out of the prompt. They are one model to the person
 * using them, and which URL that becomes is a consequence of what they attached
 * — the same thing `seedanceMode` decides for fal, where the routing has always
 * been automatic.
 */
const VARIANT_SUFFIX = /\/(text|image|reference)-to-(video|image)$/;

export type AtlasVariant = "text" | "image" | "reference";

function variantOf(id: string): { base: string; variant: AtlasVariant } | null {
  const match = id.match(VARIANT_SUFFIX);
  if (!match) return null;
  return { base: id.slice(0, id.length - match[0].length), variant: match[1] as AtlasVariant };
}

/** The sibling endpoints of a model, including itself, keyed by input shape. */
export function atlasVariants(model: AtlasModel): Partial<Record<AtlasVariant, AtlasModel>> {
  const parsed = variantOf(model.id);
  if (!parsed) return {};
  const suffix = model.id.slice(parsed.base.length).replace(/^\/(text|image|reference)/, "");
  const found: Partial<Record<AtlasVariant, AtlasModel>> = {};
  for (const variant of ["text", "image", "reference"] as const) {
    const sibling = BY_ID.get(`${parsed.base}/${variant}${suffix}`);
    // Same media type only: `alibaba/wan-2.5` has both text-to-image and
    // text-to-video, and routing an image request onto a video endpoint would
    // be a much worse surprise than the one this exists to prevent.
    if (sibling && !sibling.retired && sibling.media === model.media) found[variant] = sibling;
  }
  return found;
}

/** The structured reference input offered by this endpoint or one of its
 * automatically routed siblings. Virtual URL fields need to stay visible while
 * the family is still on text-to-video, otherwise there is no way to reach the
 * reference endpoint with only a video or audio source. */
function atlasTypedMediaParam(model: AtlasModel): AtlasParam | undefined {
  const own = model.params.find((param) => param.kind === "typed-media-list");
  if (own) return own;
  for (const sibling of Object.values(atlasVariants(model))) {
    const param = sibling.params.find((candidate) => candidate.kind === "typed-media-list");
    if (param) return param;
  }
  return undefined;
}

/** Whether this model or any sibling reads tags out of the prompt. */
export function atlasFamilyReadsTags(model: AtlasModel): boolean {
  // Standalone endpoints such as Seedream Pro Edit have no text/image/reference
  // suffix and therefore no atlasVariants() entries. The selected model is
  // still part of its own family for the editor capability check.
  if (model.promptRefs !== "none" && atlasMaxReferences(model) > 0) return true;

  return Object.values(atlasVariants(model)).some(
    (sibling) => sibling.promptRefs !== "none" && atlasMaxReferences(sibling) > 0,
  );
}

function atlasScalarParamsForRouting(
  model: AtlasModel,
  params: Record<string, AtlasParamValue>,
): boolean {
  return model.params.some((param) => {
    const value = params[param.name];
    if (param.name === "video_clips")
      return typeof value === "string" && value.trim() !== "" && value.trim() !== "[]";
    if (param.kind !== "url" && param.kind !== "url-list") return false;
    return Array.isArray(value)
      ? value.length > 0
      : typeof value === "string" && value.trim().length > 0;
  });
}

const TAG_PATTERN = /@image\s?\d+\b/i;

/**
 * The endpoint that can actually serve what the user has composed.
 *
 * Deliberately conservative: it only moves off the chosen endpoint when that
 * one *cannot* do the job, never to second-guess a deliberate choice. Picking
 * `reference-to-video` and attaching a single image is a legitimate request —
 * one character reference — and downgrading it to `image-to-video` would turn a
 * character reference into a first frame.
 *
 * The tag rule is the one people hit: `@image1` on `/image-to-video` is a first
 * and last frame, which reads no tags at all, while its sibling
 * `/reference-to-video` is exactly the endpoint that does.
 */
export function resolveAtlasVariant(
  model: AtlasModel,
  referenceCount: number,
  prompt: string,
  params: Record<string, AtlasParamValue> = {},
): AtlasModel {
  const siblings = atlasVariants(model);
  if (Object.keys(siblings).length < 2) return model;

  if (siblings.reference && atlasScalarParamsForRouting(siblings.reference, params)) {
    return siblings.reference;
  }
  // Tags asked for, and this endpoint cannot read them.
  if (TAG_PATTERN.test(prompt) && model.promptRefs === "none" && siblings.reference) {
    return siblings.reference;
  }

  const typedMedia = atlasTypedMediaParam(model);
  if (typedMedia && siblings.reference) {
    const hasVideoOrAudio = [
      params[`${typedMedia.name}_video_urls`],
      params[`${typedMedia.name}_audio_urls`],
    ].some((value) => Array.isArray(value) && value.length > 0);
    if (hasVideoOrAudio) return siblings.reference;

    const hasDocumentOrLink = [params.file, params.link].some(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    if (hasDocumentOrLink) return siblings.reference;

    // Mixed-reference families are selected as one catalogue row. Start on
    // text-to-video when it has no source, then move to the frame or reference
    // endpoint as soon as an input appears.
    if (referenceCount === 0 && siblings.text) return siblings.text;
  }

  const capacity = atlasMaxReferences(model);
  /*
   * Nothing routes away from an endpoint because it is not being used *yet*.
   *
   * There used to be a rule here sending an empty reference list to the text
   * variant, described as conservative. It was the opposite: picking "Seedance
   * 2.0 Reference-to-Video" from the picker moved you to text-to-video before
   * you could attach anything, and text-to-video has no reference slots — so
   * the upload block disappeared, which left nothing to attach and therefore
   * nothing to tag. Choosing an endpoint is a statement about the run being
   * composed, not about the state it is in half a second later.
   *
   * Submitting a reference endpoint with nothing attached is not silently
   * corrected either; assertRequired refuses it by name, for free, before the
   * request.
   */
  if (referenceCount > 0 && capacity === 0) {
    return (referenceCount > 1 ? siblings.reference : undefined) ?? siblings.image ?? model;
  }
  // More images than this endpoint has slots for, and a list endpoint exists.
  if (referenceCount > capacity && siblings.reference) return siblings.reference;

  return model;
}

// ---------------------------------------------------------------------------
// The picker's view of the catalogue
// ---------------------------------------------------------------------------

/**
 * One row in the model picker: a model, not a URL.
 *
 * Listing endpoints made the picker lie about how many models there are.
 * Searching "seedance 1." returned four rows that were really two models shown
 * once per input shape — and since the form now routes between those shapes
 * automatically, choosing between them was a decision with no consequence.
 */
export type AtlasCatalogRow = {
  /** Stable key: the family base where one exists, else the model id. */
  key: string;
  /** The endpoint selecting this row lands on; routing corrects it immediately. */
  model: AtlasModel;
  /** Display name with the "Text-to-Video" suffix removed. */
  label: string;
  /** Input shapes this family offers, for the chips under the name. */
  variants: AtlasVariant[];
  vendor: string;
  basePrice: number | null;
};

/**
 * "Seedance v1.5 Pro Text-to-Video" → "Seedance v1.5 Pro".
 *
 * Only where the row actually stands for a family. On a lone endpoint the
 * suffix is the distinguishing information rather than noise: `Pixverse v6
 * Start-End-to-Video` sits beside `Pixverse v6 Image-to-Video`, and stripping
 * both would put two identically named rows in the list.
 */
function familyLabel(model: AtlasModel, grouped: boolean): string {
  if (!grouped) return model.label;
  return (
    model.label
      .replace(/\s*[-–]?\s*(text|image|reference)[- ]to[- ](video|image)\s*$/i, "")
      .trim() || model.label
  );
}

const VENDOR_LABELS: Record<string, string> = {
  "BLACK-FOREST-LABS": "Black Forest Labs",
  ATLASCLOUD: "Atlas Cloud",
  KUAISHOU: "Kuaishou",
  BYTEDANCE: "ByteDance",
  MIDJOURNEY: "Midjourney",
  MINIMAX: "MiniMax",
  PIXVERSE: "Pixverse",
  MICROSOFT: "Microsoft",
  LIGHTRICKS: "Lightricks",
  // Atlas files the LTX-2.3/2.5 endpoints under "LTX" and the older
  // ltx-2.3-quality ones under "LIGHTRICKS"; one company, one rail entry.
  LTX: "Lightricks",
  "REVE AI": "Reve AI",
  TONGYIMAI: "TongyiMai",
  OPENAI: "OpenAI",
  GOOGLE: "Google",
  QWEN: "Qwen",
  VIDU: "Vidu",
  XAI: "xAI",
};

export function atlasVendorLabel(organization: string): string {
  if (!organization) return "Other";
  return (
    VENDOR_LABELS[organization] ?? organization.charAt(0) + organization.slice(1).toLowerCase()
  );
}

/**
 * The catalogue collapsed to one row per model, for a media type.
 *
 * Ordered the same way searchAtlasModels orders endpoints — cheapest first —
 * so the default is still the top row.
 */
export function atlasCatalogRows(media: "image" | "video"): AtlasCatalogRow[] {
  const rows = new Map<string, AtlasCatalogRow>();

  for (const model of searchAtlasModels({ media })) {
    const siblings = atlasVariants(model);
    const ids = Object.values(siblings).map((sibling) => sibling.id);
    const key = ids.length > 1 ? [...ids].sort()[0] : model.id;
    const existing = rows.get(key);
    if (existing) {
      // Keep the cheapest representative, and remember every shape offered.
      if ((model.basePrice ?? Infinity) < (existing.basePrice ?? Infinity)) {
        existing.model = siblings.text ?? model;
        existing.basePrice = model.basePrice;
      }
      continue;
    }

    const variants = (["text", "image", "reference"] as const).filter(
      (variant) => siblings[variant],
    );
    rows.set(key, {
      key,
      model: siblings.text ?? model,
      label: familyLabel(model, variants.length > 1),
      variants,
      vendor: atlasVendorLabel(model.organization),
      basePrice: model.basePrice,
    });
  }

  return [...rows.values()];
}

/** Vendors present for a media type, with how many models each has. */
export function atlasVendors(media: "image" | "video"): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of atlasCatalogRows(media)) {
    counts.set(row.vendor, (counts.get(row.vendor) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Image modes: the picker's second level for stills
// ---------------------------------------------------------------------------

/**
 * What a still-image model starts from.
 *
 * Video needs no such split: a family's text, first-frame and reference
 * endpoints are one row, and the form routes between them by what is
 * attached. Atlas's image models mostly come in pairs it does not route
 * between — "Seedream v5.0 Pro Text-to-Image" and "Seedream v5.0 Pro Edit" are
 * two rows, and only the second has a slot for pictures (64 and 65 of the 136
 * rows on 2026-10-30). So for stills the choice is real, and the picker splits
 * the list by it.
 */
export type AtlasImageMode = "text" | "image" | "tool";

export const ATLAS_IMAGE_MODES: readonly {
  id: AtlasImageMode;
  label: string;
  /** The count line under the list: "64 text-to-image models". */
  noun: string;
  /** What the tab holds, for its tooltip and the line under the list. */
  hint: string;
}[] = [
  {
    id: "text",
    label: "Text to image",
    noun: "text-to-image model",
    hint: "Models that draw from the prompt alone; some also take optional references",
  },
  {
    id: "image",
    label: "Image to image",
    noun: "image-to-image model",
    hint: "Models that edit, restyle or combine the images you attach",
  },
  {
    id: "tool",
    label: "Tools",
    noun: "tool",
    hint: "Upscaling, clean-up, background removal, layer splitting and Atlas Studio apps",
  },
];

/**
 * Utilities rather than generators. Atlas files only two of them under
 * IMAGE-TOOLS; the upscaler from Tencent, Midjourney's background removal and
 * Seedream's layer split sit under IMAGE-TO-IMAGE, and the Studio apps under
 * no category at all.
 */
const IMAGE_TOOL =
  /upscal|remove-background|layer-decomposition|photo-cleanup|^atlascloud\/studio\//i;

/**
 * The tabs a row belongs to; empty for video. A model that draws from text
 * and also takes pictures — Nano Banana 2.1 with its reference endpoint,
 * Midjourney V8, Flux Dev with an init image and mask — is in both, so each
 * tab holds every model that can do that job.
 */
export function atlasImageModes(
  row: Pick<AtlasCatalogRow, "model" | "variants">,
): AtlasImageMode[] {
  const { model } = row;
  if (model.media !== "image") return [];
  if (model.categories.includes("IMAGE-TOOLS") || IMAGE_TOOL.test(model.id)) return ["tool"];
  const modes: AtlasImageMode[] = [];
  if (model.categories.includes("TEXT-TO-IMAGE") || row.variants.includes("text")) {
    modes.push("text");
  }
  if (
    model.categories.includes("IMAGE-TO-IMAGE") ||
    row.variants.some((variant) => variant !== "text") ||
    atlasFamilyMaxReferences(model) > 0
  ) {
    modes.push("image");
  }
  return modes.length > 0 ? modes : ["text"];
}

export function isAtlasImageMode(value: unknown): value is AtlasImageMode {
  return ATLAS_IMAGE_MODES.some((mode) => mode.id === value);
}

/** Free-text match over everything shown on a row. */
export function matchesAtlasQuery(row: AtlasCatalogRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${row.label} ${row.model.id} ${row.vendor} ${row.model.family}`
    .toLowerCase()
    .includes(needle);
}
