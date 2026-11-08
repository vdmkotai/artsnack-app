/**
 * Shapes for talking to the Higgsfield worker, and the tolerant readers that
 * interpret what the CLI hands back.
 *
 * Higgsfield does not publish a schema for its job payloads — the CLI is the
 * only description that exists. Rather than pin field names we cannot verify,
 * the readers below search the response for the values we need. That costs a
 * little precision and buys resilience: a renamed wrapper field does not take
 * generation down.
 */

import { getApiModel, higgsfieldVideoModel, type ApiModelId, type MediaType } from "./api-models";

export type WorkerRequest = {
  credentials: string;
  workspaceId?: string;
  model?: string;
  params?: Record<string, string | number | boolean>;
  referenceUrls?: string[];
  mediaFlags?: string[];
  jobId?: string;
};

export type WorkerResponse = {
  /** Present only when the CLI rotated the token; persist it when it is. */
  credentials?: string | null;
  job?: unknown;
  cost?: unknown;
  account?: unknown;
  model?: unknown;
  error?: string;
  detail?: unknown;
};

/** Terminal states that mean the job produced something. */
const SUCCESS_STATES = ["completed", "complete", "done", "succeeded", "success", "finished", "ok"];

/**
 * Terminal states that mean the job was refused on content grounds.
 *
 * Kept apart from the rest because the verdict is worth showing: the tile has a
 * "Rejected by moderation" headline for it, and a moderation refusal is not
 * billed, so classifying it correctly is also what stops a rejected prompt from
 * holding an invented credit charge.
 *
 * `nsfw` is the one their CLI actually uses — it ships as a bare string constant
 * with no matching JSON field, alongside `queued`, `failed` and `completed`, and
 * the CLI's own wording ("job ended in a non-completed terminal status") says
 * plainly that `completed` is not the only terminal state. The rest are the
 * usual spellings, cheap to carry and harmless if never seen.
 */
const MODERATION_STATES = [
  "nsfw",
  "moderated",
  "moderation",
  "content_moderated",
  "content_moderation",
  "blocked",
  "banned",
  "declined",
  "refused",
  "violation",
];

/** Terminal states that mean it never will. */
const FAILURE_STATES = [
  "failed",
  "failure",
  "error",
  "canceled",
  "cancelled",
  "rejected",
  "expired",
  "killed",
  ...MODERATION_STATES,
];

/** Depth-first walk that reports the key path, so callers can tell an echoed
 *  input apart from a produced output. */
function walk(
  value: unknown,
  visit: (key: string, value: unknown, path: string[]) => void,
  path: string[] = [],
): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, path);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      visit(key, child, path);
      walk(child, visit, [...path, key]);
    }
  }
}

function collect<T>(payload: unknown, key: string, ofType: "string" | "number"): T[] {
  const found: T[] = [];
  walk(payload, (candidate, value) => {
    if (candidate === key && typeof value === ofType && value !== "") found.push(value as T);
  });
  return found;
}

/**
 * First value under the earliest key in `keys` that appears anywhere.
 *
 * The list is a priority order, not a set: `job_set_id` must win over a nested
 * `id`, so each key gets its own full pass rather than one pass matching any.
 */
export function findString(payload: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const [first] = collect<string>(payload, key, "string");
    if (first !== undefined) return first;
  }
  return undefined;
}

export function findNumber(payload: unknown, keys: string[]): number | undefined {
  for (const key of keys) {
    const [first] = collect<number>(payload, key, "number");
    if (first !== undefined) return first;
  }
  return undefined;
}

/** Keys whose subtree holds what went *in*, not what came out. */
const INPUT_PATH_KEYS = [
  "medias",
  "media",
  "inputs",
  "input",
  "params",
  "request",
  "reference",
  "references",
  "image_references",
  "video_references",
  "audio_references",
  "start_image",
  "end_image",
  "preview",
  "thumbnail",
  "thumb",
  "poster",
  "avatar",
  "cover",
];

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "avif"];
const VIDEO_EXTENSIONS = ["mp4", "mov", "webm", "m4v"];

function extensionOf(url: string): string | undefined {
  return (url.split("?")[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1]?.toLowerCase();
}

/**
 * Media the job produced.
 *
 * Job payloads echo their inputs, so a naive sweep for anything called `url`
 * returns the reference image and the thumbnail alongside the real output —
 * and the first of those is what would get saved. Anything sitting under an
 * input-shaped key is dropped, and when the expected media type is known the
 * extension has to agree with it.
 */
export function findMediaUrls(payload: unknown, mediaType?: MediaType): string[] {
  const urls: string[] = [];
  walk(payload, (key, value, path) => {
    if (typeof value !== "string" || !/^https?:\/\//.test(value)) return;
    if (key !== "url" && key !== "result_url" && key !== "media_url") return;
    if (path.some((segment) => INPUT_PATH_KEYS.includes(segment))) return;
    if (INPUT_PATH_KEYS.includes(key)) return;

    if (mediaType) {
      const extension = extensionOf(value);
      const allowed = mediaType === "video" ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
      const rejected = mediaType === "video" ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
      // An unknown extension is kept: signed CDN links often carry none.
      if (extension && !allowed.includes(extension) && rejected.includes(extension)) return;
    }
    urls.push(value);
  });
  return [...new Set(urls)];
}

/**
 * Job identifier.
 *
 * `generate create` without `--wait` prints ids rather than job objects, and
 * the CLI documents no shape for that, so a bare string and an array of
 * strings both have to be understood.
 */
export function jobIdOf(payload: unknown): string | undefined {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const id = jobIdOf(item);
      if (id) return id;
    }
    return undefined;
  }
  return findString(payload, ["job_set_id", "job_id", "id"]);
}

export type JobState = "pending" | "succeeded" | "failed";

/**
 * Every status word in a job payload, lowercased.
 *
 * Exported because "we never recognised what they said" is otherwise invisible:
 * an unknown status reads as still-running, so the job polls out its deadline
 * and reports a timeout, which is the one description guaranteed to be wrong.
 * The poll loop keeps the last of these and names it in that message, so the
 * next unrecognised state costs one line to support rather than an afternoon.
 */
export function jobStatusesOf(payload: unknown): string[] {
  return [
    ...collect<string>(payload, "job_status", "string"),
    ...collect<string>(payload, "status", "string"),
  ].map((status) => status.toLowerCase());
}

/**
 * State of a job set.
 *
 * Higgsfield's unit of work is a set, so several statuses can be present at
 * once. One failed leg makes the whole thing a failure — reporting success
 * there would mean saving a partial result and charging for it silently.
 */
export function jobStateOf(payload: unknown): JobState {
  const statuses = jobStatusesOf(payload);

  if (statuses.length === 0) return "pending";
  if (statuses.some((status) => FAILURE_STATES.includes(status))) return "failed";
  // Unknown statuses read as still-running, never as done.
  return statuses.every((status) => SUCCESS_STATES.includes(status)) ? "succeeded" : "pending";
}

/**
 * Whether a refusal was on content grounds, so the failure can be labelled and
 * priced as one: moderation is a fatal kind, which zeroes the pre-flight charge.
 */
export function isModerationState(statuses: string[]): boolean {
  return statuses.some((status) => MODERATION_STATES.includes(status));
}

export function creditsOf(payload: unknown): number | undefined {
  return findNumber(payload, ["credits_exact", "credits", "cost", "amount"]);
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

export type HiggsfieldJobInput = {
  model: ApiModelId;
  mediaType: MediaType;
  prompt: string;
  aspectRatio?: string;
  /** `quality` or `resolution` value for images, depending on the model. */
  sizeTier?: string;
  /** Which Higgsfield video model — they are not interchangeable. */
  videoJobType?: string;
  durationSeconds?: number;
  resolution?: string;
  /** Seedance `mode` (std/fast) or Kling `mode` (std/pro/4k). */
  mode?: string;
  generateAudio?: boolean;
  referenceCount?: number;
};

export type HiggsfieldJobRequest = {
  jobType: string;
  params: Record<string, string | number | boolean>;
  /**
   * CLI flags for the references, in order.
   *
   * A single entry means every reference goes under that flag — which is right
   * for `image-references` and wrong for frame slots, since `start_image`
   * accepts exactly one media input. Frame models therefore list their slots
   * and each reference takes the next one.
   */
  mediaFlags: string[];
};

/**
 * Builds the CLI invocation for a generation.
 *
 * Only parameters named in Higgsfield's own skill documentation are sent. An
 * undeclared param is rejected outright by their API, so the safe move is to
 * pass what is documented and let the model default everything else.
 */
export function buildHiggsfieldJob(input: HiggsfieldJobInput): HiggsfieldJobRequest {
  const model = getApiModel(input.model);
  if (model.provider !== "higgsfield") {
    throw new Error(`${input.model} is not a Higgsfield model`);
  }

  if (input.mediaType === "video") {
    const caps = model.video;
    if (caps.kind !== "higgsfield-video") throw new Error(`${input.model} has no video job type`);
    const video = higgsfieldVideoModel(caps, input.videoJobType);

    const duration = input.durationSeconds ?? caps.defaultDuration;
    // The selected model's lengths, not the union across all of them.
    if (!video.durations.includes(duration)) {
      throw new Error(`${video.label} does not support ${duration}s clips`);
    }

    const params: Record<string, string | number | boolean> = {
      prompt: input.prompt,
      // Integer here, unlike fal, where the very same model wants a string.
      duration,
    };

    // Kling exposes no resolution parameter at all; sending one is an error.
    if (video.resolutions.length > 0) {
      const resolution = input.resolution ?? video.defaultResolution;
      if (!video.resolutions.includes(resolution)) {
        throw new Error(`${video.label} does not support ${resolution}`);
      }
      params.resolution = resolution;
    }

    // "auto" is a real value here, unlike on the image side — but only for the
    // models whose enum actually lists it.
    if (input.aspectRatio) {
      if (!video.aspectRatios.includes(input.aspectRatio)) {
        throw new Error(`${video.label} does not support ${input.aspectRatio}`);
      }
      params.aspect_ratio = input.aspectRatio;
    } else if (video.aspectRatios.includes("auto")) {
      // Every schema defaults to 16:9, so leaving this out would crop a
      // portrait start frame. "auto" is the value that means "use the frame".
      params.aspect_ratio = "auto";
    }

    if (video.modeParam) {
      const mode = input.mode ?? video.modeParam.default;
      if (!video.modeParam.values.includes(mode)) {
        throw new Error(`${video.label} does not support mode ${mode}`);
      }
      // Their rule: Seedance fast is 480p/720p only.
      if (mode === "fast" && typeof params.resolution === "string") {
        if (!["480p", "720p"].includes(params.resolution)) {
          throw new Error(`Fast mode supports 480p and 720p only`);
        }
      }
      params[video.modeParam.name] = mode;
    }

    if (video.audioParam && input.generateAudio !== undefined) {
      params[video.audioParam.name] =
        video.audioParam.kind === "boolean"
          ? input.generateAudio
          : input.generateAudio
            ? "on"
            : "off";
    }

    return {
      jobType: video.jobType,
      params,
      // Only the Seedance pair takes a reference list. The rest have discrete
      // frame slots, and each accepts exactly one media input — repeating
      // --start-image is rejected outright.
      mediaFlags: video.supportsReferences
        ? ["image-references"]
        : video.supportsEndFrame
          ? ["start-image", "end-image"]
          : ["start-image"],
    };
  }

  const caps = model.image;
  if (caps.kind !== "higgsfield-image") throw new Error(`${input.model} has no image job type`);

  const params: Record<string, string | number | boolean> = { prompt: input.prompt };
  // Their image enum has no "auto" — omitting the parameter is how you get the
  // model's own default.
  if (input.aspectRatio && input.aspectRatio !== "auto") {
    if (!caps.aspectRatios.includes(input.aspectRatio)) {
      throw new Error(`${model.label} does not support ${input.aspectRatio}`);
    }
    params.aspect_ratio = input.aspectRatio;
  }
  // 4.5 and Lite size by `quality`, Pro by `resolution`; sending the other name
  // is an unknown-param rejection.
  const sizeTier = input.sizeTier ?? caps.defaultSizeTier;
  if (caps.sizeTiers.some((tier) => tier.value === sizeTier)) {
    params[caps.sizeParam] = sizeTier;
  }

  return { jobType: caps.jobType, params, mediaFlags: [caps.mediaFlag] };
}

/**
 * Parameters that carry no price.
 *
 * Measured against `higgsfield generate cost`: every aspect ratio of the same
 * model, duration and resolution quotes identically, and attaching a start
 * frame changes nothing either. Folding them into the key would split one price
 * across two dozen entries, and each new entry is an ellipsis on the button
 * until its own round trip lands — for a number already known.
 */
const FREE_PARAMS = new Set(["prompt", "aspect_ratio", "seed", "enhance_prompt"]);

/** Stable key for caching a credit quote: same settings, same signature. */
export function costSignature(request: HiggsfieldJobRequest): string {
  const params = Object.keys(request.params)
    .filter((key) => !FREE_PARAMS.has(key))
    .sort()
    .map((key) => `${key}=${request.params[key]}`)
    .join(",");
  return `${request.jobType}|${params}`;
}
