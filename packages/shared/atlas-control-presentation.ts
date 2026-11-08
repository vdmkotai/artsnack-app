import { atlasEnumIsUnset, type AtlasParam } from "./atlas-models";

/** Presentation only. Names, types, defaults and limits on the wire stay in the catalogue. */
const LABELS: Record<string, string> = {
  n: "Number of images",
  num_images: "Number of images",
  count: "Outputs per request",
  max_images: "Maximum images",
  ratio: "Aspect ratio",
  aspect_ratio: "Aspect ratio",
  num_inference_steps: "Steps",
  cfg_scale: "Guidance",
  guidance_scale: "Guidance",
  enable_prompt_expansion: "Expand prompt",
  prompt_expansion: "Expand prompt",
  prompt_extend: "Expand prompt",
  output_format: "Output format",
  format: "Output format",
};

export function atlasControlLabel(param: AtlasParam): string {
  if (atlasToggleValues(param) && ["audio", "sound", "generate_audio"].includes(param.name))
    return "Generate audio";
  if (atlasNamedSizeOptions(param)) return "Image size";
  return LABELS[param.name] ?? param.label;
}

/** These are named presets, not interchangeable aliases: square and square_hd stay separate. */
export function atlasNamedSizeOptions(
  param: AtlasParam,
): { value: string; label: string; aspect: number }[] | null {
  if (
    param.kind !== "enum" ||
    !["image_size", "resolution"].includes(param.name) ||
    !param.options?.length
  )
    return null;
  const presets: Record<string, { label: string; aspect: number }> = {
    square: { label: "Square", aspect: 1 },
    square_hd: { label: "Square HD", aspect: 1 },
    portrait_4_3: { label: "3:4", aspect: 3 / 4 },
    portrait_3_4: { label: "3:4", aspect: 3 / 4 },
    portrait_16_9: { label: "9:16", aspect: 9 / 16 },
    portrait_9_16: { label: "9:16", aspect: 9 / 16 },
    landscape_4_3: { label: "4:3", aspect: 4 / 3 },
    landscape_16_9: { label: "16:9", aspect: 16 / 9 },
  };
  if (
    !param.options.every((option) => typeof option === "string" && Object.hasOwn(presets, option))
  )
    return null;
  return param.options.map((option) => ({ value: String(option), ...presets[String(option)] }));
}

export function atlasIsCount(param: AtlasParam): boolean {
  return ["n", "num_images", "count", "max_images"].includes(param.name);
}

/** Enumerate only small, explicitly bounded integer ranges. Sparse enums keep their exact types. */
export function atlasControlOptions(param: AtlasParam): readonly (string | number)[] | null {
  // An optional enum without a vendor default starts unset (see
  // atlasEnumIsUnset); "" is the choice that puts it back there.
  if (param.kind === "enum")
    return atlasEnumIsUnset(param) ? ["", ...param.options!] : (param.options ?? []);
  if (
    param.kind === "integer" &&
    (atlasIsCount(param) || param.name === "duration") &&
    Number.isSafeInteger(param.min) &&
    Number.isSafeInteger(param.max) &&
    param.max! >= param.min! &&
    param.max! - param.min! <= 30
  ) {
    return Array.from({ length: param.max! - param.min! + 1 }, (_, index) => param.min! + index);
  }
  return null;
}

export function atlasToggleValues(
  param: AtlasParam,
): { on: boolean | string; off: boolean | string } | null {
  if (param.kind === "boolean") return { on: true, off: false };
  if (param.kind !== "enum" || param.options?.length !== 2) return null;
  for (const [on, off] of [
    ["yes", "no"],
    ["enabled", "disabled"],
  ]) {
    if (param.options.includes(on) && param.options.includes(off)) return { on, off };
  }
  return null;
}

export function atlasUsesSlider(param: AtlasParam): boolean {
  return (
    (param.kind === "integer" || param.kind === "number") &&
    param.name !== "seed" &&
    !atlasControlOptions(param) &&
    typeof param.min === "number" &&
    typeof param.max === "number" &&
    Number.isFinite(param.min) &&
    Number.isFinite(param.max) &&
    param.max > param.min
  );
}

export function parseAspectOption(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const aspect = Number(match[1]) / Number(match[2]);
  return Number.isFinite(aspect) && aspect > 0 ? aspect : null;
}

export function atlasHasRatioOptions(param: AtlasParam): boolean {
  const options = param.options;
  return (
    param.kind === "enum" &&
    !!options?.length &&
    options.every(
      (option) => parseAspectOption(option) !== null || option === "auto" || option === "adaptive",
    ) &&
    (options.some((option) => parseAspectOption(option) !== null) ||
      ["ratio", "aspect_ratio"].includes(param.name))
  );
}

export function atlasOptionLabel(param: AtlasParam, option: string | number): string {
  const text = String(option);
  if (text === "") return "Default";
  if (param.name === "duration") return text === "-1" ? "Auto (−1)" : `${text} s`;
  if (["format", "output_format"].includes(param.name))
    return text === "default" ? "Default" : text.toUpperCase();
  // Keep distinct provider tiers, including SR/ESR and their frame-rate suffixes.
  if (
    ["resolution", "target_resolution", "output_resolution"].includes(param.name) &&
    /^\d+(?:p|k)(?:-|$)/i.test(text)
  ) {
    return text.replace(/^(\d+)p/i, "$1p").replace(/^(\d+)k/i, "$1K");
  }
  const names: Record<string, string> = {
    auto: "Auto",
    adaptive: "Adaptive",
    default: "Default",
    low: "Low",
    medium: "Medium",
    high: "High",
    standard: "Standard",
    fast: "Fast",
  };
  return names[text] ?? text;
}
