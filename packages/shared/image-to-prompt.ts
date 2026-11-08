/**
 * Image to prompt: a picture in, a prompt that would draw it out.
 *
 * The reverse of Enhance, and it runs on the same plumbing — a subscription
 * Grok model falls back to the same model on Atlas when the subscription
 * cannot answer. What differs is the request: the image travels as a content
 * part of the user message, which is why the message type here is wider than
 * EnhanceMessage.
 *
 * The model is the user's pick from two live lists — the models their
 * SuperGrok subscription serves and Atlas Cloud's text models — rather than
 * Enhance's fixed roster, because both vendors add vision models faster than
 * a hand-kept list would follow.
 *
 * Two fixed presets rather than editable recipes: they differ in the *grammar*
 * of the answer (prose vs weighted tags), not in taste, and taste goes in the
 * free-text instructions that ride along with either one.
 *
 * Nothing in here talks to the network.
 */

import { ENHANCE_MODELS, type EnhanceModel } from "./prompt-enhance";

export type DescribePresetId = "natural" | "sd-tags";

export type DescribePreset = {
  id: DescribePresetId;
  label: string;
  /** One line under the picker saying which models the result suits. */
  hint: string;
  instructions: string;
};

export const DESCRIBE_PRESETS: readonly DescribePreset[] = [
  {
    id: "natural",
    label: "Natural description",
    hint: "Prose for Flux, Seedream, Grok Imagine, Nano Banana, Kling and other modern models",
    instructions: `Write one detailed prompt, in fluent English prose, from which a modern natural-language image model (Flux, Seedream, Grok Imagine, Nano Banana) would reproduce this picture.

Cover, in this order:
1. The subject(s): apparent age range, build, skin, hair, face and expression; clothing with its cut, fabric, colour and fit; accessories.
2. Pose and motion: what the body is doing, where the weight sits, the gesture, the gaze, the direction of any movement.
3. The setting and background.
4. Light: source, direction, quality, time of day.
5. Camera: shot size, angle, lens feel, depth of field.
6. Colour palette, mood, and the medium or style (photograph, film stock, 3D render, illustration…).

Aim for 90–180 words. Prefer concrete nouns and measurable detail over adjectives. Present tense.`,
  },
  {
    id: "sd-tags",
    label: "SD tags with weights",
    hint: "Comma-separated tags with (tag:1.2) weights for SD 1.5 and SDXL",
    instructions: `Write a Stable Diffusion prompt for this picture as comma-separated tags, the style SD 1.5 and SDXL checkpoints respond to.

- Order: subject count and type (one woman, two dogs, a lighthouse…), then appearance, clothing, pose and action, expression, setting and background, lighting, composition and camera (from below, wide shot, close-up…), then style or medium.
- Tags are short and lowercase, spaces instead of underscores.
- Give weights to the 3–6 elements that most define the picture, in the form (tag:1.2). Use 1.1–1.4; never go above 1.5 and never weight everything.
- Do not add quality boilerplate (masterpiece, best quality…) — that depends on the checkpoint and the user adds it.
- 25–50 tags. One line, no line breaks, no negative prompt.`,
  },
];

export const DEFAULT_DESCRIBE_PRESET: DescribePresetId = "natural";

export function getDescribePreset(id: string | undefined | null): DescribePreset {
  return (
    DESCRIBE_PRESETS.find((preset) => preset.id === id) ??
    DESCRIBE_PRESETS.find((preset) => preset.id === DEFAULT_DESCRIBE_PRESET)!
  );
}

export function isDescribePresetId(value: unknown): value is DescribePresetId {
  return DESCRIBE_PRESETS.some((preset) => preset.id === value);
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * A text model Image → Prompt can run on: an EnhanceModel, which is what the
 * chat plumbing takes, plus whether its vendor lists image input.
 */
export type DescribeModel = EnhanceModel & {
  /**
   * The vendor lists image input. Atlas under-reports it — its catalogue has
   * Claude Sonnet 4.6 and Gemini 2.5 Flash as text-only (2026-10-30) — so a
   * model without the flag stays pickable and is only marked.
   */
  vision: boolean;
};

/** What `imageToPrompt.models` answers. */
export type DescribeModelCatalog = {
  models: DescribeModel[];
  /** Why the subscription's own list could not be read; the built-in Grok models stand in. */
  grokError?: string;
  /** Why Atlas's catalogue could not be read; its Grok models stand in. */
  atlasError?: string;
  /** Set by a client (`withPreviousModels`): the subscription's part is the list from last time. */
  grokFromBefore?: boolean;
  /** Set by a client: Atlas's part is the list from last time. */
  atlasFromBefore?: boolean;
};

/**
 * Subscription Grok 4.6 until the user picks another, as before the picker
 * existed: it sees images and bills the subscription rather than a balance.
 */
export const DEFAULT_DESCRIBE_MODEL_ID = "grok:grok-4.6";

/**
 * Both vendors' slugs as they appear today (`grok-4.20-0309-reasoning`,
 * `deepseek-ai/deepseek-v4.1-flash-1017`), with room to spare. The check is
 * on shape only: the lists are live, so the server holds no copy to look a
 * slug up in, and a vendor answers a slug it does not serve with a 400 that
 * says so.
 */
const MODEL_ID = /^(grok|atlas):([A-Za-z0-9][A-Za-z0-9._/-]{0,127})$/;

export function isDescribeModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}

/** Words a vendor writes in capitals, as Atlas's own display names do. */
const ACRONYMS = new Set(["gpt", "glm", "ocr", "vl"]);

/** `grok-4.20-0309-non-reasoning` → "Grok 4.20 0309 Non-reasoning"; `openai/gpt-6-sol` → "GPT 6 Sol". */
function labelFromSlug(slug: string): string {
  const name = slug.slice(slug.lastIndexOf("/") + 1).replace(/-non-reasoning/g, " non~reasoning");
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ")
    .replace(/~/g, "-");
}

/**
 * What the picker offers when a live list cannot be read: the Grok
 * generations Image → Prompt shipped with, on the subscription and on Atlas.
 * All of them take images.
 */
export const DESCRIBE_FALLBACK_MODELS: readonly DescribeModel[] = ENHANCE_MODELS.filter((model) =>
  /^(xai\/)?grok-/.test(model.model),
).map((model) => ({ ...model, vision: true }));

/**
 * The model an id names. A well-formed id nobody has listed — one picked
 * from a live list, or a vendor's newest model — still resolves, with a label
 * made from its slug; a malformed or missing one resolves to the default.
 */
export function describeModelFor(id: string | undefined | null): DescribeModel {
  const match = typeof id === "string" ? MODEL_ID.exec(id) : null;
  if (!match) return describeModelFor(DEFAULT_DESCRIBE_MODEL_ID);
  const known =
    DESCRIBE_FALLBACK_MODELS.find((model) => model.id === id) ??
    ENHANCE_MODELS.find((model) => model.id === id);
  if (known) return { vision: true, ...known };
  const provider = match[1] as EnhanceModel["provider"];
  const model = match[2];
  return {
    id: `${provider}:${model}`,
    provider,
    model,
    label: labelFromSlug(model),
    note: provider === "grok" ? "subscription" : "Atlas",
    vision: true,
  };
}

/**
 * Where a subscription model goes when the subscription cannot answer: the
 * same model under xAI's name on Atlas. Built from the slug rather than looked
 * up, because both lists are live; when Atlas does not carry that model, its
 * error is reported after the subscription's. Null for Atlas models — there is
 * nothing further to fall to.
 */
export function describeFallbackFor(model: EnhanceModel): DescribeModel | null {
  if (model.provider !== "grok") return null;
  return describeModelFor(`atlas:xai/${model.model}`);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function finiteNumber(value: unknown): number {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : 0;
}

/** Dollars per million tokens as ENHANCE_MODELS writes them: $2, $0.30, $1.25, $0.834. */
function dollars(perMillion: number): string {
  if (Number.isInteger(perMillion)) return `$${perMillion}`;
  const cents = Math.round(perMillion * 100);
  if (Math.abs(perMillion * 100 - cents) < 1e-9) return `$${perMillion.toFixed(2)}`;
  return `$${Number(perMillion.toFixed(3))}`;
}

type AtlasPrice = { input_price?: unknown; output_price?: unknown };

function atlasPriceNote(price: unknown): string {
  const prices = (price ?? {}) as { actual?: AtlasPrice; origin?: AtlasPrice };
  const rate = prices.actual ?? prices.origin;
  if (!rate) return "Atlas";
  const input = finiteNumber(rate.input_price);
  const output = finiteNumber(rate.output_price);
  if (input === 0 && output === 0) return "Atlas · free";
  return `Atlas · ${dollars(input)} / ${dollars(output)} per 1M`;
}

/**
 * Atlas's public catalogue (`GET /api/v1/models`, no key) narrowed to what a
 * chat completion can run on: text models that speak the OpenAI chat
 * protocol. That drops its image generators listed as text (GPT Image 2,
 * Gemini Flash Image) and its proprietary agents. Vision models first, each
 * group in Atlas's own order — its `priority` puts the newest and busiest on
 * top.
 */
export function atlasTextModels(body: unknown): DescribeModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const rows: { model: DescribeModel; priority: number }[] = [];
  const seen = new Set<string>();
  for (const entry of data as Record<string, unknown>[]) {
    if (!entry || entry.type !== "Text" || typeof entry.model !== "string") continue;
    if (!stringList(entry.supported_protocols).includes("openai.chat.completions")) continue;
    const output = stringList(entry.output_modalities);
    if (output.length > 0 && !output.includes("text")) continue;
    const id = `atlas:${entry.model}`;
    if (!isDescribeModelId(id) || seen.has(id)) continue;
    seen.add(id);
    const label =
      typeof entry.displayName === "string" && entry.displayName.trim()
        ? entry.displayName.trim()
        : labelFromSlug(entry.model);
    rows.push({
      model: {
        id,
        provider: "atlas",
        model: entry.model,
        label,
        note: atlasPriceNote(entry.price),
        vision: stringList(entry.input_modalities).includes("image"),
      },
      priority: finiteNumber(entry.priority),
    });
  }
  rows.sort(
    (a, b) =>
      Number(b.model.vision) - Number(a.model.vision) ||
      b.priority - a.priority ||
      a.model.label.localeCompare(b.model.label),
  );
  return rows.map((row) => row.model);
}

/**
 * The subscription's own list (`GET https://api.x.ai/v1/language-models` with
 * the user's token; on 2026-10-30 it served eight models, every one with image
 * input). Newest first.
 */
export function grokLanguageModels(body: unknown): DescribeModel[] {
  const list = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return [];
  const rows: { model: DescribeModel; created: number }[] = [];
  const seen = new Set<string>();
  for (const entry of list as Record<string, unknown>[]) {
    if (!entry || typeof entry.id !== "string") continue;
    const output = stringList(entry.output_modalities);
    if (output.length > 0 && !output.includes("text")) continue;
    const id = `grok:${entry.id}`;
    if (!isDescribeModelId(id) || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      model: {
        ...describeModelFor(id),
        note: "subscription",
        vision: stringList(entry.input_modalities).includes("image"),
      },
      created: finiteNumber(entry.created),
    });
  }
  rows.sort(
    (a, b) =>
      Number(b.model.vision) - Number(a.model.vision) ||
      b.created - a.created ||
      a.model.label.localeCompare(b.model.label),
  );
  return rows.map((row) => row.model);
}

/**
 * The two lists as one, subscription first. A list that could not be read,
 * or came back empty, is replaced by its built-in Grok models, so the picker
 * always holds the default and the error says why the list is short.
 */
export function buildDescribeCatalog(
  grok: DescribeModel[] | { error: string },
  atlas: DescribeModel[] | { error: string },
): DescribeModelCatalog {
  const fallback = (provider: EnhanceModel["provider"]) =>
    DESCRIBE_FALLBACK_MODELS.filter((model) => model.provider === provider);
  const grokModels = Array.isArray(grok) && grok.length > 0 ? grok : fallback("grok");
  const atlasModels = Array.isArray(atlas) && atlas.length > 0 ? atlas : fallback("atlas");
  const catalog: DescribeModelCatalog = { models: [...grokModels, ...atlasModels] };
  if (!Array.isArray(grok)) catalog.grokError = grok.error;
  else if (grok.length === 0) catalog.grokError = "The subscription listed no text models";
  if (!Array.isArray(atlas)) catalog.atlasError = atlas.error;
  else if (atlas.length === 0) catalog.atlasError = "Atlas listed no text models";
  return catalog;
}

/**
 * A live answer with each list that failed filled in from `previous` — the
 * last answer both vendors gave in full — when that has any models of the
 * vendor: an Atlas outage should not shrink the picker to its three Grok
 * models when the client still knows the 120 it had.
 */
export function withPreviousModels(
  fresh: DescribeModelCatalog,
  previous: readonly DescribeModel[],
): DescribeModelCatalog {
  const part = (provider: EnhanceModel["provider"], failed: string | undefined) => {
    const before = previous.filter((model) => model.provider === provider);
    return failed && before.length > 0
      ? { models: before, fromBefore: true }
      : { models: fresh.models.filter((model) => model.provider === provider), fromBefore: false };
  };
  const grok = part("grok", fresh.grokError);
  const atlas = part("atlas", fresh.atlasError);
  const catalog: DescribeModelCatalog = {
    models: [...grok.models, ...atlas.models],
    grokError: fresh.grokError,
    atlasError: fresh.atlasError,
  };
  if (grok.fromBefore) catalog.grokFromBefore = true;
  if (atlas.fromBefore) catalog.atlasFromBefore = true;
  return catalog;
}

/**
 * What went wrong reading the lists, as one line under the picker, or null.
 * `loadError` is the call itself failing, when the picker keeps what it had.
 */
export function describeCatalogNotice(
  catalog: DescribeModelCatalog,
  loadError?: string | null,
): string | null {
  if (loadError) return `The model list could not be refreshed (${loadError}).`;
  const parts: string[] = [];
  if (catalog.grokError) {
    parts.push(
      `Your subscription's models could not be read (${catalog.grokError}) — ${
        catalog.grokFromBefore
          ? "showing the list from last time"
          : "showing the built-in Grok models"
      }.`,
    );
  }
  if (catalog.atlasError) {
    parts.push(
      `Atlas's models could not be read (${catalog.atlasError}) — ${
        catalog.atlasFromBefore ? "showing the list from last time" : "showing its Grok models only"
      }.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * The catalogue that stands in before the live one arrives: the built-in
 * models, and no errors — nothing has failed yet.
 */
export const FALLBACK_DESCRIBE_CATALOG: DescribeModelCatalog = {
  models: [...DESCRIBE_FALLBACK_MODELS],
};

export type DescribeModelGroup = { title: string; models: DescribeModel[] };

/**
 * The picker's sections. `selectedId` is added to the list when the list does
 * not have it — a model picked from a live list that has since dropped it,
 * or any pick while only the built-in models are known — so the picker always
 * shows what will run.
 */
export function groupDescribeModels(
  models: readonly DescribeModel[],
  selectedId?: string | null,
): DescribeModelGroup[] {
  const all = [...models];
  if (isDescribeModelId(selectedId) && !all.some((model) => model.id === selectedId)) {
    all.unshift(describeModelFor(selectedId));
  }
  const groups: DescribeModelGroup[] = [
    { title: "SuperGrok subscription", models: all.filter((m) => m.provider === "grok") },
    {
      title: "Atlas Cloud · takes images",
      models: all.filter((m) => m.provider === "atlas" && m.vision),
    },
    {
      title: "Atlas Cloud · image input not listed",
      models: all.filter((m) => m.provider === "atlas" && !m.vision),
    },
  ];
  return groups.filter((group) => group.models.length > 0);
}

/**
 * The line under the picker: who pays, and what happens if it cannot answer.
 * `models` is the list on show; when it holds Atlas models but not the
 * subscription model's twin, there is nothing to fall back to and the line
 * says so (Grok 4.20 and Grok Build 0.1 on 2026-10-30).
 */
export function describeModelHint(
  model: DescribeModel,
  models: readonly DescribeModel[] = [],
): string {
  if (model.provider === "grok") {
    const twin = describeFallbackFor(model)?.id;
    const atlasListed = models.some((candidate) => candidate.provider === "atlas");
    if (atlasListed && !models.some((candidate) => candidate.id === twin)) {
      return "Runs on your SuperGrok subscription. Atlas does not carry this model, so nothing takes over if the subscription cannot answer.";
    }
    return "Runs on your SuperGrok subscription; if it cannot answer, the same model on Atlas does.";
  }
  const price = model.note.replace(/^Atlas(?: · )?/, "");
  const billed = price
    ? `Billed to your Atlas balance (${price} tokens).`
    : "Billed to your Atlas balance.";
  return model.vision
    ? billed
    : `${billed} Atlas does not list image input for it — it may refuse the picture or answer without seeing it.`;
}

export const MAX_DESCRIBE_INSTRUCTIONS = 1000;
/**
 * The client re-encodes to at most 1536px / 1.5MB (the "describe" reference
 * profile), which is ~2MB of base64. The cap sits above that with room to
 * spare and far below Convex's argument ceiling.
 */
export const MAX_DESCRIBE_IMAGE_CHARS = 3_000_000;

const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isDescribableImage(dataUrl: string): boolean {
  return dataUrl.length <= MAX_DESCRIBE_IMAGE_CHARS && IMAGE_DATA_URL.test(dataUrl);
}

const DESCRIBE_RULES = `
Output rules:
- Reply with the finished prompt only. No preamble, no explanation, no quotes around it, no markdown.
- Write in English regardless of the language of any instructions.
- Describe what is visible, plainly and accurately. Do not invent text, logos or brands you cannot read.
- Never write "the image shows", "in this picture" or anything else that talks about the image rather than its content.
- Do not ask questions.`.trim();

export type VisionContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

export type VisionMessage = {
  role: "system" | "user";
  content: string | VisionContentPart[];
};

/**
 * The user's own instructions go last in the system prompt and are told they
 * win: "describe her dress in more detail" should change the answer, not be
 * weighed against the preset's word count.
 */
export function renderDescribeInstructions(presetId: DescribePresetId, extra?: string): string {
  const preset = getDescribePreset(presetId);
  const trimmed = extra?.trim();
  const userPart = trimmed
    ? `\n\nAdditional instructions from the user. Follow them; where they conflict with the above, they win:\n${trimmed}`
    : "";
  return `${preset.instructions}${userPart}\n\n${DESCRIBE_RULES}`;
}

export function buildDescribeMessages(
  presetId: DescribePresetId,
  imageDataUrl: string,
  extra?: string,
): VisionMessage[] {
  return [
    { role: "system", content: renderDescribeInstructions(presetId, extra) },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
        { type: "text", text: "Write the prompt for this picture." },
      ],
    },
  ];
}
