/**
 * Prompt Studio: an idea in a few words in, a handful of finished prompts out,
 * then refined over a short conversation ("the second one, but slower").
 *
 * Enhance rewrites the prompt in the field in one shot; the studio is where a
 * prompt gets *written*. It runs on the same models and the same plumbing
 * (subscription Grok first, its Atlas twin when the subscription cannot
 * answer), and a model that accepts images can be shown the references, so
 * "the woman from @image1 in the dress from @image2" means what it says.
 *
 * Each answer is a JSON object of variants. Every variant carries a short
 * title and a one-line summary in the user's own language, so choosing
 * between three does not mean reading three 150-word English prompts, and the
 * prompt itself in English.
 *
 * Variants are labelled for the session: fresh ones count up (1, 2, 3, 4…),
 * a revision of variant 2 becomes 2.1, 2.2, a revision of 2.1 becomes 2.1.1.
 * The label is what the user points at, and what the UI diffs against.
 *
 * Nothing in here talks to the network; the Convex action owns that, and the
 * native apps will reuse the same rules.
 */

import { isDescribableImage, type VisionContentPart } from "./image-to-prompt";
import { cleanEnhancedText, fillRecipePlaceholders, type EnhanceContext } from "./prompt-enhance";

export const STUDIO_VARIANT_COUNTS = [1, 2, 3] as const;
export const DEFAULT_STUDIO_VARIANTS = 3;
/** A message is a brief, not an essay; the cap only stops a paste accident. */
export const MAX_STUDIO_TEXT = 4000;
/** The prompt field travels along as context; same cap as Enhance's input. */
export const MAX_STUDIO_CURRENT_PROMPT = 8000;
/**
 * Images shown to the model per turn. The "studio" profile caps each at
 * 768 KiB, so four base64 images fit Node actions' 5 MiB argument limit.
 */
export const MAX_STUDIO_IMAGES = 4;
/**
 * Messages kept per session (user and assistant together, so 30 rounds). A
 * session is one document; the backend also checks its byte size.
 */
export const MAX_STUDIO_MESSAGES = 60;
export const MAX_STUDIO_IMAGE_CHARS = 4_200_000;
export const MAX_STUDIO_REFERENCES = 32;
/** How much of the conversation the model re-reads each turn. */
const HISTORY_MESSAGES = 10;
export const MAX_STUDIO_TITLE = 80;
const MAX_SUMMARY = 400;
const MAX_PROMPT = 8000;

export type StudioContext = EnhanceContext & {
  /** The generation model reads @imageN tags in its prompt. */
  tagsInPrompt?: boolean;
  /**
   * The references are the clip's fixed frames, in order ("Start", "End"),
   * rather than loose references.
   */
  frameSlots?: string[];
  /** Per-reference Grok roles, including keyframe times. */
  referenceRoles?: string[];
};

export type StudioVariant = {
  label: string;
  title: string;
  summary: string;
  prompt: string;
  /** For a revision: what changed, in the user's language. */
  changes?: string;
  /** The variant this one revises. */
  parentLabel?: string;
};

export type StudioUserMessage = {
  role: "user";
  text: string;
  /** Label of the variant the message answers, when one was quoted. */
  replyTo?: string;
  /** How many references the model was shown with this message. */
  imageCount?: number;
  at: number;
};

export type StudioAssistantMessage = {
  role: "assistant";
  variants: StudioVariant[];
  /** Label of the model that answered, e.g. "Grok 4.6". */
  model: string;
  provider: "grok" | "atlas";
  fellBack: boolean;
  reason?: string;
  costUsd?: number;
  durationMs: number;
  at: number;
};

export type StudioMessage = StudioUserMessage | StudioAssistantMessage;

export type StudioChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | VisionContentPart[];
};

export function isStudioVariantCount(value: unknown): value is number {
  return STUDIO_VARIANT_COUNTS.some((count) => count === value);
}

export function areStudioImages(images: readonly string[]): boolean {
  return (
    images.length <= MAX_STUDIO_IMAGES &&
    images.reduce((size, image) => size + image.length, 0) <= MAX_STUDIO_IMAGE_CHARS &&
    images.every(isDescribableImage)
  );
}

/** Bound even hand-written API calls before expanding tags or building a request. */
export function studioContextError(context: StudioContext): string | null {
  if (
    (context.targetModel?.length ?? 0) > 200 ||
    (context.aspectRatio?.length ?? 0) > 32 ||
    (context.duration !== undefined &&
      (!Number.isFinite(context.duration) || context.duration < 0 || context.duration > 3600)) ||
    (context.referenceCount !== undefined &&
      (!Number.isInteger(context.referenceCount) ||
        context.referenceCount < 0 ||
        context.referenceCount > MAX_STUDIO_REFERENCES)) ||
    (context.frameSlots !== undefined &&
      (context.frameSlots.length > MAX_STUDIO_REFERENCES ||
        context.frameSlots.some((slot) => slot.length > 80))) ||
    (context.referenceRoles !== undefined &&
      (context.referenceRoles.length > MAX_STUDIO_REFERENCES ||
        context.referenceRoles.some((role) => role.length > 80)))
  ) {
    return "Invalid generation settings";
  }
  return null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function tagList(count: number): string {
  return Array.from({ length: count }, (_, i) => `@image${i + 1}`).join(", ");
}

function settingsBlock(context: StudioContext): string {
  const lines = [
    `Target: a ${context.media} generation model (${context.targetModel ?? "a current model"}).`,
  ];
  if (context.media === "video") {
    lines.push(
      typeof context.duration === "number" && context.duration > 0
        ? `Clip length: ${context.duration} seconds — the action must fit it.`
        : "Clip length: not set — pick a sensible one for the action.",
    );
  }
  if (context.aspectRatio && /^\d+:\d+$/.test(context.aspectRatio)) {
    lines.push(`Aspect ratio: ${context.aspectRatio}.`);
  }
  return lines.join("\n");
}

function referencesBlock(context: StudioContext, seen: number): string {
  const count = context.referenceCount ?? 0;
  if (count <= 0) return "";
  const lines: string[] = [];
  if (seen > 0) {
    lines.push(
      `The user attached ${plural(count, "reference image")}, tagged ${tagList(count)}. ${
        seen >= count ? "All of them are" : `The first ${seen} are`
      } shown to you in the last message, each right after its tag. Look at them closely and use what you actually see — face, hair, body, outfit, fabric, colours, props, setting — wherever the idea needs it; for example, describe how that particular dress moves. The user may point at them as @image1, "image 1", "the first picture" or the same in their own language.`,
    );
    if (seen < count) lines.push("Do not guess the contents of the unseen references.");
  } else {
    lines.push(
      `The user attached ${plural(count, "reference image")}, tagged ${tagList(count)}, but you cannot see them. Do not guess what is in them.`,
    );
  }
  if (context.referenceRoles?.length) {
    lines.push(
      `Reference roles: ${context.referenceRoles
        .slice(0, count)
        .map((role, index) => `@image${index + 1}: ${role}`)
        .join(
          "; ",
        )}. First, last, loop (first and last) and keyframe images fix the clip at those times; describe motion consistent with them. Only loose references guide the look without fixing a frame.`,
    );
  }
  const slots = context.frameSlots?.slice(0, count);
  if (slots && slots.length > 0) {
    lines.push(
      `They are the clip's fixed frames, in order: ${slots.join(", ")}. The generator receives them as frames, so describe the motion and what changes from or towards them, keep the look consistent with them, and do not write @image tags in the prompt.`,
    );
  } else if (context.tagsInPrompt) {
    lines.push(
      `The generation model reads these tags: in the prompt, refer to a reference by its tag (e.g. "the woman from @image1") wherever the subject, outfit or place must match it${
        seen > 0 ? ", and still spell out the visual details that matter for the motion" : ""
      }.`,
    );
  } else {
    lines.push(
      `The generation model receives the images on its own and cannot read @image tags: never write @imageN in the prompt; ${
        seen > 0
          ? "describe in words what must match them."
          : 'refer to them generically ("the reference character").'
      }`,
    );
  }
  return lines.join("\n");
}

function formatBlock(
  context: StudioContext,
  format: { title: string; instructions: string } | undefined,
  seen: number,
): string {
  if (format) {
    const slots = context.frameSlots?.slice(0, context.referenceCount ?? 0);
    const recipe = fillRecipePlaceholders(format.instructions, {
      ...context,
      // Enhance's reference placeholders assume a generator that reads tags.
      // Fixed frames need its frame placeholders instead.
      referenceCount: context.tagsInPrompt && !slots?.length ? context.referenceCount : 0,
      frameInputs: slots?.length
        ? slots.length > 1
          ? "both"
          : slots[0] === "End"
            ? "last"
            : "first"
        : context.frameInputs,
    });
    return `Write every prompt in the format of the "${format.title}" recipe:\n"""\n${recipe}\n"""${
      seen > 0
        ? "\nWhere the recipe says not to describe the references from imagination, that does not apply here: you can see them."
        : ""
    }`;
  }
  return context.media === "video"
    ? "Write each prompt as fluent present-tense prose of 80–180 words for one clip: the subject, concretely; the action as it unfolds, beat by beat, with how bodies, hands, hair and clothing move; camera framing and movement; setting, light, colour and mood; and sound, if the model makes audio. One clear, physically plausible action per beat; motion slow enough to read."
    : "Write each prompt as fluent prose of 60–140 words: the subject, concretely; pose and expression; clothing; setting; light; lens or camera; colour and mood. Prefer specific nouns over adjectives.";
}

function replyFormatBlock(count: number): string {
  return `Reply with one JSON object and nothing before or after it:
{"title": "...", "variants": [{"title": "...", "summary": "...", "prompt": "...", "basedOn": "...", "changes": "..."}]}
- "variants": exactly ${count} item${count === 1 ? "" : "s"}.${
    count > 1
      ? " Make them genuinely different — staging, camera, pacing, mood — while each stays faithful to the idea."
      : ""
  }
- "title" (top level): 2–5 words naming the whole idea, in the language the user writes in.
- variant "title": 2–5 words, in the user's language, naming what sets this variant apart.
- "summary": one sentence in the user's language — what happens and how it is shot — so the user can choose without reading the prompt.
- "prompt": the finished prompt, in English whatever language the user writes in. Escape line breaks inside it as \\n.
- "basedOn" and "changes": only when a variant revises an earlier one — its label, and one sentence in the user's language on what you changed. Leave both out for a fresh variant.`;
}

const STUDIO_RULES = `Rules:
- Keep everything the user asked for. Add what the idea is missing; never swap it for another idea.
- Do not ask questions. If something is unclear, decide.
- Never mention that you are an AI or that the text is a prompt.
- Your earlier answers appear as JSON in which every variant has a "label". The user refers to variants by those labels ("2", "the second one", "2.1"); a revision of one keeps "basedOn" pointing at it.`;

export function renderStudioSystem(
  context: StudioContext,
  options: {
    variantCount: number;
    format?: { title: string; instructions: string };
    seenImages: number;
  },
): string {
  return [
    "You write prompts for image and video generation models. The user describes an idea in a few words, in any language; you turn it into finished prompts they can paste into the generator, and refine them with the user over the following turns.",
    settingsBlock(context),
    referencesBlock(context, options.seenImages),
    formatBlock(context, options.format, options.seenImages),
    replyFormatBlock(options.variantCount),
    STUDIO_RULES,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What the model re-reads of an earlier answer: the labels are the point. */
function assistantTranscript(message: StudioAssistantMessage): string {
  return JSON.stringify({
    variants: message.variants.map(({ label, title, prompt }) => ({ label, title, prompt })),
  });
}

function userTranscript(message: StudioUserMessage): string {
  return message.replyTo ? `(About variant ${message.replyTo}) ${message.text}` : message.text;
}

export type StudioRequest = {
  history: readonly StudioMessage[];
  text: string;
  /** The quoted variant, already looked up in the session. */
  replyTo?: StudioVariant;
  variantCount: number;
  context: StudioContext;
  format?: { title: string; instructions: string };
  /** The prompt field as it is now, when the user chose to include it. */
  currentPrompt?: string;
  /** Data URLs in @image order; only when the model may see them. */
  images: readonly string[];
};

export function buildStudioMessages(request: StudioRequest): StudioChatMessage[] {
  const seen = Math.min(request.images.length, MAX_STUDIO_IMAGES);
  const messages: StudioChatMessage[] = [
    {
      role: "system",
      content: renderStudioSystem(request.context, {
        variantCount: request.variantCount,
        format: request.format,
        seenImages: seen,
      }),
    },
  ];

  const recent = request.history.slice(-HISTORY_MESSAGES);
  // A conversation the model reads must open with the user.
  const start = recent.findIndex((message) => message.role === "user");
  for (const message of start < 0 ? [] : recent.slice(start)) {
    messages.push(
      message.role === "user"
        ? { role: "user", content: userTranscript(message) }
        : { role: "assistant", content: assistantTranscript(message) },
    );
  }

  let text = "";
  const current = request.currentPrompt?.trim();
  if (current) {
    text += `The prompt currently in the generator's prompt field — use it only if my message relates to it:\n"""\n${current}\n"""\n\n`;
  }
  if (request.replyTo) {
    const { label, title, prompt } = request.replyTo;
    text += `I am replying to variant ${label} ("${title}"):\n"""\n${prompt}\n"""\nRevise that variant: give each revision "basedOn": "${label}" and say what changed in "changes".\n\n`;
  }
  text += request.text.trim();
  text += `\n\n(Answer with ${plural(request.variantCount, "variant")}.)`;

  if (seen === 0) {
    messages.push({ role: "user", content: text });
  } else {
    const parts: VisionContentPart[] = [];
    for (const [index, url] of request.images.slice(0, seen).entries()) {
      parts.push({ type: "text", text: `@image${index + 1}:` });
      parts.push({ type: "image_url", image_url: { url, detail: "high" } });
    }
    parts.push({ type: "text", text });
    messages.push({ role: "user", content: parts });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Reading the answer
// ---------------------------------------------------------------------------

export type ParsedStudioVariant = {
  title: string;
  summary: string;
  prompt: string;
  changes?: string;
  basedOn?: string;
};

export type ParsedStudioReply = { title?: string; variants: ParsedStudioVariant[] };

/**
 * JSON with raw line breaks or tabs inside its strings — what a model writes
 * when the prompt it is quoting has paragraphs, as the H3 format does. Those
 * are escaped; everything else is left for JSON.parse to judge.
 */
function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      } else if (char === "\n") {
        out += "\\n";
        continue;
      } else if (char === "\r") {
        continue;
      } else if (char === "\t") {
        out += "\\t";
        continue;
      }
    } else if (char === '"') {
      inString = true;
    }
    out += char;
  }
  return out;
}

function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(escapeControlCharsInStrings(text));
    } catch {
      return undefined;
    }
  }
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max).trim() : "";
}

function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const match = /\d+(?:\.\d+)*/.exec(String(value));
  return match ? match[0] : undefined;
}

/** Null when the answer holds no usable variant at all. */
export function parseStudioReply(raw: string): ParsedStudioReply | null {
  let text = raw.trim();
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(text);
  if (fence) text = fence[1].trim();

  // Whichever opens first is the outer value: an array of objects also
  // contains braces.
  const spans: [string, string][] =
    text.indexOf("[") >= 0 && (text.indexOf("{") < 0 || text.indexOf("[") < text.indexOf("{"))
      ? [
          ["[", "]"],
          ["{", "}"],
        ]
      : [
          ["{", "}"],
          ["[", "]"],
        ];
  let parsed: unknown;
  for (const [open, close] of spans) {
    const first = text.indexOf(open);
    const last = text.lastIndexOf(close);
    if (first >= 0 && last > first) parsed = parseLoose(text.slice(first, last + 1));
    if (parsed !== undefined) break;
  }
  if (parsed === undefined || parsed === null || typeof parsed !== "object") return null;

  const record = parsed as Record<string, unknown>;
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record.variants)
      ? record.variants
      : typeof record.prompt === "string"
        ? [parsed]
        : [];

  const variants: ParsedStudioVariant[] = [];
  for (const item of list) {
    if (variants.length >= 3) break;
    if (typeof item === "string") {
      const prompt = cleanEnhancedText(item).slice(0, MAX_PROMPT);
      if (prompt) variants.push({ title: "", summary: "", prompt });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const prompt = cleanEnhancedText(clip(entry.prompt, MAX_PROMPT));
    if (!prompt) continue;
    const variant: ParsedStudioVariant = {
      title: clip(entry.title, MAX_STUDIO_TITLE),
      summary: clip(entry.summary, MAX_SUMMARY),
      prompt,
    };
    const changes = clip(entry.changes, MAX_SUMMARY);
    if (changes) variant.changes = changes;
    const basedOn = normalizeLabel(entry.basedOn);
    if (basedOn) variant.basedOn = basedOn;
    variants.push(variant);
  }
  if (variants.length === 0) return null;
  const title = Array.isArray(parsed) ? "" : clip(record.title, MAX_STUDIO_TITLE);
  return title ? { title, variants } : { variants };
}

/** Every variant label in the session, in order. */
export function studioLabels(history: readonly StudioMessage[]): string[] {
  return history.flatMap((message) =>
    message.role === "assistant" ? message.variants.map((variant) => variant.label) : [],
  );
}

export function findStudioVariant(
  history: readonly StudioMessage[],
  label: string,
): StudioVariant | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role !== "assistant") continue;
    const found = message.variants.find((variant) => variant.label === label);
    if (found) return found;
  }
  return undefined;
}

/**
 * Gives parsed variants their session labels. A variant revises another when
 * the model says so ("basedOn") and that label exists, or — when the model
 * forgot to say — when the message quoted one. Everything else is fresh.
 */
export function labelStudioVariants(
  history: readonly StudioMessage[],
  variants: readonly ParsedStudioVariant[],
  replyTo?: string,
): StudioVariant[] {
  const taken = new Set(studioLabels(history));
  const quoted = replyTo && taken.has(replyTo) ? replyTo : undefined;
  let nextTop = 1;
  for (const label of taken) {
    const top = Number(label.split(".")[0]);
    if (Number.isInteger(top) && top >= nextTop) nextTop = top + 1;
  }

  return variants.map(({ basedOn, ...variant }) => {
    const parent = basedOn && taken.has(basedOn) ? basedOn : quoted;
    let label: string;
    if (parent) {
      let n = 1;
      while (taken.has(`${parent}.${n}`)) n++;
      label = `${parent}.${n}`;
    } else {
      label = String(nextTop++);
    }
    taken.add(label);
    const labelled: StudioVariant = {
      label,
      title: variant.title || `Variant ${label}`,
      summary: variant.summary,
      prompt: variant.prompt,
    };
    if (parent) {
      labelled.parentLabel = parent;
      if (variant.changes) labelled.changes = variant.changes;
    }
    return labelled;
  });
}

/** The session's name: the model's title for it, else the start of the brief. */
export function studioSessionTitle(parsedTitle: string | undefined, text: string): string {
  const title = parsedTitle?.trim();
  if (title) return title.slice(0, MAX_STUDIO_TITLE);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57).trimEnd()}…` : flat || "Untitled";
}

// ---------------------------------------------------------------------------
// Showing a revision
// ---------------------------------------------------------------------------

export type DiffSegment = { kind: "same" | "added" | "removed"; text: string };

/** Above this many tokens per side the diff is skipped rather than slow. */
const MAX_DIFF_TOKENS = 2500;

/**
 * Word-level diff of two prompts, whitespace kept with the words, for showing
 * what a revision changed. Null when either side is too long to diff cheaply.
 */
export function diffWords(before: string, after: string): DiffSegment[] | null {
  // Each word carries the whitespace after it, and words compare without it,
  // so a change reads as whole phrases rather than words and lone spaces.
  const tokens = (text: string) => text.match(/^\s+|\S+\s*/g) ?? [];
  const aText = tokens(before);
  const bText = tokens(after);
  if (aText.length > MAX_DIFF_TOKENS || bText.length > MAX_DIFF_TOKENS) return null;
  const a = aText.map((token) => token.trim());
  const b = bText.map((token) => token.trim());

  // Longest common subsequence, filled from the end so the walk goes forward.
  const width = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment["kind"], text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", bText[j]);
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      push("removed", aText[i++]);
    } else {
      push("added", bText[j++]);
    }
  }
  while (i < a.length) push("removed", aText[i++]);
  while (j < b.length) push("added", bText[j++]);
  return segments;
}
