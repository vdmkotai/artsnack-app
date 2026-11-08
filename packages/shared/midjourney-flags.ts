/**
 * Midjourney's prompt flags, as form controls.
 *
 * Atlas's Youchuan endpoints — Midjourney V8.x through its licensed Chinese
 * distributor — expose some of Midjourney's settings as JSON fields (aspect
 * ratio, stylize, chaos, weird, quality, seed, HD, a style reference) and the
 * rest travel the way they always have in Midjourney: as `--flags` at the end
 * of the prompt. The schema says so in passing: "Youchuan command flags
 * embedded in the prompt are not counted toward the limit."
 *
 * So the controls Midjourney's own app shows and Atlas's schema does not —
 * raw mode, exclusions, style weight, image weight, experimental aesthetics,
 * tile — are declared here as app-only parameters. The generic renderer draws
 * them like any other, `normalizeAtlasParams` carries them across a model
 * switch, and `buildAtlasRequest` folds them into the prompt just before the
 * request leaves. None of them is ever a JSON field: Atlas rejects unknown
 * properties.
 *
 * Only what Midjourney documents for V8.x is offered. `--q` is Atlas's own
 * `quality` field; `--oref`, `--cref`, `--stop` and multi-prompts are V7 or
 * earlier and absent on V8.2; `--p` reads a personalisation profile that
 * belongs to Atlas's Youchuan account rather than the user's; `--repeat` is
 * what the form's own fan-out already does.
 */

import type { AtlasModel, AtlasParam, AtlasParamValue } from "./atlas-models";

/** Every control is named `mj_*`, a prefix no Atlas wire parameter uses. */
type FlagSpec = {
  /** The flag as Midjourney spells it, without the leading dashes. */
  flag: string;
  param: AtlasParam;
  /** `--sw` does nothing without an `--sref`; keep the prompt clean. */
  needsStyleReference?: boolean;
  /** `--iw` weighs an image prompt, so only image-to-image has one to weigh. */
  needsImagePrompt?: boolean;
};

const FLAGS: readonly FlagSpec[] = [
  {
    flag: "raw",
    param: {
      name: "mj_raw",
      kind: "boolean",
      label: "Raw mode",
      description:
        "Midjourney's --raw: less of the default aesthetic, closer to the literal prompt. Added to the prompt as a flag.",
      required: false,
      default: false,
    },
  },
  {
    flag: "no",
    param: {
      name: "mj_no",
      kind: "string",
      label: "Exclude",
      description:
        'Midjourney\'s --no: things to leave out, comma-separated — "text, watermark, blur". Added to the prompt as a flag.',
      required: false,
      default: "",
      multiline: true,
    },
  },
  {
    flag: "sw",
    needsStyleReference: true,
    param: {
      name: "mj_sw",
      kind: "integer",
      label: "Style weight",
      description:
        "Midjourney's --sw: how strongly the style reference applies (0–1000, default 100). Sent only when a style reference is attached.",
      required: false,
      default: 100,
      min: 0,
      max: 1000,
      slider: true,
    },
  },
  {
    flag: "iw",
    needsImagePrompt: true,
    param: {
      name: "mj_iw",
      kind: "number",
      label: "Image weight",
      description:
        "Midjourney's --iw: how much the input image counts against the text (0–3, default 1). Added to the prompt as a flag.",
      required: false,
      default: 1,
      min: 0,
      max: 3,
      slider: true,
    },
  },
  {
    flag: "exp",
    param: {
      name: "mj_exp",
      kind: "integer",
      label: "Experimental aesthetics",
      description:
        "Midjourney's --exp: extra detail and dynamics (0–100, default 0). Added to the prompt as a flag.",
      required: false,
      default: 0,
      min: 0,
      max: 100,
      slider: true,
    },
  },
  {
    flag: "tile",
    param: {
      name: "mj_tile",
      kind: "boolean",
      label: "Tile",
      description:
        "Midjourney's --tile: a pattern whose edges repeat seamlessly. Added to the prompt as a flag.",
      required: false,
      default: false,
    },
  },
];

/**
 * The Youchuan endpoints that read Midjourney flags out of the prompt.
 *
 * Keyed on shape rather than on id, so a V8.3 that Atlas adds next month gets
 * the same controls after a sync: Midjourney's vendor, a `stylize` field — the
 * mark of an "imagine"-style endpoint — and a prompt the model requires. Blend
 * takes an optional prompt and style transfer takes only a style description;
 * neither is a place to append `--raw` to.
 */
export function isMidjourneyPromptModel(model: AtlasModel): boolean {
  return (
    model.organization === "MIDJOURNEY" &&
    model.media === "image" &&
    model.params.some((param) => param.name === "stylize") &&
    model.params.some((param) => param.name === "prompt" && param.required)
  );
}

function specsFor(model: AtlasModel): FlagSpec[] {
  if (!isMidjourneyPromptModel(model)) return [];
  const hasImagePrompt = model.params.some(
    (param) => param.kind === "media" && param.name === "image",
  );
  return FLAGS.filter((spec) => !spec.needsImagePrompt || hasImagePrompt);
}

/** The app-only controls to draw for this model, after its own parameters. */
export function midjourneyFlagParams(model: AtlasModel): AtlasParam[] {
  return specsFor(model).map((spec) => ({ ...spec.param, virtual: "midjourney-flag" }));
}

/** Whether the user already typed this flag by hand. Theirs wins. */
function promptHasFlag(prompt: string, flag: string): boolean {
  return new RegExp(`(?:^|\\s)--${flag}(?:\\s|$)`, "i").test(prompt);
}

/** `--no` takes free text: one line, no chance of smuggling a second flag in. */
function cleanExclusions(value: string): string {
  return value.replace(/--/g, " ").replace(/\s+/g, " ").trim();
}

function formatNumber(value: number, kind: AtlasParam["kind"]): string {
  return kind === "integer" ? String(Math.round(value)) : String(Number(value.toFixed(2)));
}

/**
 * The flags to append to a prompt, or "" when every control is at its default.
 *
 * `values` are the form's `mj_*` entries, already clamped by the caller —
 * clamping lives in atlas-models, which imports this module, so it cannot be
 * imported back here. Flags the user typed into the prompt themselves are
 * left alone rather than doubled.
 */
export function midjourneyFlagSuffix(
  model: AtlasModel,
  values: Record<string, AtlasParamValue>,
  context: { prompt: string; hasStyleReference: boolean },
): string {
  const tokens: string[] = [];
  for (const spec of specsFor(model)) {
    if (spec.needsStyleReference && !context.hasStyleReference) continue;
    if (promptHasFlag(context.prompt, spec.flag)) continue;
    const value = values[spec.param.name];
    switch (spec.param.kind) {
      case "boolean":
        if (value === true) tokens.push(`--${spec.flag}`);
        break;
      case "string": {
        const text = typeof value === "string" ? cleanExclusions(value) : "";
        if (text) tokens.push(`--${spec.flag} ${text}`);
        break;
      }
      default: {
        if (typeof value !== "number" || !Number.isFinite(value)) break;
        if (value === spec.param.default) break;
        tokens.push(`--${spec.flag} ${formatNumber(value, spec.param.kind)}`);
      }
    }
  }
  return tokens.length === 0 ? "" : ` ${tokens.join(" ")}`;
}
