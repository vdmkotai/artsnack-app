/**
 * Grok Imagine requests: what a form's settings mean on the wire.
 *
 * The registry (api-models.ts) says which controls exist. This module says what
 * a combination of them asks xAI for — which model, which endpoint, which
 * attached image fills which slot — and refuses the combinations xAI documents
 * as illegal. Everything is pure and JSON-in, JSON-out, because four places run
 * it: the web form, the Convex mutation that validates a click, the processor
 * that builds the request, and the native macOS client through QuickJS.
 *
 * Sources: docs.x.ai (read 2026-10-24) — video overview, generation,
 * reference-to-video, editing, extension; the REST reference for
 * /v1/videos/{generations,edits,extensions} and /v1/images/{generations,edits};
 * the grok-imagine-image-quality retirement notice; the models page's rate card.
 */

import {
  GROK_IMAGE_MODEL_QUALITY,
  GROK_IMAGE_MODEL_STANDARD,
  GROK_IMAGE_MODEL_V2,
  GROK_VIDEO_EDIT_MAX_SOURCE_SECONDS,
  GROK_VIDEO_EXTEND_SOURCE_SECONDS,
  GROK_VIDEO_MODEL_BASE,
  GROK_VIDEO_MODEL_LITE,
  GROK_VIDEO_MODEL_V15,
  getApiModel,
  grokVideoModelSpec,
  isGrokImageQuality,
  isGrokVideoMode,
  videoResolutions,
  type GrokVideoCaps,
  type GrokVideoContext,
  type GrokVideoMode,
  type GrokVideoModelId,
} from "./api-models";
import { getGrokReferenceTagIndices, toGrokApiPrompt, toGrokApiPromptMapped } from "./grok-prompt";
import { isGrokSourceVideoKey } from "./image-key";

/** The Grok entry's video caps. The registry is static, so this cannot fail. */
export function grokVideoCaps(): GrokVideoCaps {
  const caps = getApiModel("grok").video;
  if (caps.kind !== "grok") throw new Error("The grok registry entry lost its video caps");
  return caps;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export type GrokImageQualityParam = "low" | "medium" | "auto";

/**
 * The registry's quality value → what the request actually says. The two
 * legacy values pick a model; the three v2 values share one model and differ in
 * its `quality` field (which the legacy models ignore, so it is only sent when
 * set here). Unknown or absent values fall back to the legacy Quality model,
 * matching what rows written before the switch existed have always meant.
 *
 * `auto` is sent explicitly rather than omitted, although omitting it means
 * the same today: the docs list it as an allowed value, and a default can move.
 */
export function grokImageRequestFor(quality: string | undefined): {
  model: string;
  quality?: GrokImageQualityParam;
} {
  switch (quality) {
    case "standard":
      return { model: GROK_IMAGE_MODEL_STANDARD };
    case "v2-low":
      return { model: GROK_IMAGE_MODEL_V2, quality: "low" };
    case "v2-medium":
      return { model: GROK_IMAGE_MODEL_V2, quality: "medium" };
    case "v2-auto":
      return { model: GROK_IMAGE_MODEL_V2, quality: "auto" };
    default:
      return { model: GROK_IMAGE_MODEL_QUALITY };
  }
}

/**
 * Which Grok image model a row ran on, for the tile badge and the details
 * panel: the form's label ("2.0 Low"), the slug and `quality` it sent, and for
 * 2.0 Auto the quality xAI documents serving — low for a generation, medium
 * for an edit. A row without a known quality ran on the legacy Quality model,
 * the same fallback `grokImageRequestFor` applies.
 */
export function grokImageModelOf(input: { quality?: string; referenceCount: number }): {
  label: string;
  model: string;
  quality?: GrokImageQualityParam;
  served?: "low" | "medium";
} {
  const value = isGrokImageQuality(input.quality) ? input.quality : "quality";
  const caps = getApiModel("grok").image;
  const label =
    (caps.kind === "grok" && caps.qualities.find((entry) => entry.value === value)?.label) || value;
  const request = grokImageRequestFor(value);
  return {
    label,
    ...request,
    ...(value === "v2-auto" ? { served: input.referenceCount > 0 ? "medium" : "low" } : {}),
  };
}

export type GrokImageRequest = {
  path: "images/generations" | "images/edits";
  body: Record<string, unknown>;
  /** Requests to send. The edit endpoint takes no `n`, so an edit batch is
   *  that many identical requests; a generation is one request with `n`. */
  requests: number;
};

/** The request body for an image job, exactly as the processor sends it. */
export function buildGrokImageRequest(input: {
  quality?: string;
  prompt: string;
  /** "1k" / "2k". */
  resolution: string;
  count: number;
  aspectRatio?: string;
  /** Data or public URLs, in the order the prompt's @imageN tags count them. */
  imageUrls: readonly string[];
}): GrokImageRequest {
  const request = grokImageRequestFor(input.quality);
  const isEdit = input.imageUrls.length > 0;
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: toGrokApiPrompt(input.prompt),
    resolution: input.resolution,
    response_format: "b64_json",
  };
  if (request.quality) body.quality = request.quality;
  if (input.imageUrls.length === 1) {
    body.image = { url: input.imageUrls[0] };
  } else if (input.imageUrls.length > 1) {
    body.images = input.imageUrls.map((url) => ({ url }));
  } else {
    body.n = input.count;
    body.aspect_ratio = input.aspectRatio ?? "auto";
  }
  // Edits default to the first source's ratio, but both single- and
  // multi-image edits can override it.
  if (isEdit && input.aspectRatio && input.aspectRatio !== "auto") {
    body.aspect_ratio = input.aspectRatio;
  }
  return {
    path: isEdit ? "images/edits" : "images/generations",
    body,
    requests: isEdit ? Math.max(1, input.count) : 1,
  };
}

// ---------------------------------------------------------------------------
// Video: what each attached image does
// ---------------------------------------------------------------------------

/**
 * What one attached image is on 1.5.
 *
 * - `reference` — a look, product or character, without fixing any frame.
 * - `first` / `last` — the exact opening or closing frame (`image`, `last_frame`).
 * - `loop` — both: xAI's documented way to make a loop is the same image as
 *   `image` and `last_frame`, and one image can only hold one role here.
 * - `keyframe` — passes through this exact image at `at` seconds.
 */
export const GROK_FRAME_ROLE_NAMES = ["reference", "first", "last", "loop", "keyframe"] as const;
export type GrokFrameRoleName = (typeof GROK_FRAME_ROLE_NAMES)[number];
export type GrokFrameRole = { role: GrokFrameRoleName; at?: number };

/** The role menu, in display order, with the badge a thumbnail shows. */
export const GROK_FRAME_ROLE_CHOICES: readonly {
  role: GrokFrameRoleName;
  label: string;
  badge: string;
  hint: string;
}[] = [
  {
    role: "reference",
    label: "Reference",
    badge: "Ref",
    hint: "Guides the look or a character without fixing a frame; tag it @imageN",
  },
  { role: "first", label: "First frame", badge: "First", hint: "The clip starts on this image" },
  { role: "last", label: "Last frame", badge: "Last", hint: "The clip ends on this image" },
  {
    role: "loop",
    label: "First & last",
    badge: "Loop",
    hint: "The clip starts and ends on this image",
  },
  {
    role: "keyframe",
    label: "Keyframe",
    badge: "Key",
    hint: "The clip passes through this exact image at the time you set",
  },
];

/** The badge a thumbnail shows: its @image number and, on 1.5, its role. */
export function grokRoleBadge(role: GrokFrameRole, position: number): string {
  const choice = GROK_FRAME_ROLE_CHOICES.find((entry) => entry.role === role.role);
  if (!choice) return `${position}`;
  return role.role === "keyframe" && role.at !== undefined
    ? `${position} · ${choice.badge} ${role.at}s`
    : `${position} · ${choice.badge}`;
}

/** Keyframes snap to a 1/3-second grid; two on the same slot are refused. */
export const GROK_KEYFRAME_SLOTS_PER_SECOND = 3;

/** Shape-checks one stored role; anything malformed reads as "automatic". */
export function parseGrokFrameRole(value: unknown): GrokFrameRole | null {
  if (!value || typeof value !== "object") return null;
  const { role, at } = value as { role?: unknown; at?: unknown };
  if (!GROK_FRAME_ROLE_NAMES.includes(role as GrokFrameRoleName)) return null;
  if (role !== "keyframe") return { role: role as GrokFrameRoleName };
  return {
    role: "keyframe",
    at: typeof at === "number" && Number.isFinite(at) ? at : 1,
  };
}

/** A persisted role list, with every entry either a legal role or null. */
export function sanitizeGrokFrameRoles(value: unknown): (GrokFrameRole | null)[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).map(parseGrokFrameRole);
}

/**
 * Roles follow their image, not its position, when the selection changes —
 * the same thing Atlas does for its per-reference details. Deselecting the
 * first of three must not promote the second into the first frame.
 */
export function remapGrokFrameRoles(
  roles: readonly (GrokFrameRole | null | undefined)[],
  previousIds: readonly string[],
  nextIds: readonly string[],
): (GrokFrameRole | null)[] {
  return nextIds.map((id) => {
    const index = previousIds.indexOf(id);
    return index >= 0 ? (roles[index] ?? null) : null;
  });
}

/**
 * The role every selected image actually plays.
 *
 * An image with no explicit role keeps the rule the app has always had: a lone
 * image is the first frame (image-to-video), two or more are references. So a
 * row or a client that never heard of roles gets exactly what it got before.
 */
export function resolveGrokFrameRoles(
  roles: readonly (GrokFrameRole | null | undefined)[] | undefined,
  referenceCount: number,
): GrokFrameRole[] {
  return Array.from({ length: Math.max(0, referenceCount) }, (_, index) => {
    const explicit = parseGrokFrameRole(roles?.[index]);
    if (explicit) return explicit;
    return { role: referenceCount === 1 ? "first" : "reference" } as GrokFrameRole;
  });
}

/**
 * The role list after the person picks `role` for the image at `index`.
 *
 * Every image's current role is written out explicitly first, so setting one
 * image never silently re-reads the others through the automatic rule. A pin
 * that is now taken twice gives way on the other image — choosing First on
 * image 2 turns image 1's First into a reference — and a loop that loses one
 * end keeps the other. A new keyframe lands on a free slot mid-clip.
 */
export function withGrokFrameRole(
  roles: readonly (GrokFrameRole | null | undefined)[],
  referenceCount: number,
  index: number,
  role: GrokFrameRoleName,
  duration: number,
): GrokFrameRole[] {
  const next = resolveGrokFrameRoles(roles, referenceCount).map((entry) => ({ ...entry }));
  if (index < 0 || index >= next.length) return next;
  const takesFirst = role === "first" || role === "loop";
  const takesLast = role === "last" || role === "loop";
  next.forEach((entry, other) => {
    if (other === index) return;
    const isFirst = entry.role === "first" || entry.role === "loop";
    const isLast = entry.role === "last" || entry.role === "loop";
    const losesFirst = takesFirst && isFirst;
    const losesLast = takesLast && isLast;
    if (!losesFirst && !losesLast) return;
    if (entry.role === "loop" && losesFirst !== losesLast) {
      next[other] = { role: losesFirst ? "last" : "first" };
    } else {
      next[other] = { role: "reference" };
    }
  });
  if (role === "keyframe") {
    const current = next[index];
    const taken = next
      .filter((entry, other) => other !== index && entry.role === "keyframe")
      .map((entry) => entry.at ?? 0);
    next[index] =
      current.role === "keyframe" && current.at !== undefined
        ? current
        : { role: "keyframe", at: defaultKeyframeTime(duration, taken) };
  } else {
    next[index] = { role };
  }
  return next;
}

/** The role list with one keyframe moved to `at` seconds, kept inside the clip. */
export function withGrokKeyframeTime(
  roles: readonly (GrokFrameRole | null | undefined)[],
  referenceCount: number,
  index: number,
  at: number,
  duration: number,
): GrokFrameRole[] {
  const next = resolveGrokFrameRoles(roles, referenceCount).map((entry) => ({ ...entry }));
  if (next[index]?.role !== "keyframe" || !Number.isFinite(at)) return next;
  next[index] = { role: "keyframe", at: clampKeyframeTime(at, duration) };
  return next;
}

/** A keyframe time that is free and strictly inside the clip, for a new pin. */
export function defaultKeyframeTime(duration: number, taken: readonly number[]): number {
  const slots = Math.max(1, Math.round(duration * GROK_KEYFRAME_SLOTS_PER_SECOND));
  const used = new Set(taken.map((at) => Math.round(at * GROK_KEYFRAME_SLOTS_PER_SECOND)));
  const middle = Math.round(slots / 2);
  // Outward from the middle, so the first pin lands mid-clip.
  for (let offset = 0; offset < slots; offset++) {
    for (const slot of [middle + offset, middle - offset]) {
      if (slot >= 1 && slot <= slots - 1 && !used.has(slot)) {
        return roundSeconds(slot / GROK_KEYFRAME_SLOTS_PER_SECOND);
      }
    }
  }
  return roundSeconds(Math.min(duration / 2, Math.max(0, duration - 1 / 3)));
}

/** A keyframe time pulled strictly inside a clip of `duration` seconds. */
export function clampKeyframeTime(at: number, duration: number): number {
  const min = 1 / GROK_KEYFRAME_SLOTS_PER_SECOND;
  const max = Math.max(min, duration - min);
  return roundSeconds(Math.min(max, Math.max(min, at)));
}

function roundSeconds(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Video: the plan
// ---------------------------------------------------------------------------

/** A source clip for Edit or Extend: a B2 key, and what the browser measured. */
export type GrokSourceVideo = {
  key: string;
  seconds: number;
  /** The output's resolution: the source's, capped at 720p. */
  resolution: "480p" | "720p";
};

/** What edit and extend return for a source of this size: its own, capped at 720p. */
export function grokSourceResolution(width: number, height: number): "480p" | "720p" {
  const shortSide = Math.min(width, height);
  return shortSide > 0 && shortSide <= 480 ? "480p" : "720p";
}

export function parseGrokSourceVideo(value: unknown): GrokSourceVideo | null {
  if (!value || typeof value !== "object") return null;
  const { key, seconds, resolution } = value as Partial<GrokSourceVideo>;
  if (typeof key !== "string" || !isGrokSourceVideoKey(key)) return null;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return { key, seconds, resolution: resolution === "480p" ? "480p" : "720p" };
}

/** Everything about a Grok video request the plan depends on — form or row. */
export type GrokVideoInput = {
  /** Absent ⇒ Generate. */
  mode?: string;
  /** Absent ⇒ 1.5. Ignored by Edit and Extend, which always run the base model. */
  model?: string;
  /** Selected images, in the order the prompt's @imageN tags count them. */
  referenceCount: number;
  /** One per selected image; null or absent is automatic. */
  frameRoles?: readonly (GrokFrameRole | null | undefined)[];
  voiceCount?: number;
  /** Generate: the clip's length. */
  duration?: number;
  /** Extend: the length added. */
  extendDuration?: number;
  /**
   * Edit and Extend: the clip, once chosen. `seconds` may be unknown;
   * `resolution` is the output's (the source's, capped at 720p).
   */
  source?: { seconds?: number; resolution?: string } | null;
  /** For the tag checks; omitted where no prompt is at hand. */
  prompt?: string;
};

/**
 * What xAI will treat the request as. `reference` is reference-to-video —
 * references, voices, a pinned last frame or keyframes — capped at 720p.
 */
export type GrokVideoKind = "text" | "image" | "reference" | "edit" | "extend";

export type GrokVideoPlan = {
  mode: GrokVideoMode;
  /** The model the request names. */
  model: string;
  /** The Generate-mode choice this plan was made for (1.5 on Edit/Extend). */
  modelChoice: GrokVideoModelId;
  path: "videos/generations" | "videos/edits" | "videos/extensions";
  kind: GrokVideoKind;
  /** The role each selected image plays; empty on Edit and Extend. */
  roles: GrokFrameRole[];
  /** Positions among the selected images, 0-based. */
  first: number | null;
  last: number | null;
  keyframes: { index: number; at: number }[];
  references: number[];
  /**
   * The `image N` each `@imageN` tag becomes (index = tag − 1). xAI numbers the
   * pinned first frame and then the references, so pinning an image renumbers
   * the rest; a last frame or keyframe has no number at all (null).
   */
  promptOrdinals: (number | null)[];
  /** Whether `aspect_ratio` is sent — not once a first frame fixes the shape. */
  usesAspectRatio: boolean;
  /** Whether a resolution is chosen; Edit and Extend follow the source. */
  usesResolution: boolean;
  /** Preset voices exist on 1.5's Generate only. */
  usesVoices: boolean;
  /** Per-image roles exist on 1.5's Generate only; Lite's one image is the first frame. */
  usesFrameRoles: boolean;
  /** Images the request carries, for the per-image price. */
  imageCount: number;
};

export function planGrokVideo(input: GrokVideoInput): GrokVideoPlan {
  const caps = grokVideoCaps();
  const mode: GrokVideoMode = isGrokVideoMode(input.mode) ? input.mode : "generate";
  const spec = grokVideoModelSpec(caps, input.model);
  const empty = {
    roles: [],
    first: null,
    last: null,
    keyframes: [],
    references: [],
    promptOrdinals: [],
    usesAspectRatio: false,
    usesResolution: false,
    usesVoices: false,
    usesFrameRoles: false,
    imageCount: 0,
  };
  if (mode === "edit") {
    return {
      ...empty,
      mode,
      model: GROK_VIDEO_MODEL_BASE,
      modelChoice: spec.id,
      path: "videos/edits",
      kind: "edit",
    };
  }
  if (mode === "extend") {
    return {
      ...empty,
      mode,
      model: GROK_VIDEO_MODEL_BASE,
      modelChoice: spec.id,
      path: "videos/extensions",
      kind: "extend",
    };
  }

  const count = Math.max(0, input.referenceCount);
  if (!spec.supportsReferenceToVideo) {
    // Lite: text-to-video, or one image as the first frame. Extra images are
    // reported by grokVideoIssues and never sent.
    const hasImage = count > 0;
    return {
      mode,
      model: spec.id,
      modelChoice: spec.id,
      path: "videos/generations",
      kind: hasImage ? "image" : "text",
      roles: Array.from({ length: count }, (_, index) =>
        index === 0 ? { role: "first" } : { role: "reference" },
      ),
      first: hasImage ? 0 : null,
      last: null,
      keyframes: [],
      references: [],
      promptOrdinals: Array.from({ length: count }, (_, index) => (index === 0 ? 1 : null)),
      usesAspectRatio: !hasImage,
      usesResolution: true,
      usesVoices: false,
      usesFrameRoles: false,
      imageCount: hasImage ? 1 : 0,
    };
  }

  const roles = resolveGrokFrameRoles(input.frameRoles, count);
  const firstIndex = roles.findIndex((entry) => entry.role === "first" || entry.role === "loop");
  const lastIndex = roles.findIndex((entry) => entry.role === "last" || entry.role === "loop");
  const first = firstIndex === -1 ? null : firstIndex;
  const last = lastIndex === -1 ? null : lastIndex;
  const keyframes = roles
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.role === "keyframe")
    .map(({ entry, index }) => ({ index, at: entry.at ?? 1 }))
    .sort((a, b) => a.at - b.at);
  const references = roles
    .map((entry, index) => (entry.role === "reference" ? index : -1))
    .filter((index) => index >= 0);
  const voiceCount = input.voiceCount ?? 0;
  const kind: GrokVideoKind =
    references.length > 0 || last !== null || keyframes.length > 0 || voiceCount > 0
      ? "reference"
      : first !== null
        ? "image"
        : "text";
  const offset = first === null ? 0 : 1;
  const promptOrdinals = roles.map((_, index) => {
    if (index === first) return 1;
    const position = references.indexOf(index);
    return position === -1 ? null : offset + position + 1;
  });
  return {
    mode,
    model: spec.id,
    modelChoice: spec.id,
    path: "videos/generations",
    kind,
    roles,
    first,
    last,
    keyframes,
    references,
    promptOrdinals,
    usesAspectRatio: first === null,
    usesResolution: true,
    usesVoices: true,
    usesFrameRoles: true,
    // Every role sends its image once: a loop is one image in two fields, but
    // it is still only one image of input.
    imageCount: count,
  };
}

/** The context the shared resolution lookup needs for this request. */
export function grokVideoContext(input: GrokVideoInput): GrokVideoContext {
  const plan = planGrokVideo(input);
  return { mode: plan.mode, model: plan.modelChoice, referenceToVideo: plan.kind === "reference" };
}

function formatSeconds(seconds: number): string {
  return `${Math.round(seconds * 10) / 10} s`;
}

/**
 * Every reason xAI would refuse this request, in words for the person who can
 * fix it. Empty means it can be sent. The form shows these, the submit button
 * refuses on them, and the mutation and the payload builder re-check — so a
 * client that skipped the first two still cannot queue a doomed job.
 */
export function grokVideoIssues(input: GrokVideoInput): string[] {
  const caps = grokVideoCaps();
  const plan = planGrokVideo(input);
  const issues: string[] = [];
  const tags = input.prompt ? getGrokReferenceTagIndices(input.prompt) : [];

  if (plan.mode === "edit" || plan.mode === "extend") {
    const label = plan.mode === "edit" ? "Edit" : "Extend";
    const seconds = input.source?.seconds;
    if (!input.source) {
      issues.push(`${label} needs a source video — use one of your clips or upload an mp4.`);
    } else if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
      // Without a length the limits below cannot be checked, and xAI refuses an
      // out-of-range clip only after the request is paid for.
      issues.push(`The source video's length is unknown — set the clip again.`);
    } else {
      // Exact: the lengths are measured to 0.01 s, and xAI documents the limits.
      if (plan.mode === "edit" && seconds > GROK_VIDEO_EDIT_MAX_SOURCE_SECONDS) {
        issues.push(
          `Edit takes a clip of at most ${GROK_VIDEO_EDIT_MAX_SOURCE_SECONDS} s — this one is ${formatSeconds(seconds)}.`,
        );
      }
      if (
        plan.mode === "extend" &&
        (seconds < GROK_VIDEO_EXTEND_SOURCE_SECONDS.min ||
          seconds > GROK_VIDEO_EXTEND_SOURCE_SECONDS.max)
      ) {
        issues.push(
          `Extend takes a clip of ${GROK_VIDEO_EXTEND_SOURCE_SECONDS.min}–${GROK_VIDEO_EXTEND_SOURCE_SECONDS.max} s — this one is ${formatSeconds(seconds)}.`,
        );
      }
    }
    if (plan.mode === "extend") {
      const extension = input.extendDuration ?? caps.defaultExtendDuration;
      if (!caps.extendDurations.includes(extension)) {
        issues.push(
          `An extension is ${caps.extendDurations[0]}–${caps.extendDurations[caps.extendDurations.length - 1]} s long.`,
        );
      }
    }
    if (tags.length > 0) {
      issues.push(`${label} takes no images, so @image${tags[0]} has nothing to point at.`);
    }
    return issues;
  }

  const spec = grokVideoModelSpec(caps, input.model);
  const duration = input.duration ?? caps.defaultDuration;
  if (!caps.durations.includes(duration)) {
    issues.push(
      `Grok video is ${caps.durations[0]}–${caps.durations[caps.durations.length - 1]} s long, in whole seconds.`,
    );
  }
  if (input.referenceCount > spec.maxImages) {
    const extra = input.referenceCount - spec.maxImages;
    issues.push(
      spec.supportsReferenceToVideo
        ? `${spec.label} takes up to ${spec.maxImages} images — deselect ${extra}.`
        : `${spec.label} animates one start image and takes no references — deselect ${extra}.`,
    );
  }
  if (!spec.supportsReferenceToVideo) return issues;

  const firsts = plan.roles.filter((entry) => entry.role === "first" || entry.role === "loop");
  const lasts = plan.roles.filter((entry) => entry.role === "last" || entry.role === "loop");
  if (firsts.length > 1) issues.push("Only one image can be the first frame.");
  if (lasts.length > 1) issues.push("Only one image can be the last frame.");
  if (plan.keyframes.length > caps.maxKeyframes) {
    issues.push(`At most ${caps.maxKeyframes} keyframes — this has ${plan.keyframes.length}.`);
  }
  const slots = new Map<number, number>();
  const lastSlot = Math.round(duration * GROK_KEYFRAME_SLOTS_PER_SECOND) - 1;
  for (const keyframe of plan.keyframes) {
    const slot = Math.round(keyframe.at * GROK_KEYFRAME_SLOTS_PER_SECOND);
    if (slot < 1 || slot > lastSlot) {
      issues.push(
        `The keyframe at ${formatSeconds(keyframe.at)} must fall strictly inside the ${formatSeconds(duration)} clip.`,
      );
    } else if (slots.has(slot)) {
      issues.push(
        `Keyframes at ${formatSeconds(slots.get(slot)!)} and ${formatSeconds(keyframe.at)} land on the same 1/3-second slot — keep them at least 1/3 s apart.`,
      );
    } else {
      slots.set(slot, keyframe.at);
    }
  }
  for (const tag of new Set(tags)) {
    if (tag < 1 || tag > plan.roles.length) continue;
    if (plan.promptOrdinals[tag - 1] === null) {
      const role = plan.roles[tag - 1].role === "last" ? "last frame" : "a keyframe";
      issues.push(
        `@image${tag} is pinned as the ${role}; only the first frame and reference images can be named in the prompt.`,
      );
    }
  }
  return issues;
}

/** What the Grok video form shows for this request. */
export type GrokVideoOptions = {
  plan: GrokVideoPlan;
  modes: readonly { value: GrokVideoMode; label: string }[];
  /** The Generate model choice; null on Edit and Extend, which have none. */
  models: readonly { id: GrokVideoModelId; label: string; note: string }[] | null;
  /** Lengths for the visible duration control, and which form field it sets. */
  durations: readonly number[];
  durationField: "duration" | "grokExtendDuration" | null;
  resolutions: readonly string[];
  /** Null hides the control: a pinned first frame or a source clip sets the shape. */
  aspectRatios: readonly string[] | null;
  /**
   * With a pinned first frame, the shapes its picture can be cropped to before
   * it is sent ("auto" keeps it as it is) — see `grokFrameCrops`. Null when no
   * first frame is pinned.
   */
  frameAspectRatios: readonly string[] | null;
  /** Null hides the voice picker. */
  voices: readonly string[] | null;
  maxVoices: number;
  /** Images the mode takes; 0 hides the image strip. */
  maxImages: number;
  /** The per-image role menu, or null where positions are fixed (Lite). */
  frameRoleChoices: typeof GROK_FRAME_ROLE_CHOICES | null;
  /** Edit and Extend need a clip, and say how long it may be. */
  source: { min: number; max: number } | null;
  issues: string[];
};

export function grokVideoOptions(input: GrokVideoInput): GrokVideoOptions {
  const caps = grokVideoCaps();
  const plan = planGrokVideo(input);
  const spec = grokVideoModelSpec(caps, input.model);
  const generate = plan.mode === "generate";
  return {
    plan,
    modes: caps.modes,
    models: generate
      ? caps.models.map((entry) => ({ id: entry.id, label: entry.label, note: entry.note }))
      : null,
    durations: generate ? caps.durations : plan.mode === "extend" ? caps.extendDurations : [],
    durationField: generate ? "duration" : plan.mode === "extend" ? "grokExtendDuration" : null,
    resolutions: videoResolutions(
      caps,
      undefined,
      undefined,
      undefined,
      input.referenceCount,
      input.voiceCount,
      grokVideoContext(input),
    ),
    aspectRatios: plan.usesAspectRatio ? caps.aspectRatios : null,
    frameAspectRatios: generate && plan.first !== null ? grokFrameAspectRatios() : null,
    voices: plan.usesVoices ? caps.voices : null,
    maxVoices: caps.maxVoices,
    maxImages: generate ? spec.maxImages : 0,
    frameRoleChoices: plan.usesFrameRoles ? GROK_FRAME_ROLE_CHOICES : null,
    source:
      plan.mode === "edit"
        ? { min: 0, max: GROK_VIDEO_EDIT_MAX_SOURCE_SECONDS }
        : plan.mode === "extend"
          ? { ...GROK_VIDEO_EXTEND_SOURCE_SECONDS }
          : null,
    issues: grokVideoIssues(input),
  };
}

/**
 * Shapes a pinned first frame can be cropped to: "auto" (as it is), then every
 * ratio the model takes.
 */
export function grokFrameAspectRatios(): readonly string[] {
  return ["auto", ...grokVideoCaps().aspectRatios];
}

/**
 * The ratio each selected image is centre-cropped to before it is uploaded, or
 * null to send it as it is — by position, like the roles.
 *
 * xAI ignores `aspect_ratio` once a first frame is pinned; the clip takes the
 * frame's own shape. Probed 2026-10-30 on 1.5 and Lite at 480p: a square first
 * frame came back 544×544 under both 16:9 and 9:16, while a 16:9 crop of it
 * came back 736×400 and a 4:5 crop 480×608. So the shape is chosen by cropping
 * the picture. Every pinned frame is cropped — first,
 * last, loop and keyframes — so the clip never has to bridge two shapes;
 * references are a look, not a frame, and keep theirs.
 */
export function grokFrameCrops(
  input: GrokVideoInput,
  frameAspectRatio: string | undefined,
): (string | null)[] {
  const plan = planGrokVideo(input);
  const count = Math.max(0, input.referenceCount);
  const crop =
    plan.mode === "generate" &&
    plan.first !== null &&
    frameAspectRatio !== undefined &&
    grokVideoCaps().aspectRatios.includes(frameAspectRatio)
      ? frameAspectRatio
      : null;
  return Array.from({ length: count }, (_, index) => {
    const role = plan.roles[index]?.role;
    return crop !== null && role !== undefined && role !== "reference" ? crop : null;
  });
}

// ---------------------------------------------------------------------------
// Video: the request
// ---------------------------------------------------------------------------

export type GrokVideoRequest = {
  path: GrokVideoPlan["path"];
  body: Record<string, unknown>;
  plan: GrokVideoPlan;
};

/**
 * The request body for a video job. Throws the first of `grokVideoIssues`, so
 * nothing xAI documents as illegal is ever sent.
 */
export function buildGrokVideoRequest(
  input: GrokVideoInput & {
    prompt: string;
    /** One per selected image, in @imageN order. Ignored by Edit and Extend. */
    imageUrls: readonly string[];
    voices?: readonly string[];
    resolution?: string;
    aspectRatio?: string;
    /** Edit and Extend: a public `.mp4` URL or a base64 data URL. */
    sourceVideoUrl?: string;
  },
): GrokVideoRequest {
  const issue = grokVideoIssues(input)[0];
  if (issue) throw new Error(issue);
  const plan = planGrokVideo(input);
  const caps = grokVideoCaps();

  if (plan.mode === "edit" || plan.mode === "extend") {
    if (!input.sourceVideoUrl) throw new Error("No source video to send");
    const body: Record<string, unknown> = {
      model: plan.model,
      prompt: toGrokApiPrompt(input.prompt),
      video: { url: input.sourceVideoUrl },
    };
    // Extension length only: the result is the source plus this. Edit takes no
    // duration, ratio or resolution — the output follows the source.
    if (plan.mode === "extend") {
      body.duration = input.extendDuration ?? caps.defaultExtendDuration;
    }
    return { path: plan.path, body, plan };
  }

  if (input.imageUrls.length !== input.referenceCount) {
    throw new Error(
      `Expected ${input.referenceCount} image URLs for the video request, got ${input.imageUrls.length}`,
    );
  }
  const body: Record<string, unknown> = {
    model: plan.model,
    prompt: toGrokApiPromptMapped(input.prompt, plan.promptOrdinals),
    duration: input.duration ?? caps.defaultDuration,
    resolution: input.resolution ?? caps.defaultResolution,
  };
  const url = (index: number) => ({ url: input.imageUrls[index] });
  if (plan.first !== null) body.image = url(plan.first);
  if (plan.last !== null) body.last_frame = url(plan.last);
  if (plan.keyframes.length > 0) {
    body.keyframes = plan.keyframes.map((keyframe) => ({
      image: url(keyframe.index),
      timestamp_s: keyframe.at,
    }));
  }
  if (plan.references.length > 0) body.reference_images = plan.references.map(url);
  // Text-to-video and reference-to-video spell the ratio out; a pinned first
  // frame decides it, and xAI ignores the field there.
  if (plan.usesAspectRatio) {
    body.aspect_ratio =
      input.aspectRatio && input.aspectRatio !== "auto" ? input.aspectRatio : "16:9";
  }
  // Voices ride along with any input shape on 1.5 (probed 2026-08-16), and any
  // voice makes the job reference-to-video.
  const voices = plan.usesVoices ? (input.voices ?? []) : [];
  if (voices.length > 0) body.reference_audios = voices.map((voiceId) => ({ voice_id: voiceId }));
  return { path: plan.path, body, plan };
}

/**
 * Length of the clip a stored row produced: Edit keeps the source's, Extend
 * adds to it, Generate is what was asked for.
 */
export function grokVideoOutputSeconds(row: {
  duration?: number;
  grokVideoMode?: string;
  sourceVideoSeconds?: number;
}): number | undefined {
  if (row.grokVideoMode === "edit") return row.sourceVideoSeconds;
  if (row.grokVideoMode === "extend") {
    return row.sourceVideoSeconds !== undefined && row.duration !== undefined
      ? row.sourceVideoSeconds + row.duration
      : undefined;
  }
  return row.duration;
}

// ---------------------------------------------------------------------------
// Metered quota
// ---------------------------------------------------------------------------

/**
 * xAI's published API rates in USD, read from docs.x.ai/docs/models on
 * 2026-10-24 (`resolutionPricing`, `pricePerInputImage`,
 * `pricePerInputVideoSecond`; 1 USD = 10^10 ticks).
 *
 * SuperGrok meters Imagine usage against its quota at these rates rather than
 * charging per job, so this is what a generation *uses*, not what it costs.
 * Unverified for subscription traffic: the processor records the figure xAI
 * reports (`usage.cost_in_usd_ticks`) where it gets one, and that wins.
 */
export const GROK_IMAGE_RATES: Record<
  "standard" | "quality" | "v2-low" | "v2-medium",
  { perImage: Record<string, number>; perInputImage: number }
> = {
  standard: { perImage: { "1k": 0.02, "2k": 0.02 }, perInputImage: 0.002 },
  quality: { perImage: { "1k": 0.05, "1.5k": 0.06, "2k": 0.07 }, perInputImage: 0.01 },
  "v2-low": { perImage: { "1k": 0.04, "1.5k": 0.05, "2k": 0.06 }, perInputImage: 0.01 },
  "v2-medium": { perImage: { "1k": 0.06, "1.5k": 0.07, "2k": 0.08 }, perInputImage: 0.01 },
};

export const GROK_VIDEO_RATES: Record<
  string,
  { perSecond: Record<string, number>; perInputImage: number; perInputVideoSecond?: number }
> = {
  [GROK_VIDEO_MODEL_V15]: {
    perSecond: { "480p": 0.08, "720p": 0.14, "1080p": 0.25 },
    perInputImage: 0.01,
  },
  [GROK_VIDEO_MODEL_LITE]: {
    perSecond: { "480p": 0.02, "720p": 0.03, "1080p": 0.14 },
    perInputImage: 0.01,
  },
  [GROK_VIDEO_MODEL_BASE]: {
    perSecond: { "480p": 0.05, "720p": 0.07 },
    perInputImage: 0.002,
    perInputVideoSecond: 0.01,
  },
};

function roundUsd(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Quota one image click uses. An edit batch is `count` requests, each carrying
 * every source image; a generation is one request for `count` images. `v2-auto`
 * is billed at what xAI serves: low for a generation, medium for an edit.
 */
export function grokImageMeteredUsd(input: {
  quality?: string;
  sizeTier?: string;
  count?: number;
  referenceCount: number;
}): number {
  const quality = isGrokImageQuality(input.quality) ? input.quality : "quality";
  const key: keyof typeof GROK_IMAGE_RATES =
    quality === "v2-auto" ? (input.referenceCount > 0 ? "v2-medium" : "v2-low") : quality;
  const rates = GROK_IMAGE_RATES[key];
  const tier = (input.sizeTier ?? "2k").toLowerCase();
  const perImage = rates.perImage[tier] ?? rates.perImage["2k"];
  const outputs = Math.max(1, input.count ?? 1);
  const inputs = input.referenceCount > 0 ? outputs * input.referenceCount : 0;
  return roundUsd(perImage * outputs + rates.perInputImage * inputs);
}

/**
 * Quota one clip uses.
 *
 * Edit is billed on the source's length (the output keeps it) plus the input
 * video seconds. Extend is estimated on the added seconds plus the input video
 * — xAI does not say whether the returned source part is billed again, so this
 * is the lower reading and the measured figure replaces it.
 */
export function grokVideoMeteredUsd(
  input: GrokVideoInput & {
    resolution?: string;
  },
): number {
  const plan = planGrokVideo(input);
  if (plan.mode === "edit" || plan.mode === "extend") {
    const rates = GROK_VIDEO_RATES[GROK_VIDEO_MODEL_BASE];
    const resolution = (input.source?.resolution ?? input.resolution) === "480p" ? "480p" : "720p";
    const sourceSeconds =
      input.source?.seconds ??
      (plan.mode === "edit"
        ? GROK_VIDEO_EDIT_MAX_SOURCE_SECONDS
        : GROK_VIDEO_EXTEND_SOURCE_SECONDS.max);
    const generated =
      plan.mode === "edit"
        ? sourceSeconds
        : (input.extendDuration ?? grokVideoCaps().defaultExtendDuration);
    return roundUsd(
      generated * rates.perSecond[resolution] + sourceSeconds * (rates.perInputVideoSecond ?? 0),
    );
  }
  const rates = GROK_VIDEO_RATES[plan.model];
  const caps = grokVideoCaps();
  const perSecond =
    rates.perSecond[input.resolution ?? caps.defaultResolution] ??
    rates.perSecond[caps.defaultResolution];
  const seconds = input.duration ?? caps.defaultDuration;
  return roundUsd(perSecond * seconds + rates.perInputImage * plan.imageCount);
}

/** The fields of a stored row the metered estimate reads. */
export type GrokMeteredRow = {
  mediaType: "image" | "video";
  quality?: string;
  resolution?: string;
  count?: number;
  duration?: number;
  /** References the job carried: referenceB2Keys once finished, storage ids before. */
  referenceCount: number;
  grokVideoMode?: string;
  grokVideoModel?: string;
  grokFrameRoles?: readonly (GrokFrameRole | null)[];
  referenceVoices?: readonly string[];
  sourceVideoSeconds?: number;
};

/** Quota a stored Grok row used, by the rate card. Rows store one clip each. */
export function grokMeteredUsdForRow(row: GrokMeteredRow): number {
  if (row.mediaType === "image") {
    return grokImageMeteredUsd({
      quality: row.quality,
      sizeTier: row.resolution,
      count: row.count,
      referenceCount: row.referenceCount,
    });
  }
  return grokVideoMeteredUsd({
    mode: row.grokVideoMode,
    model: row.grokVideoModel,
    referenceCount: row.referenceCount,
    frameRoles: row.grokFrameRoles,
    voiceCount: row.referenceVoices?.length ?? 0,
    duration: row.grokVideoMode === "extend" ? undefined : row.duration,
    extendDuration: row.grokVideoMode === "extend" ? row.duration : undefined,
    source: row.sourceVideoSeconds !== undefined ? { seconds: row.sourceVideoSeconds } : undefined,
    resolution: row.resolution,
  });
}

/** `usage.cost_in_usd_ticks` → USD. One cent is 10^8 ticks. */
export function usdFromTicks(ticks: unknown): number | undefined {
  return typeof ticks === "number" && Number.isFinite(ticks) && ticks >= 0
    ? roundUsd(ticks / 10_000_000_000)
    : undefined;
}
