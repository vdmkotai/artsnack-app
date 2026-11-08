/**
 * Prompt enhancement: a short idea in, a detailed prompt for a modern image or
 * video model out.
 *
 * Two pieces live here because both the web app and the Convex action need
 * them, and the iOS app will too:
 *
 *   - the roster of text models an enhancement may run on, and
 *   - the built-in recipes plus the code that turns a recipe and the state of
 *     the generation form into a chat request.
 *
 * A *recipe* is a system prompt with a little metadata: which media type it
 * suits and whether it is the one the Enhance button runs without asking. The
 * model is a single user-wide setting rather than a field on each recipe — the
 * recipes differ in what they ask for, not in who should answer.
 *
 * Nothing in here talks to the network. The Convex action owns credentials and
 * fallback; this file only decides what to send.
 */

import { matchPreset } from "./atlas-dimensions";
import type { AtlasModel, AtlasParamValue } from "./atlas-models";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type EnhanceProvider = "grok" | "atlas";

export type EnhanceModel = {
  /** Stable id persisted in the user's settings, e.g. "grok:grok-4.6". */
  id: string;
  provider: EnhanceProvider;
  /** The vendor's model slug, sent verbatim in the chat request. */
  model: string;
  label: string;
  /**
   * Shown beside the label. Subscription models carry no dollar price; Atlas
   * models quote their per-million-token rates so the picker says what a
   * switch costs.
   */
  note: string;
  /**
   * Accepts images in the chat request, so Prompt Studio can show it the
   * references. From Atlas's own `/v1/models` (`input_modalities`, read
   * 2026-10-30): the Grok family lists image input, everything else here lists
   * text only — GPT-5.4 is absent from that list, so it stays off until checked.
   */
  vision?: boolean;
};

/**
 * Grok first: those bill the owner's SuperGrok subscription rather than a
 * balance, which is the whole reason they are the default. Atlas models cost
 * money and are the fallback when the subscription is rate-limited or expired,
 * or an explicit choice when a different vendor writes better prompts.
 *
 * Gemini is deliberately absent: the owner ruled it out for this job.
 */
export const ENHANCE_MODELS: readonly EnhanceModel[] = [
  {
    id: "grok:grok-4.6",
    provider: "grok",
    model: "grok-4.6",
    label: "Grok 4.6",
    note: "subscription",
    vision: true,
  },
  {
    id: "grok:grok-4.5",
    provider: "grok",
    model: "grok-4.5",
    label: "Grok 4.5",
    note: "subscription",
    vision: true,
  },
  {
    id: "grok:grok-4.3",
    provider: "grok",
    model: "grok-4.3",
    label: "Grok 4.3",
    note: "subscription",
    vision: true,
  },
  {
    id: "atlas:xai/grok-4.6",
    provider: "atlas",
    model: "xai/grok-4.6",
    label: "Grok 4.6",
    note: "Atlas · $2 / $6 per 1M",
    vision: true,
  },
  {
    id: "atlas:xai/grok-4.5",
    provider: "atlas",
    model: "xai/grok-4.5",
    label: "Grok 4.5",
    note: "Atlas · $2 / $6 per 1M",
    vision: true,
  },
  {
    id: "atlas:xai/grok-4.3",
    provider: "atlas",
    model: "xai/grok-4.3",
    label: "Grok 4.3",
    note: "Atlas · $1.25 / $2.50 per 1M",
    vision: true,
  },
  {
    id: "atlas:openai/gpt-5.4-mini",
    provider: "atlas",
    model: "openai/gpt-5.4-mini",
    label: "GPT-5.4 mini",
    note: "Atlas · $0.75 / $4.50 per 1M",
  },
  {
    id: "atlas:openai/gpt-5.4",
    provider: "atlas",
    model: "openai/gpt-5.4",
    label: "GPT-5.4",
    note: "Atlas · $2.50 / $15 per 1M",
  },
  {
    id: "atlas:deepseek-ai/deepseek-v4-pro",
    provider: "atlas",
    model: "deepseek-ai/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    note: "Atlas · $1.68 / $3.38 per 1M",
  },
  // Kept for structured video prompts after a run of 6 H3 rewrites × 2 on
  // 11 Atlas models (2026-10-12): only these answered all 12 in format. GLM
  // 5.3 and MiniMax M3 answered few of them, Qwen returned nothing,
  // DeepSeek V4 Pro came back empty a third of the time (it thinks first).
  {
    id: "atlas:xiaomi/mimo-v2.5",
    provider: "atlas",
    model: "xiaomi/mimo-v2.5",
    label: "MiMo V2.5",
    note: "Atlas · $0.14 / $0.28 per 1M · fastest",
  },
  {
    id: "atlas:deepseek-ai/deepseek-v4-flash",
    provider: "atlas",
    model: "deepseek-ai/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    note: "Atlas · $0.14 / $0.28 per 1M",
  },
  {
    id: "atlas:anthropic/claude-sonnet-4.6",
    provider: "atlas",
    model: "anthropic/claude-sonnet-4.6",
    label: "Claude Sonnet 4.6",
    note: "Atlas · $3 / $15 per 1M",
  },
  {
    id: "atlas:anthropic/claude-opus-4.8",
    provider: "atlas",
    model: "anthropic/claude-opus-4.8",
    label: "Claude Opus 4.8",
    note: "Atlas · $5 / $25 per 1M",
  },
];

export const DEFAULT_ENHANCE_MODEL_ID = "grok:grok-4.6";

export function getEnhanceModel(id: string | undefined | null): EnhanceModel {
  return (
    ENHANCE_MODELS.find((m) => m.id === id) ??
    ENHANCE_MODELS.find((m) => m.id === DEFAULT_ENHANCE_MODEL_ID)!
  );
}

/**
 * Where a subscription model goes when the subscription cannot answer: the
 * same Grok generation on Atlas, so the voice of the result does not change
 * mid-session. Null for Atlas models — there is nothing further to fall to.
 */
export function atlasFallbackFor(model: EnhanceModel): EnhanceModel | null {
  if (model.provider !== "grok") return null;
  return (
    ENHANCE_MODELS.find((m) => m.provider === "atlas" && m.model === `xai/${model.model}`) ?? null
  );
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export type EnhanceMedia = "image" | "video" | "any";

export type EnhanceRecipeInput = {
  title: string;
  instructions: string;
  media: EnhanceMedia;
  isDefault: boolean;
  /** An ENHANCE_MODELS id this recipe runs on instead of the global setting. */
  modelId?: string;
  /** BUILTIN_RECIPES_VERSION that introduced it — users seeded before get it added once. */
  since?: number;
};

/** Bumped whenever a built-in recipe is added; see enhanceRecipes.seedIfNeeded. */
export const BUILTIN_RECIPES_VERSION = 4;

/**
 * Model ids a built-in shipped with and later replaced — seeding moves a row
 * still on the old id to the new one, and leaves any model the user picked.
 * v3: "H3 structured" left DeepSeek V4 Pro, which answered empty on a third
 * of test prompts, for MiMo V2.5.
 */
export const BUILTIN_MODEL_MIGRATIONS: readonly { title: string; from: string; to: string }[] = [
  {
    title: "H3 structured",
    from: "atlas:deepseek-ai/deepseek-v4-pro",
    to: "atlas:xiaomi/mimo-v2.5",
  },
];

export const MAX_RECIPE_TITLE = 80;
export const MAX_RECIPE_INSTRUCTIONS = 6000;
export const MAX_ENHANCE_PROMPT = 8000;

/**
 * What the form knows at the moment the button is pressed. Everything is
 * optional: a recipe is useful with nothing but the prompt, and the placeholders
 * it does not fill simply vanish.
 */
export type EnhanceContext = {
  media: "image" | "video";
  /** Human label of the model that will consume the prompt, e.g. "Seedream 5". */
  targetModel?: string;
  /** Seconds, video only. */
  duration?: number;
  aspectRatio?: string;
  /** How many reference images are attached, so @imageN tags can be used. */
  referenceCount?: number;
  /** MiniMax H3 image → video: which frames are pinned. */
  frameInputs?: "first" | "last" | "both";
};

/**
 * The always-on rules every recipe runs under. Placed after the recipe's own
 * text so a recipe can still say something more specific, but before the user
 * prompt so the model treats it as the brief rather than as content.
 */
const HOUSE_RULES = `
Output rules:
- Reply with the finished prompt only. No preamble, no explanation, no quotes around it, no markdown headings unless the recipe itself asks for a format.
- Write in English regardless of the input language.
- Keep everything the user asked for. Add detail; do not replace their idea with another one.
- Do not ask questions. If the input is vague, decide.
- Never mention that you are an AI or that this is a prompt.`.trim();

/**
 * Built-in recipes, seeded into a new user's list once and editable from then
 * on. Kept terse on purpose: the model is a strong writer, and a long system
 * prompt mostly teaches it to pad.
 */
export const BUILTIN_RECIPES: readonly EnhanceRecipeInput[] = [
  {
    title: "Polish",
    media: "any",
    isDefault: true,
    instructions: `Rewrite the user's rough idea as a single detailed prompt for a modern {{media}} model ({{targetModel}}).

Aim for 60–140 words of fluent prose. Name the subject concretely, then setting, light, lens or camera, colour and mood. Prefer specific nouns over adjectives. Do not invent dialogue or new characters unless the input asks for them.{{references}}`,
  },
  {
    title: "Cinematic scenes",
    media: "video",
    isDefault: true,
    instructions: `Turn the idea into a multi-scene video prompt in this exact shape:

1. One opening paragraph of global style: lens, grade, grain, music/dialogue policy, overall aesthetic.
2. Scene blocks, each headed \`[SCENE N — Xs | SHOT SIZE | ANGLE]\`, describing framing, subject action, light and motion in present tense. The durations must add up to {{duration}} seconds{{durationFallback}}; use 2–4 scenes.
3. A closing \`TECHNICAL SPECS:\` line with pipe-separated specs (aspect ratio {{aspectRatio}}, lens, palette, audio).

Spoken lines, when the idea calls for them, go in quotes inside the scene. Motion should be slow and legible — one clear action per scene.{{references}}`,
  },
  {
    title: "Describe shot",
    media: "video",
    isDefault: false,
    instructions: `Describe one continuous shot of {{duration}} seconds{{durationFallback}} for a {{targetModel}} video model — no scene breaks.

Cover, in order: framing and camera movement, the subject and what they do across the shot, the environment, light and atmosphere, then a short line on pacing. 80–160 words of present-tense prose.{{references}}`,
  },
  {
    title: "Dialogue",
    media: "video",
    isDefault: false,
    instructions: `Keep the user's scene but give the character(s) 1–3 short spoken lines that fit the moment, written in quotes and attributed by action ("she turns to camera: '…'"). Describe tone of voice and the gesture that accompanies each line. Then tighten the rest of the description so the clip stays {{duration}} seconds{{durationFallback}}.{{references}}`,
  },
  {
    // The caption layout MiniMax H3 was trained on, read back out of the
    // workflows embedded in the smoothest community H3 clips (2026-10-12):
    // field names verbatim, the action split into timed beats, motion quality
    // stated outright. Its own model: MiMo V2.5 kept the format on 12 of 12
    // test prompts at ~6 s; see ENHANCE_MODELS.
    title: "H3 structured",
    media: "video",
    isDefault: false,
    modelId: "atlas:xiaomi/mimo-v2.5",
    since: 2,
    instructions: `Rewrite the user's idea as a prompt for the MiniMax H3 video model, in the structured caption format H3 was trained on. Plain text, field names exactly as shown (lowercase, each field on a new line), nothing before or after.
{{h3Inputs}}
integrated_multimodal_description: [Shot 1] <one line of global look: live-action or animation, photorealistic or stylised, light, lens, colour, aspect {{aspectRatio}}>. <who and what is in frame, where, wearing what, positioned how>.
At 0.0–Xs <what happens>. At X–Ys <what happens>. … — 2 to 4 timed beats that together cover exactly {{duration}} seconds{{durationFallback}}. One clear, physically continuous action per beat; say how bodies, hands, hair and clothing move and how the camera moves.
All movements are natural, fluid and at real-time speed, with sharp, clear detail on faces, hands and bodies throughout.
overall_soundscape: <ambience, effects and voices that belong to the scene; spoken lines in quotes with who says them>
non_diegetic_music: <the score, or N/A>

Only add [Shot 2], [Shot 3] … (each opening with "At 00:0X.000") if the idea really needs a cut; otherwise keep one continuous shot. Keep every detail the user wrote — be concrete, never vague.`,
  },
  {
    // LTX 2.3 reads plain, literal scene scripts — the format the community
    // documents for LTX 2.3 and its best examples follow.
    title: "LTX scene script",
    media: "video",
    isDefault: false,
    modelId: "atlas:xiaomi/mimo-v2.5",
    since: 4,
    instructions: `Rewrite the user's idea as a prompt for the LTX 2.3 video model: a plain, literal scene script of 4–8 sentences covering {{duration}} seconds{{durationFallback}}. Nothing before or after it.
{{ltxStart}}
1. One sentence on the overall cinematic style and the camera movement.
2. A short description of the environment, lighting and atmosphere.
3. "Performance:" — body language, facial expressions, emotions and the specific actions in the order they happen, with how bodies, hands and hair move.
4. If someone speaks: "Dialogue:" — who says what, in quotes, and how it is delivered. Then the sounds that belong to the scene.

Keep the acting natural and cinematic: small pauses, micro-expressions, realistic weight and motion, subtle environmental detail. No exaggerated motion, no extra characters unless asked. State everything plainly — LTX follows literal instructions and keeps every detail the user wrote.`,
  },
  {
    title: "Translate & tidy",
    media: "any",
    isDefault: false,
    instructions: `Translate the prompt to natural English and fix grammar and word order. Do not add ideas, style words or detail the user did not write. Same length, same structure.`,
  },
];

/**
 * What the form knows under an Atlas model, read from the model's own
 * parameter bag. Atlas spells aspect three ways — `aspect_ratio`, `ratio`, or
 * a `size` in pixels that only matches a preset — and duration as a number or
 * a numeric string; this is the one place that knows all of them, so the web
 * form and the iOS app do not each grow a copy.
 */
export function atlasEnhanceContext(
  model: AtlasModel,
  params: Record<string, AtlasParamValue>,
  referenceCount: number,
): EnhanceContext {
  const raw = (name: string) => params[name];
  const durationRaw = raw("duration");
  const duration =
    typeof durationRaw === "number"
      ? durationRaw
      : typeof durationRaw === "string"
        ? Number(durationRaw)
        : NaN;

  let aspectRatio: string | undefined;
  for (const name of ["aspect_ratio", "ratio"]) {
    const value = raw(name);
    if (typeof value === "string" && value) {
      aspectRatio = value;
      break;
    }
  }
  if (!aspectRatio) {
    const sizeParam = model.params.find((p) => p.kind === "dimensions");
    if (sizeParam) aspectRatio = matchPreset(sizeParam, raw(sizeParam.name))?.ratio;
  }

  return {
    media: model.media,
    targetModel: model.label,
    duration:
      model.media === "video" && Number.isFinite(duration) && duration > 0 ? duration : undefined,
    aspectRatio,
    referenceCount,
  };
}

export type EnhanceMessage = { role: "system" | "user"; content: string };

/**
 * Tuning a model may refuse by name, and the request without it. The roster
 * Image → Prompt offers is live, so there is no table of which model takes
 * what: Grok 4.20 and Grok Build list no `reasoning_effort` (xAI's
 * `/language-models`, 2026-10-30), and OpenAI's reasoning models take neither
 * a temperature nor `max_tokens` under that name. A 400 that names one gets
 * the request again without it — `max_tokens` under its newer name — once.
 * Null when the error names nothing the body still carries.
 */
export function withoutRefusedParams(
  body: Record<string, unknown>,
  error: string,
): Record<string, unknown> | null {
  const next = { ...body };
  let changed = false;
  if ("reasoning_effort" in next && /reasoning.?effort/i.test(error)) {
    delete next.reasoning_effort;
    changed = true;
  }
  if ("temperature" in next && /temperature/i.test(error)) {
    delete next.temperature;
    changed = true;
  }
  if ("max_tokens" in next && /max.?tokens/i.test(error)) {
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
    changed = true;
  }
  return changed ? next : null;
}

/**
 * Only a real `W:H` counts. Forms carry sentinels such as "auto" and Atlas's
 * "adaptive" that mean "decide from the input", and a recipe that printed one
 * of those would have the model write it into the prompt as if it were a ratio.
 */
function isRatio(value: string | undefined): value is string {
  return typeof value === "string" && /^\d+:\d+$/.test(value);
}

/**
 * Substitutes the recipe's placeholders and nothing else. Prompt Studio uses
 * this directly: it embeds a recipe as the *format* of its answers, under
 * output rules of its own that the Enhance house rules would contradict.
 */
export function fillRecipePlaceholders(instructions: string, context: EnhanceContext): string {
  const references =
    context.referenceCount && context.referenceCount > 0
      ? `\n\nThe user attached ${context.referenceCount} reference image${
          context.referenceCount === 1 ? "" : "s"
        }, addressable in the prompt as ${Array.from(
          { length: context.referenceCount },
          (_, i) => `@image${i + 1}`,
        ).join(
          ", ",
        )}. Refer to them by tag where the subject or setting should match them; do not describe what is in them from imagination.`
      : "";
  const refCount = context.referenceCount ?? 0;
  const h3Inputs =
    refCount > 0
      ? `\nThe user attached ${refCount} reference image${refCount === 1 ? "" : "s"}, tagged ${Array.from(
          { length: refCount },
          (_, i) => `@image${i + 1}`,
        ).join(
          ", ",
        )}. Begin with:\nsubject_definitions:\n<Subject 1> is <who or what> in @image1, <the details to keep: face, hair, outfit…>.\n(one line per reference, in order; for a place or object say "the <thing> in @imageN")\nthen refer to them as <Subject N> below.\n`
      : context.frameInputs === "first" || context.frameInputs === "both"
        ? `\nThe clip starts from an attached image. Begin with the line:\nFor the target video, at 0.00 seconds into the target video, <Picture 1> is fully referenced.\n${
            context.frameInputs === "both"
              ? "and, for the attached end frame, the line: At the final frame of the target video, <Picture 2> is fully referenced.\n"
              : ""
          }Describe the opening state to match that image, then what changes.\n`
        : context.frameInputs === "last"
          ? "\nThe clip ends on an attached image. Begin with the line:\nAt the final frame of the target video, <Picture 1> is fully referenced.\nBuild the action so it arrives at that image.\n"
          : "";
  const ltxStart =
    context.frameInputs === "first" || context.frameInputs === "both"
      ? 'Begin with: "Use the provided start image exactly as the first frame."' +
        (context.frameInputs === "both" ? " The action ends on the attached final frame." : "")
      : context.frameInputs === "last"
        ? "The action ends on the attached final frame; build towards it."
        : "";
  const hasDuration = typeof context.duration === "number" && context.duration > 0;
  const values: Record<string, string> = {
    media: context.media,
    targetModel: context.targetModel ?? "a current generation model",
    duration: hasDuration ? String(context.duration) : "a few",
    durationFallback: hasDuration ? "" : " (pick a sensible total if none is given)",
    aspectRatio: isRatio(context.aspectRatio) ? context.aspectRatio : "as set",
    references,
    h3Inputs,
    ltxStart,
  };
  return instructions
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
      Object.hasOwn(values, key) ? values[key] : match,
    )
    .trim();
}

/** Substitutes the recipe's placeholders and appends the house rules. */
export function renderRecipeInstructions(instructions: string, context: EnhanceContext): string {
  return `${fillRecipePlaceholders(instructions, context)}\n\n${HOUSE_RULES}`;
}

export function buildEnhanceMessages(
  instructions: string,
  prompt: string,
  context: EnhanceContext,
): EnhanceMessage[] {
  return [
    { role: "system", content: renderRecipeInstructions(instructions, context) },
    { role: "user", content: prompt.trim() },
  ];
}

/** A one-off instruction is a sentence or two; the cap only stops a paste accident. */
export const MAX_CUSTOM_INSTRUCTION = 2000;

/**
 * The one house rule a custom instruction must be free to override. A recipe
 * always enriches, so "add detail" is safe to impose on it; an instruction may
 * just as well be "make it shorter" or "drop the second character", and the
 * model has to follow that rather than the boilerplate.
 */
const CUSTOM_HOUSE_RULES = HOUSE_RULES.replace(
  "- Keep everything the user asked for. Add detail; do not replace their idea with another one.",
  "- Change only what the instruction asks for. Keep the rest of the prompt's content and intent.",
);

/**
 * The Enhance menu's "Custom instruction…": a recipe typed on the spot. Its
 * text becomes the brief, framed so the model edits the prompt it is given
 * rather than treating the instruction as the thing to describe. The same
 * placeholders a recipe gets are filled in, so a reference count or a target
 * model still reaches the model.
 */
export function buildCustomEnhanceMessages(
  instruction: string,
  prompt: string,
  context: EnhanceContext,
): EnhanceMessage[] {
  // The instruction goes in after rendering, so a "{{" someone typed is left as
  // they typed it rather than being read as a placeholder.
  const slot = "\u0000instruction\u0000";
  const brief = `You edit prompts for a modern {{media}} generation model ({{targetModel}}). Apply the instruction below to the prompt the user sends, and return the edited prompt.

Instruction:
${slot}{{references}}`;
  const rendered = renderRecipeInstructions(brief, context)
    .replace(HOUSE_RULES, CUSTOM_HOUSE_RULES)
    .replace(slot, () => instruction.trim());
  return [
    { role: "system", content: rendered },
    { role: "user", content: prompt.trim() },
  ];
}

/**
 * Models occasionally wrap the answer in quotes or a code fence despite the
 * rules. Strip the wrapper, keep the prompt.
 */
export function cleanEnhancedText(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-z]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(text);
  if (fence) text = fence[1].trim();
  if (
    text.length > 2 &&
    text.startsWith('"') &&
    text.endsWith('"') &&
    !text.slice(1, -1).includes('"')
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** Which recipe the main button runs for the given media type. */
export function defaultRecipeFor<T extends { media: EnhanceMedia; isDefault: boolean }>(
  recipes: readonly T[],
  media: "image" | "video",
): T | null {
  return (
    recipes.find((r) => r.isDefault && r.media === media) ??
    recipes.find((r) => r.isDefault && r.media === "any") ??
    recipes.find((r) => r.media === media || r.media === "any") ??
    null
  );
}

/** Recipes worth listing for a media type, defaults first. */
export function recipesFor<T extends { media: EnhanceMedia; isDefault: boolean }>(
  recipes: readonly T[],
  media: "image" | "video",
): T[] {
  const fallback = defaultRecipeFor(recipes, media);
  return recipes
    .filter((r) => r.media === media || r.media === "any")
    .sort((a, b) => Number(b === fallback) - Number(a === fallback));
}
