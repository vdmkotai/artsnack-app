/**
 * The API composer's decisions, as data, for the native app.
 *
 * On the web these live in React components — api-panel.tsx (edits, submit,
 * reproduce), api-form.tsx and atlas-params.tsx (which controls show, with
 * which options and prices), model-switcher.tsx and atlas-model-picker.tsx.
 * The rules they apply are all in packages/shared; this module only composes
 * them the way those components do and returns plain JSON: the form after an
 * edit, a description of every control, and a submit plan. The native side
 * draws what it is told and sends edits back, so pricing, clamping, routing and
 * validation stay the shared code's.
 *
 * Runs on a worker thread (crates/rules/src/worker.rs): the Atlas catalogue is
 * large and every view prices each option through the form normaliser.
 */
// First, so the web globals QuickJS lacks exist before any module runs.
import "./globals";
import * as apiResults from "./api-results";
import { expose } from "./bridge";
import {
  API_MODELS,
  GROK_VIDEO_MODEL_V15,
  VIDEO_COUNTS,
  getApiModel,
  higgsfieldVideoModel,
  imageAspectRatios,
  imageMaxReferences,
  isApiModelId,
  isGrokImageQuality,
  isGrokVideoMode,
  isGrokVideoModelId,
  maxAttachableReferences,
  modelsForProvider,
  resolveImageRatio,
  videoDurations,
  videoResolutions,
  type ApiModel,
  type ApiModelId,
  type GrokVideoMode,
  type MediaType,
  type VideoTier,
} from "../../../../../packages/shared/api-models";
import {
  priceForVariant,
  variantFor,
  variantSignature,
  variantsToQuote,
  type QuoteMap,
} from "../../../../../packages/shared/api-price";
import {
  formatMetered,
  formatPrice,
  usdPrice,
  type Price,
} from "../../../../../packages/shared/api-pricing";
import {
  atlasCountOptions,
  atlasFormParams,
  atlasImageCountHint,
  ATLAS_IMAGE_MODES,
  atlasCatalogRows,
  atlasImageModes,
  atlasFamilyMaxReferences,
  atlasFamilyReadsTags,
  atlasFrameSlots,
  atlasMaxReferences,
  atlasPromptValue,
  atlasReferenceHint,
  atlasScalarParams,
  atlasUnsupportedParams,
  atlasVariants,
  atlasVendors,
  clampAtlasValue,
  getAtlasModel,
  isAtlasModelId,
  resolveAtlasVariant,
  type AtlasModel,
  type AtlasParam,
  type AtlasParamValue,
} from "../../../../../packages/shared/atlas-models";
import {
  atlasControlLabel,
  atlasControlOptions,
  atlasHasRatioOptions,
  atlasIsCount,
  atlasNamedSizeOptions,
  atlasOptionLabel,
  atlasToggleValues,
  atlasUsesSlider,
  parseAspectOption,
} from "../../../../../packages/shared/atlas-control-presentation";
import { dimensionOptionGroups } from "../../../../../packages/shared/atlas-dimension-options";
import {
  ATLAS_SIZE_TIERS,
  dimensionPresets,
  dimensionsFor,
  formatDimensions,
  matchPreset,
  parseDimensions,
  specialSizeNote,
} from "../../../../../packages/shared/atlas-dimensions";
import { buildAtlasRequest } from "../../../../../packages/shared/atlas-payload";
import {
  atlasResolutionSetsPrice,
  hasAtlasPrice,
  quoteAtlas,
  quoteAtlasImages,
} from "../../../../../packages/shared/atlas-price";
import {
  defaultAtlasRecord,
  readAtlasRecords,
  remapAtlasReferenceDetails,
} from "../../../../../packages/shared/atlas-records";
import { validateAtlasReferences } from "../../../../../packages/shared/atlas-reference-validation";
import {
  GROK_FRAME_ROLE_CHOICES,
  grokRoleBadge,
  parseGrokFrameRole,
  parseGrokSourceVideo,
  remapGrokFrameRoles,
  resolveGrokFrameRoles,
  withGrokFrameRole,
  withGrokKeyframeTime,
  type GrokFrameRole,
  type GrokFrameRoleName,
  type GrokSourceVideo,
  type GrokVideoOptions,
} from "../../../../../packages/shared/grok-imagine";
import {
  getGrokReferenceTagIndices,
  restoreGrokReferenceTags,
} from "../../../../../packages/shared/grok-prompt";
import { OUTPUT_PREFIXES, isGrokSourceVideoKey } from "../../../../../packages/shared/image-key";
import {
  DEFAULT_API_FORM,
  activeAtlasModelId,
  activeAtlasParams,
  atlasJobsFor,
  grokVideoOptionsFor,
  hydrateForm,
  normalizeForm,
  withActiveAtlasModel,
  withActiveAtlasParams,
  withAtlasRow,
  withRegistryModel,
  type ApiFormState,
  type ComposerProvider,
} from "../../../../../packages/shared/normalize-form";
import {
  atlasEnhanceContext,
  type EnhanceContext,
} from "../../../../../packages/shared/prompt-enhance";
import {
  TENCENT_UPSCALER,
  tencentLongEdge,
  tencentOutputSize,
  tencentSizing,
} from "../../../../../packages/shared/tencent-upscale";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A selected reference, as the native side knows it after preparing it. */
type RefInfo = { id: string; width: number; height: number; aspect: number; bytes: number };

type ViewContext = {
  /** Selected references, in order. */
  refs: RefInfo[];
  /** Higgsfield quotes by signature (`higgsfield.listCosts`). */
  quotes: Record<string, number>;
  /** Providers switched off in Settings. */
  hiddenProviders: ComposerProvider[];
  /** Starred Atlas models (`atlasFavorites.list`). */
  favorites: string[];
};

type Edit =
  | { kind: "field"; field: keyof ApiFormState; value: unknown }
  | { kind: "provider"; provider: ComposerProvider }
  | { kind: "model"; id: ApiModelId }
  | { kind: "atlasModel"; id: string }
  | { kind: "atlasParam"; name: string; value: AtlasParamValue }
  | { kind: "atlasDimensions"; name: string; width: number; height: number }
  | { kind: "tencentLongEdge"; pixels: number }
  | { kind: "recordField"; param: string; index: number; field: string; value: AtlasParamValue }
  | { kind: "recordAdd"; param: string }
  | { kind: "recordRemove"; param: string; index: number }
  | { kind: "voice"; voice: string }
  /** The selection of references changed: ids selected before and after. */
  | { kind: "references"; previous: string[]; next: string[] }
  /** Grok 1.5: what the selected image at `index` does in the clip. */
  | { kind: "grokRole"; index: number; role: GrokFrameRoleName }
  /** Grok 1.5: a keyframe's time, in seconds. */
  | { kind: "grokKeyframeTime"; index: number; at: number }
  /**
   * Grok Edit/Extend: the source clip, or null to clear it. With a clip the
   * form moves to Grok video, on `mode` when it came from a result's menu.
   */
  | { kind: "grokSource"; source: GrokSourceVideo | null; mode?: "edit" | "extend" }
  | { kind: "normalize" };

type EditResult = { form: ApiFormState; adjustments: string[] };

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function defaults(): ApiFormState {
  return DEFAULT_API_FORM;
}

/** A persisted form, or the defaults when it no longer type-checks. */
function hydrate(raw: string | null): ApiFormState {
  return hydrateForm(raw);
}

function maxReferencesFor(form: ApiFormState): number {
  return form.provider === "atlas"
    ? atlasFamilyMaxReferences(getAtlasModel(activeAtlasModelId(form)))
    : maxAttachableReferences(getApiModel(form.model));
}

/** How many references the form's model takes at all (attach capacity). */
function capacity(form: ApiFormState): number {
  return maxReferencesFor(form);
}

function setRecords(
  form: ApiFormState,
  param: string,
  update: (
    rows: Record<string, AtlasParamValue>[],
    definition: AtlasParam,
  ) => Record<string, AtlasParamValue>[],
  referenceCount: number,
): ApiFormState {
  const model = getAtlasModel(activeAtlasModelId(form));
  const definition = model.params.find((entry) => entry.name === param);
  if (!definition) return form;
  const params = activeAtlasParams(form);
  let stored: Record<string, AtlasParamValue>[] = [];
  try {
    stored = readAtlasRecords(params[param]);
  } catch {
    stored = [];
  }
  const count = definition.kind === "image-record-list" ? referenceCount : stored.length;
  const rows = Array.from({ length: count }, (_, index) => ({
    ...defaultAtlasRecord(definition, index),
    ...stored[index],
  }));
  return withActiveAtlasParams(form, {
    ...params,
    [param]: JSON.stringify(update(rows, definition)),
  });
}

/** Applies one edit and keeps the form legal, as the web panel's handlers do. */
function apply(input: ApiFormState, edit: Edit, refs: RefInfo[]): EditResult {
  const refCount = refs.length;
  let form = input;
  switch (edit.kind) {
    case "field":
      form = { ...form, [edit.field]: edit.value } as ApiFormState;
      break;
    case "provider": {
      if (edit.provider === form.provider) return { form, adjustments: [] };
      if (edit.provider === "atlas") {
        form = { ...form, provider: "atlas" };
        break;
      }
      // Keep the model name across providers where both offer it.
      const candidates = modelsForProvider(edit.provider);
      const current = API_MODELS[form.model];
      const sameLabel = candidates.find((candidate) => candidate.label === current?.label);
      form = { ...form, provider: edit.provider, model: (sameLabel ?? candidates[0]).id };
      break;
    }
    case "model":
      form = withRegistryModel(form, edit.id);
      break;
    case "atlasModel":
      form = withActiveAtlasModel(form, edit.id);
      break;
    case "atlasParam":
      form = withActiveAtlasParams(form, { ...activeAtlasParams(form), [edit.name]: edit.value });
      break;
    case "atlasDimensions":
      form = withActiveAtlasParams(form, {
        ...activeAtlasParams(form),
        [edit.name]: formatDimensions({ width: edit.width, height: edit.height }),
      });
      break;
    case "tencentLongEdge":
      form = withActiveAtlasParams(form, {
        ...activeAtlasParams(form),
        ...tencentLongEdge(edit.pixels),
      });
      break;
    case "recordField":
      form = setRecords(
        form,
        edit.param,
        (rows) =>
          rows.map((row, index) =>
            index === edit.index ? { ...row, [edit.field]: edit.value } : row,
          ),
        refCount,
      );
      break;
    case "recordAdd":
      form = setRecords(
        form,
        edit.param,
        (rows, definition) => [...rows, defaultAtlasRecord(definition, rows.length)],
        refCount,
      );
      break;
    case "recordRemove":
      form = setRecords(
        form,
        edit.param,
        (rows) => rows.filter((_, index) => index !== edit.index),
        refCount,
      );
      break;
    case "voice": {
      const selected = form.videoVoices.includes(edit.voice);
      form = {
        ...form,
        videoVoices: selected
          ? form.videoVoices.filter((entry) => entry !== edit.voice)
          : [...form.videoVoices, edit.voice],
      };
      break;
    }
    case "grokRole":
      form = {
        ...form,
        grokFrameRoles: withGrokFrameRole(
          form.grokFrameRoles,
          refCount,
          edit.index,
          edit.role,
          form.duration,
        ),
      };
      break;
    case "grokKeyframeTime":
      form = {
        ...form,
        grokFrameRoles: withGrokKeyframeTime(
          form.grokFrameRoles,
          refCount,
          edit.index,
          edit.at,
          form.duration,
        ),
      };
      break;
    case "grokSource": {
      // The web panel's applySourceVideo: a clip makes it a Grok video form.
      const source = parseGrokSourceVideo(edit.source);
      if (!source) {
        form = { ...form, grokSourceVideo: null };
        break;
      }
      form = {
        ...withRegistryModel(form, "grok"),
        mediaType: "video",
        grokVideoMode:
          edit.mode ?? (form.grokVideoMode === "generate" ? "edit" : form.grokVideoMode),
        grokSourceVideo: source,
      };
      break;
    }
    case "references":
      // Grok's roles are per selected image, by position, so they move with
      // their images; skipped when nothing was attached before (a reload or a
      // reproduce, whose roles arrive with the form).
      if (
        edit.previous.length > 0 &&
        form.grokFrameRoles.length > 0 &&
        edit.previous.join("\n") !== edit.next.join("\n")
      ) {
        form = {
          ...form,
          grokFrameRoles: remapGrokFrameRoles(form.grokFrameRoles, edit.previous, edit.next),
        };
      }
      // Subject and type details stay bound to their attachment when the
      // selection changes (the web's applyRefImages).
      if (form.provider === "atlas" && edit.previous.length > 0) {
        form = withActiveAtlasParams(
          form,
          remapAtlasReferenceDetails(
            getAtlasModel(activeAtlasModelId(form)),
            activeAtlasParams(form),
            edit.previous,
            edit.next,
          ),
        );
      }
      break;
    case "normalize":
      break;
  }
  return normalizeForm(form, refCount);
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

type PriceText = { text: string; pending: boolean; tooltip?: string; included: boolean };

function priceText(price: Price | null): PriceText {
  return {
    text: formatPrice(price),
    pending: price === null,
    included: price?.currency === "included",
    tooltip:
      price === null
        ? "Asking Higgsfield for a quote"
        : price.currency === "unknown"
          ? price.reason
          : undefined,
  };
}

/** Where an edit made on a control goes. */
type Target =
  | { kind: "field"; field: keyof ApiFormState }
  | { kind: "atlasParam"; name: string }
  | { kind: "recordField"; param: string; index: number; field: string }
  | { kind: "voice" };

type Option = {
  value: unknown;
  label: string;
  price?: string | null;
  disabled?: boolean;
  tooltip?: string;
  /** Width ÷ height for a ratio tile; null draws a shapeless (dashed) tile. */
  aspect?: number | null;
};

type Common = {
  key: string;
  label: string;
  hint?: string;
  required?: boolean;
  /** Spans both columns of the field grid. */
  wide: boolean;
  /** Control under the label rather than beside it. */
  stacked: boolean;
  /** Small print under the control. */
  notes?: string[];
};

type Field =
  | (Common & {
      kind: "choice";
      /** buttons: a segmented row; select: a dropdown; tiles: ratio tiles. */
      style: "buttons" | "select" | "tiles";
      options: Option[];
      value: unknown;
      target: Target;
      uppercase?: boolean;
      capitalize?: boolean;
    })
  | (Common & {
      kind: "multi";
      options: Option[];
      values: string[];
      max: number;
      target: Target;
    })
  | (Common & {
      kind: "switch";
      checked: boolean;
      on: AtlasParamValue;
      off: AtlasParamValue;
      target: Target;
    })
  | (Common & {
      kind: "number";
      /** "" is unset (a seed left to the vendor). */
      value: number | "";
      min?: number;
      max?: number;
      integer: boolean;
      slider: boolean;
      unsettable: boolean;
      target: Target;
    })
  | (Common & {
      kind: "text";
      value: string;
      multiline: boolean;
      url: boolean;
      target: Target;
    })
  | (Common & { kind: "list"; value: string[]; url: boolean; target: Target })
  | (Common & {
      kind: "dimensions";
      name: string;
      value: string;
      allowAuto: boolean;
      specials: { value: string; label: string }[];
      tiers: { value: string; presets: { value: string; ratio: string }[]; seed: string }[];
      matched: { ratio: string; tier: string } | null;
      size: { width: number; height: number } | null;
      note: string | null;
      limits: string;
    })
  | (Common & {
      kind: "sizes";
      name: string;
      value: string;
      specials: string[];
      groups: {
        ratio: string;
        aspect: number;
        options: { value: string; width: number; height: number }[];
      }[];
    })
  | (Common & {
      kind: "records";
      param: string;
      attached: boolean;
      rows: { title: string; removable: boolean; fields: Field[] }[];
      canAdd: boolean;
      addLabel: string;
    })
  | (Common & { kind: "tencent"; tencent: TencentView })
  /** Grok Edit/Extend's source clip: what is set, and what length it may be. */
  | (Common & {
      kind: "grokSource";
      source: {
        key: string;
        seconds: number;
        resolution: string;
        /** Outside the mode's length limit: drawn as an error. */
        outside: boolean;
      } | null;
      /** "up to 8.7 s", "2–15 s". */
      limit: string;
    })
  | { kind: "note"; key: string; text: string; tone: "muted" | "danger" | "warning" }
  | { kind: "unsupported"; key: string; names: string; hint: string };

type TencentView = {
  longEdge: number | null;
  multiplier: boolean;
  percent: number;
  safe: boolean;
  legacyNote: string | null;
  lockedText: string;
  source: { width: number; height: number } | null;
  output: { width: number; height: number } | null;
  megapixels: string | null;
  scale: number | null;
  type: string;
  format: string;
  quality: number;
};

const TIER_LABELS: Record<VideoTier, string> = { mini: "Mini", fast: "Fast", standard: "Standard" };
const PROVIDER_LABELS: Record<ComposerProvider, string> = {
  grok: "Grok",
  higgsfield: "Higgsfield",
  fal: "fal.ai",
  atlas: "Atlas Cloud",
};
const PROVIDER_ORDER: ComposerProvider[] = ["grok", "higgsfield", "fal", "atlas"];

/** Beyond this many choices a segmented row wraps into an unreadable block. */
const MAX_SEGMENTED_OPTIONS = 8;
/** Past this many characters of option labels a row takes the full width. */
const SEGMENTED_CHAR_BUDGET = 18;

function atlasLayout(param: AtlasParam): { wide: boolean; stacked: boolean } {
  if (atlasHasRatioOptions(param) || atlasNamedSizeOptions(param))
    return { wide: true, stacked: true };
  if (atlasIsCount(param)) return { wide: true, stacked: false };
  if (atlasToggleValues(param)) return { wide: false, stacked: false };
  switch (param.kind) {
    case "boolean":
      return { wide: false, stacked: false };
    case "dimensions":
    case "string-list":
      return { wide: true, stacked: true };
    case "string":
      return param.multiline ? { wide: true, stacked: true } : { wide: false, stacked: false };
    case "enum": {
      const options = param.options ?? [];
      if (dimensionOptionGroups(options)) return { wide: true, stacked: true };
      if (options.length > MAX_SEGMENTED_OPTIONS) return { wide: false, stacked: false };
      const chars = options.reduce<number>((total, option) => total + String(option).length, 0);
      return { wide: chars > SEGMENTED_CHAR_BUDGET, stacked: false };
    }
    case "integer":
    case "number":
      return { wide: atlasUsesSlider(param), stacked: false };
    default:
      return { wide: true, stacked: true };
  }
}

/**
 * The inline price of each option of one view, only where options actually
 * differ in price. Every (parameter, value) is quoted once per view: a field
 * prices each of its options against all the others, which quoted afresh would
 * be the square of the option count in calls to the pricing formula.
 */
function atlasOptionPricer(
  model: AtlasModel,
  params: Record<string, AtlasParamValue>,
  jobs: number,
  referenceCount: number,
): (name: string, value: AtlasParamValue) => string | null {
  const quotes = new Map<string, ReturnType<typeof quoteAtlas>>();
  const alternativesByName = new Map<string, AtlasParamValue[]>();
  const at = (name: string, candidate: AtlasParamValue) => {
    const key = `${name}\u0000${JSON.stringify(candidate)}`;
    let quote = quotes.get(key);
    if (!quote) {
      quote = quoteAtlas({
        model: model.id,
        params: { ...params, [name]: candidate },
        jobs,
        referenceCount,
      });
      quotes.set(key, quote);
    }
    return quote;
  };
  const alternativesOf = (name: string) => {
    let alternatives = alternativesByName.get(name);
    if (!alternatives) {
      const param = model.params.find((entry) => entry.name === name);
      alternatives =
        (param ? atlasControlOptions(param)?.slice() : null) ??
        (param?.kind === "boolean" ? [true, false] : []);
      alternativesByName.set(name, alternatives);
    }
    return alternatives;
  };
  return (name, value) => {
    const quote = at(name, value);
    if (!hasAtlasPrice(quote)) return null;
    const varies = alternativesOf(name).some((candidate) => {
      const other = at(name, candidate);
      return hasAtlasPrice(other) ? other.usd !== quote.usd : true;
    });
    if (!varies) return null;
    return quote.usd >= 1 ? `$${quote.usd.toFixed(2)}` : `$${quote.usd.toFixed(3)}`;
  };
}

function atlasField(
  param: AtlasParam,
  value: AtlasParamValue | undefined,
  target: Target,
  key: string,
  priceWith: ((name: string, value: AtlasParamValue) => string | null) | null,
  referenceCount: number,
): Field {
  const current = clampAtlasValue(param, value);
  const { wide, stacked } = atlasLayout(param);
  const label = atlasControlLabel(param);
  const common = { key, label, hint: param.description, required: param.required, wide, stacked };
  const price = (option: AtlasParamValue) => (priceWith ? priceWith(param.name, option) : null);

  if (param.kind === "record-list" || param.kind === "image-record-list") {
    let stored: Record<string, AtlasParamValue>[] = [];
    try {
      stored = readAtlasRecords(value);
    } catch {
      stored = [];
    }
    const attached = param.kind === "image-record-list";
    const count = attached ? referenceCount : stored.length;
    const rows = Array.from({ length: count }, (_, index) => ({
      ...defaultAtlasRecord(param, index),
      ...stored[index],
    }));
    const notes: string[] = [];
    if (param.name === "elements")
      notes.push(
        "Use <<<element_1>>>, <<<element_2>>> in the prompt to tag these subjects in order.",
      );
    if (param.imageFieldArray)
      notes.push(
        "Use the same subject ID for multiple views of one subject (up to three). Image tags follow the attached image, even when views are grouped.",
      );
    if (attached && count === 0) notes.push("Attach reference images above to set their details.");
    return {
      ...common,
      wide: true,
      stacked: true,
      kind: "records",
      param: param.name,
      attached,
      notes,
      rows: rows.map((row, index) => ({
        title: attached ? `Image ${index + 1}` : `${param.label} ${index + 1}`,
        removable: !attached,
        fields: (param.fields ?? [])
          .filter((field) => field.name !== "index")
          .map((field) =>
            atlasField(
              field,
              row[field.name],
              { kind: "recordField", param: param.name, index, field: field.name },
              `${key}:${index}:${field.name}`,
              null,
              referenceCount,
            ),
          ),
      })),
      canAdd: !attached && count < (param.maxItems ?? 9),
      addLabel:
        param.label === "Video Clips"
          ? "Add video clip"
          : param.name === "elements"
            ? "Add subject"
            : "Add shot",
    };
  }

  const toggle = atlasToggleValues(param);
  if (toggle) {
    const onPrice = price(toggle.on);
    const offPrice = price(toggle.off);
    if (onPrice || offPrice) {
      return {
        ...common,
        kind: "choice",
        style: "buttons",
        options: [
          { value: toggle.on, label: "On", price: onPrice },
          { value: toggle.off, label: "Off", price: offPrice },
        ],
        value: current,
        target,
      };
    }
    return {
      ...common,
      kind: "switch",
      checked: current === toggle.on,
      on: toggle.on,
      off: toggle.off,
      target,
    };
  }

  const options = atlasControlOptions(param);
  if (options) {
    const named = atlasNamedSizeOptions(param);
    if (named) {
      return {
        ...common,
        kind: "choice",
        style: "tiles",
        options: named.map((option) => ({
          value: option.value,
          label: option.label,
          aspect: option.aspect,
        })),
        value: String(current),
        target,
      };
    }
    const groups = dimensionOptionGroups(options);
    if (groups) {
      return {
        ...common,
        kind: "sizes",
        name: param.name,
        value: String(current),
        specials: groups.specials,
        groups: groups.groups,
      };
    }
    if (atlasHasRatioOptions(param)) {
      return {
        ...common,
        kind: "choice",
        style: "tiles",
        options: options.map((option) => {
          const label = atlasOptionLabel(param, option);
          return { value: String(option), label, aspect: parseAspectOption(label) };
        }),
        value: String(current),
        target,
      };
    }
    const segmented = atlasIsCount(param) || options.length <= MAX_SEGMENTED_OPTIONS;
    return {
      ...common,
      kind: "choice",
      style: segmented ? "buttons" : "select",
      options: options.map((option) => ({
        value: option,
        label: atlasOptionLabel(param, option),
        price: price(option),
      })),
      value: current,
      target,
    };
  }

  if (param.kind === "integer" || param.kind === "number") {
    const slider = atlasUsesSlider(param);
    const unsettable = clampAtlasValue(param, undefined) === "";
    return {
      ...common,
      kind: "number",
      value: current === "" ? "" : typeof current === "number" ? current : 0,
      min: param.min,
      max: param.max,
      integer: param.kind === "integer",
      slider,
      unsettable,
      target,
    };
  }

  if (param.kind === "dimensions") {
    const text = typeof current === "string" ? current : "";
    const special = param.specialValues?.includes(text) ?? false;
    return {
      ...common,
      kind: "dimensions",
      name: param.name,
      value: text,
      allowAuto: Boolean(param.allowAuto),
      specials: (param.specialValues ?? []).map((word) => ({
        value: word,
        label: atlasOptionLabel(param, word),
      })),
      tiers: ATLAS_SIZE_TIERS.map((tier) => ({
        value: tier.value,
        presets: dimensionPresets(param, tier.value).map((preset) => ({
          value: preset.value,
          ratio: preset.ratio,
        })),
        seed: formatDimensions(dimensionsFor(param, "1:1", tier.value)),
      })),
      matched: matchPreset(param, text),
      size: parseDimensions(text),
      note:
        text.trim() === "" ? "matches the source image" : special ? specialSizeNote(text) : null,
      limits: `Snapped to 16px. Sides ${param.minSide ?? 512}–${param.maxSide ?? 2048}${
        param.maxPixels ? `, at most ${(param.maxPixels / 1_000_000).toFixed(1)}MP` : ""
      }.`,
    };
  }

  if (param.kind === "string-list" || param.kind === "url-list") {
    return {
      ...common,
      kind: "list",
      value: Array.isArray(current) ? current.map(String) : [],
      url: param.kind === "url-list",
      target,
    };
  }

  return {
    ...common,
    kind: "text",
    value: typeof current === "string" ? current : "",
    multiline: Boolean(param.multiline),
    url: param.kind === "url",
    target,
  };
}

const TENCENT_ENGINES = ["fidelity", "super", "ultra", "standard"];

function tencentView(
  params: Record<string, AtlasParamValue>,
  source: RefInfo | undefined,
): TencentView {
  const sizing = tencentSizing(params);
  const dimensions = source ? { width: source.width, height: source.height } : undefined;
  const output = tencentOutputSize(params, dimensions);
  const multiplier = sizing.mode === "percent";
  const longEdge =
    sizing.mode === "aspect" && !!sizing.long_side && Object.keys(sizing).length === 2;
  const safe = multiplier || longEdge;
  const scale =
    dimensions && output
      ? output.width / dimensions.width
      : multiplier
        ? Number(sizing.percent)
        : null;
  const type = String(params.type ?? "ultra");
  return {
    longEdge: longEdge ? Number(sizing.long_side) : null,
    multiplier,
    percent: Number(sizing.percent ?? 2),
    safe,
    legacyNote: safe
      ? null
      : `${
          sizing.mode === "fixed"
            ? "Saved settings force dimensions and may stretch the image."
            : "Saved settings use width, height or short edge."
        } Choose a size above to use a single longest-side target and preserve proportions.`,
    lockedText:
      sizing.mode === "fixed"
        ? "Proportions are not locked in saved settings"
        : "Original proportions · no stretching or cropping",
    source: dimensions ?? null,
    output,
    megapixels: output ? ((output.width * output.height) / 1e6).toFixed(1) : null,
    scale,
    type: TENCENT_ENGINES.includes(type) ? type : "ultra",
    format: String(params.encode_format ?? "JPEG"),
    quality: Number(params.encode_quality ?? 80),
  };
}

function atlasFields(form: ApiFormState, model: AtlasModel, refs: RefInfo[]): Field[] {
  const params = activeAtlasParams(form);
  const jobs = atlasJobsFor(model, form);
  const refCount = refs.length;
  const isImage = form.mediaType === "image";
  const fields: Field[] = [];

  const family = atlasVariants(model);
  if (Object.keys(family).length > 1) {
    fields.push({
      key: "input-mode",
      kind: "choice",
      style: "select",
      label: "Input mode",
      wide: true,
      stacked: false,
      options: Object.entries(family).map(([variant, candidate]) => ({
        value: candidate!.id,
        disabled:
          resolveAtlasVariant(candidate!, refCount, form.prompt, params).id !== candidate!.id,
        label:
          variant === "text"
            ? "Text"
            : variant === "image"
              ? isImage
                ? "Image input"
                : `${atlasFrameSlots(candidate!)?.join(" / ") ?? "Image"} ${(atlasFrameSlots(candidate!)?.length ?? 1) === 1 ? "frame" : "frames"}`
              : candidate!.params.some((param) => param.name === "video_clips")
                ? "Video reference"
                : "References",
      })),
      value: model.id,
      target: { kind: "field", field: isImage ? "atlasImageModel" : "atlasVideoModel" },
    });
  }

  if (model.id === TENCENT_UPSCALER) {
    fields.push({
      key: "tencent",
      kind: "tencent",
      label: "Upscale image",
      wide: true,
      stacked: true,
      tencent: tencentView(params, refs[0]),
    });
  } else {
    const priceWith = atlasOptionPricer(model, params, jobs, refCount);
    for (const param of atlasFormParams(model)) {
      fields.push(
        atlasField(
          param,
          params[param.name],
          { kind: "atlasParam", name: param.name },
          `${model.id}:${param.name}`,
          priceWith,
          refCount,
        ),
      );
    }
  }

  // The fan-out is ours, not a vendor parameter. Clips here; images below.
  const countPrice = (count: number) => {
    const quote = quoteAtlas({ model: model.id, params, jobs: count, referenceCount: refCount });
    return formatPrice(
      quote.usd === null
        ? { currency: "unknown", reason: quote.reason ?? "" }
        : usdPrice(quote.usd),
    );
  };
  const requests = model.params.some((param) => param.name === "count");
  if (model.media === "video") {
    fields.push({
      key: "fan-out",
      kind: "choice",
      style: "buttons",
      label: requests ? "Number of requests" : "Number of videos",
      hint: "Each request is a separate run and charge. Models with Outputs per request return that many outputs from each run.",
      wide: true,
      stacked: false,
      options: VIDEO_COUNTS.map((count) => ({
        value: count,
        label: String(count),
        price: countPrice(count),
      })),
      value: form.videoCount,
      target: { kind: "field", field: "videoCount" },
    });
  } else {
    // The total: on a model that batches, normalizeForm splits it into equal
    // requests and its own batch parameter is not drawn (atlasFormParams).
    const imagesPrice = (images: number) => {
      const quote = quoteAtlasImages({ model: model.id, params, images, referenceCount: refCount });
      return formatPrice(
        quote.usd === null
          ? { currency: "unknown", reason: quote.reason ?? "" }
          : usdPrice(quote.usd),
      );
    };
    fields.push({
      key: "fan-out",
      kind: "choice",
      style: "buttons",
      label: requests ? "Number of requests" : "Number of images",
      hint: atlasImageCountHint(model),
      wide: true,
      stacked: false,
      options: atlasCountOptions(form.count).map((count) => ({
        value: count,
        label: String(count),
        price: imagesPrice(count),
      })),
      value: form.count,
      target: { kind: "field", field: "count" },
    });
  }

  if (atlasResolutionSetsPrice(model)) {
    fields.push({
      key: "tier-note",
      kind: "note",
      tone: "muted",
      text: "When resolution changes the charge, options show the confirmed tier total. If a higher tier has no confirmed rate, any base estimate is only a floor.",
    });
  }
  if (model.retired) {
    fields.push({
      key: "retired",
      kind: "note",
      tone: "danger",
      text: "Atlas no longer lists this model. Its saved settings are shown here; choose an available model to generate.",
    });
  }
  const unsupported = atlasUnsupportedParams(model);
  if (unsupported.length > 0) {
    const names = unsupported.map((param) => param.name).join(", ");
    fields.push({
      key: "unsupported",
      kind: "unsupported",
      names,
      hint: `${model.label} also accepts ${names} — structured input this form cannot collect. ${
        unsupported.length === 1 ? "It is" : "They are"
      } optional and left unset.`,
    });
  }
  return fields;
}

const GROK_MODE_HINTS: Record<GrokVideoMode, string> = {
  generate: "A new clip from the prompt, and any images you attach.",
  edit: "Changes a clip of up to 8.7 s and keeps its length, shape and resolution (up to 720p). Say what must stay the same.",
  extend:
    "Continues a 2–15 s clip from its last frame. The result is the clip plus the added seconds, at up to 720p.",
};

/** Grok video's mode, model and source clip (the web's GrokVideoModeRow and source slot). */
function grokVideoFields(
  form: ApiFormState,
  options: GrokVideoOptions,
  priceFor: (overrides: Partial<ApiFormState>) => string | null,
): Field[] {
  const fields: Field[] = [
    {
      key: "grok-mode",
      kind: "choice",
      style: "buttons",
      label: "Mode",
      hint: GROK_MODE_HINTS[form.grokVideoMode],
      wide: true,
      stacked: true,
      options: options.modes.map((mode) => ({ value: mode.value, label: mode.label })),
      value: form.grokVideoMode,
      target: { kind: "field", field: "grokVideoMode" },
    },
  ];
  if (options.models) {
    const selected = options.models.find((entry) => entry.id === form.grokVideoModel);
    fields.push({
      key: "grok-model",
      kind: "choice",
      style: "buttons",
      label: "Video model",
      hint: selected?.note,
      wide: true,
      stacked: true,
      options: options.models.map((entry) => ({
        value: entry.id,
        label: entry.label,
        tooltip: entry.note,
        price: priceFor({ grokVideoModel: entry.id }),
      })),
      value: form.grokVideoModel,
      target: { kind: "field", field: "grokVideoModel" },
    });
  } else {
    fields.push({
      key: "grok-model",
      kind: "note",
      tone: "muted",
      text: "Video model: grok-imagine-video — the model that edits and extends.",
    });
  }
  if (options.source) {
    const range = options.source;
    const source = form.grokSourceVideo;
    fields.push({
      key: "grok-source",
      kind: "grokSource",
      label: "Source video",
      hint: `An mp4 of ${range.min > 0 ? `${range.min}–${range.max} s` : `up to ${range.max} s`}. Use "Edit/Extend with Grok" on any of your clips, or upload one.`,
      wide: true,
      stacked: true,
      limit: range.min > 0 ? `${range.min}–${range.max} s` : `up to ${range.max} s`,
      source: source
        ? {
            key: source.key,
            seconds: source.seconds,
            resolution: source.resolution,
            outside: source.seconds > range.max || source.seconds < range.min,
          }
        : null,
    });
  }
  return fields;
}

function registryFields(
  form: ApiFormState,
  model: ApiModel,
  refs: RefInfo[],
  quotes: QuoteMap,
): Field[] {
  const refCount = refs.length;
  const isImage = form.mediaType === "image";
  const imageCaps = model.image;
  const videoCaps = model.video;
  const hfVideo =
    videoCaps.kind === "higgsfield-video"
      ? higgsfieldVideoModel(videoCaps, form.videoJobType)
      : null;
  const fields: Field[] = [];
  // A SuperGrok price shows the quota it meters, where there is a figure.
  const priceString = (price: Price | null) =>
    price && price.currency === "included" ? formatMetered(price) : formatPrice(price);

  const imagePriceFor = (sizeTier: string, count: number, quality?: string) =>
    priceString(
      priceForVariant(
        model,
        {
          mediaType: "image",
          sizeTier,
          count,
          aspectRatio: form.aspectRatio,
          quality: quality ?? form.quality,
        },
        refCount,
        quotes,
      ),
    );
  // Grok's mode, model, roles and source ride along in the variant.
  const videoPriceFor = (overrides: Partial<ApiFormState> = {}) =>
    priceString(
      priceForVariant(
        model,
        variantFor(form, { mediaType: "video", ...overrides }, refCount),
        refCount,
        quotes,
      ),
    );
  /** Everything the Grok video form shows, from the shared rules. */
  const grokVideo =
    !isImage && videoCaps.kind === "grok" ? grokVideoOptionsFor(form, refCount) : null;
  const buttons = (
    key: string,
    label: string,
    options: Option[],
    value: unknown,
    field: keyof ApiFormState,
    extra: Partial<Common> & { uppercase?: boolean; capitalize?: boolean } = {},
  ): Field => ({
    key,
    kind: "choice",
    style: "buttons",
    label,
    wide: true,
    stacked: true,
    options,
    value,
    target: { kind: "field", field },
    ...extra,
  });

  if (grokVideo) fields.push(...grokVideoFields(form, grokVideo, videoPriceFor));

  // A pinned first frame or a source clip sets a Grok clip's shape.
  const showAspectRatio = isImage || (grokVideo ? grokVideo.aspectRatios !== null : refCount !== 1);
  if (showAspectRatio) {
    const ratios = isImage
      ? imageAspectRatios(imageCaps, form.quality)
      : (grokVideo?.aspectRatios ?? hfVideo?.aspectRatios ?? videoCaps.aspectRatios);
    fields.push(
      buttons(
        "aspect-ratio",
        "Aspect ratio",
        ratios.map((ratio) => ({ value: ratio, label: ratio })),
        form.aspectRatio,
        "aspectRatio",
      ),
    );
  }

  if (isImage) {
    if (imageCaps.kind === "grok") {
      fields.push(
        buttons(
          "quality",
          "Quality",
          imageCaps.qualities.map((quality) => ({
            value: quality.value,
            label: quality.label,
            price: imagePriceFor(form.imageSizeTier, form.count, quality.value),
          })),
          form.quality,
          "quality",
          { wide: imageCaps.sizeTiers.length <= 1 },
        ),
      );
    }
    if (imageCaps.sizeTiers.length > 1) {
      fields.push(
        buttons(
          "size-tier",
          imageCaps.kind === "higgsfield-image" && imageCaps.sizeParam === "quality"
            ? "Quality"
            : "Resolution",
          imageCaps.sizeTiers.map((tier) => ({
            value: tier.value,
            label: tier.label,
            price: imagePriceFor(tier.value, form.count),
          })),
          form.imageSizeTier,
          "imageSizeTier",
          { wide: imageCaps.kind !== "grok" },
        ),
      );
    }
    if (imageCaps.counts.length > 1) {
      const notes: string[] = [];
      if (refCount > 0 && imageCaps.kind === "grok")
        notes.push("Reference edits run as parallel Grok requests.");
      if (refCount > 1 && model.id === "seedream-5-pro")
        notes.push("Pro charges $0.0045 per reference beyond the first, per image.");
      if (imageCaps.kind === "higgsfield-image" && form.count > 1)
        notes.push("Higgsfield has no batch parameter, so each image is a separate job.");
      fields.push(
        buttons(
          "count",
          "Number of images",
          imageCaps.counts.map((count) => ({
            value: count,
            label: String(count),
            price: imagePriceFor(form.imageSizeTier, count),
          })),
          form.count,
          "count",
          { notes },
        ),
      );
    }
    return fields;
  }

  if (videoCaps.kind === "higgsfield-video") {
    fields.push(
      buttons(
        "video-model",
        "Video model",
        videoCaps.models.map((video) => ({
          value: video.jobType,
          label: video.label,
          price: videoPriceFor({ videoJobType: video.jobType }),
        })),
        form.videoJobType,
        "videoJobType",
        {
          notes:
            hfVideo && !hfVideo.supportsReferences
              ? [
                  `${hfVideo.label} animates a start frame. Prompt tagging with @image is a Seedance feature and does nothing here.`,
                ]
              : [],
        },
      ),
    );
  }
  if (hfVideo?.modeParam) {
    fields.push(
      buttons(
        "video-mode",
        hfVideo.modeParam.name.charAt(0).toUpperCase() + hfVideo.modeParam.name.slice(1),
        hfVideo.modeParam.values.map((value) => ({
          value,
          label: value,
          price: videoPriceFor({ videoMode: value }),
        })),
        form.videoMode,
        "videoMode",
        {
          uppercase: true,
          notes:
            hfVideo.jobType === "seedance_2_0" && form.videoMode === "fast"
              ? ["Fast mode is limited to 480p and 720p."]
              : [],
        },
      ),
    );
  }
  if (videoCaps.kind === "seedance") {
    fields.push(
      buttons(
        "video-tier",
        "Quality tier",
        videoCaps.tiers.map((tier) => ({
          value: tier,
          label: TIER_LABELS[tier],
          price: videoPriceFor({ videoTier: tier }),
        })),
        form.videoTier,
        "videoTier",
      ),
    );
  }
  if (grokVideo) {
    // Generate's length, Extend's added seconds, or nothing on Edit.
    if (grokVideo.durationField) {
      const field = grokVideo.durationField;
      fields.push({
        key: "duration",
        kind: "choice",
        // Fifteen lengths do not fit a segmented row.
        style: grokVideo.durations.length > 8 ? "select" : "buttons",
        label: field === "grokExtendDuration" ? "Add" : "Duration",
        wide: true,
        stacked: true,
        options: grokVideo.durations.map((seconds) => ({
          value: seconds,
          label: `${seconds}s`,
          price: videoPriceFor({ [field]: seconds }),
        })),
        value: form[field],
        target: { kind: "field", field },
      });
    }
  } else {
    fields.push(
      buttons(
        "duration",
        "Duration",
        videoDurations(videoCaps, form.videoJobType).map((seconds) => ({
          value: seconds,
          label: `${seconds}s`,
          price: videoPriceFor({ duration: seconds }),
        })),
        form.duration,
        "duration",
      ),
    );
  }
  const resolutions = grokVideo
    ? grokVideo.resolutions
    : videoResolutions(
        videoCaps,
        form.videoTier,
        form.videoJobType,
        form.videoMode,
        refCount,
        videoCaps.kind === "grok" ? form.videoVoices.length : 0,
      );
  if (resolutions.length > 1) {
    fields.push(
      buttons(
        "resolution",
        "Resolution",
        resolutions.map((resolution) => ({
          value: resolution,
          label: resolution,
          price: videoPriceFor({ resolution }),
        })),
        form.resolution,
        "resolution",
      ),
    );
  }
  if (grokVideo?.voices) {
    fields.push({
      key: "voices",
      kind: "multi",
      label: "Voices",
      wide: true,
      stacked: true,
      options: grokVideo.voices.map((voice) => ({ value: voice, label: voice })),
      values: form.videoVoices,
      max: grokVideo.maxVoices,
      target: { kind: "voice" },
      notes: [
        `Up to ${grokVideo.maxVoices} preset voices the subjects speak with — reference them in the prompt as <AUDIO_0>, <AUDIO_1>, … or let the model assign them. Any voice makes the clip reference-to-video, which caps it at 720p.`,
      ],
    });
  }
  fields.push(
    buttons(
      "video-count",
      "Number of videos",
      VIDEO_COUNTS.map((count) => ({
        value: count,
        label: String(count),
        price: videoPriceFor({ videoCount: count }),
      })),
      form.videoCount,
      "videoCount",
      { notes: ["Each clip is a separate run on the same prompt — and a separate charge."] },
    ),
  );
  // What would stop the click, said before it.
  for (const [index, issue] of (grokVideo?.issues ?? []).entries()) {
    fields.push({ key: `grok-issue-${index}`, kind: "note", tone: "danger", text: issue });
  }
  if (videoCaps.kind === "seedance" || hfVideo?.audioParam) {
    fields.push(
      buttons(
        "audio",
        "Audio",
        [
          { value: true, label: "On", price: videoPriceFor({ generateAudio: true }) },
          { value: false, label: "Off", price: videoPriceFor({ generateAudio: false }) },
        ],
        form.generateAudio,
        "generateAudio",
        { wide: false },
      ),
    );
    if (videoCaps.kind === "seedance" && videoCaps.bitrateModeByTier[form.videoTier]) {
      fields.push(
        buttons(
          "bitrate",
          "Bitrate",
          (["standard", "high"] as const).map((mode) => ({ value: mode, label: mode })),
          form.bitrateMode,
          "bitrateMode",
          { wide: false, capitalize: true },
        ),
      );
    }
  }
  return fields;
}

type CatalogRow = {
  key: string;
  id: string;
  label: string;
  variants: string[];
  vendor: string;
  priceText: string;
  priceUnit: string;
  inputLabel: string;
  family: string;
  /** The image picker's tabs this row is on (`atlasImageModes`); empty for video. */
  modes: string[];
};

function catalogRow(row: ReturnType<typeof atlasCatalogRows>[number]): CatalogRow {
  const references = atlasFamilyMaxReferences(row.model);
  const sourceTypes = [
    ...new Set(
      atlasScalarParams(row.model).flatMap((param) => {
        if (param.name === "video_clips") return ["video"];
        return (param.kind === "url" || param.kind === "url-list") &&
          (param.role === "video" || param.role === "audio")
          ? [param.role]
          : [];
      }),
    ),
  ];
  const video = row.model.media === "video";
  return {
    key: row.key,
    id: row.model.id,
    label: row.label,
    variants: row.variants.map(
      (variant) => ({ text: "text", image: "image input", reference: "references" })[variant],
    ),
    vendor: row.vendor,
    priceText: row.basePrice === null ? "—" : `${video ? "from " : ""}$${row.basePrice}`,
    priceUnit: row.basePrice !== null && video ? "/s" : "",
    inputLabel:
      references > 0
        ? `${references} image ref${references === 1 ? "" : "s"}`
        : sourceTypes.length
          ? `${sourceTypes.join(" + ")} input`
          : "text",
    family: row.model.family,
    modes: atlasImageModes(row),
  };
}

type Catalog = {
  rows: CatalogRow[];
  vendors: ReturnType<typeof atlasVendors>;
  /** The image picker's tabs; none for video. */
  modes: typeof ATLAS_IMAGE_MODES;
};

/**
 * The catalogue only changes with an app update, so each media type's rows
 * are built and sorted once per worker, not on every Atlas edit (the starred
 * chips are read from it) or picker opening.
 */
const catalogs = new Map<MediaType, Catalog>();

/** One media type's rows and vendor rail for the Atlas picker. */
function catalog(media: MediaType): Catalog {
  let cached = catalogs.get(media);
  if (!cached) {
    cached = {
      rows: atlasCatalogRows(media).map(catalogRow),
      vendors: atlasVendors(media),
      modes: media === "image" ? ATLAS_IMAGE_MODES : [],
    };
    catalogs.set(media, cached);
  }
  return cached;
}

function atlasModelSummary(model: AtlasModel) {
  return {
    id: model.id,
    label: model.label,
    rate:
      model.basePrice === null
        ? "no price"
        : `${model.media === "video" ? "from " : ""}$${model.basePrice}/${model.media === "video" ? "s" : "img"}`,
    rateTooltip:
      model.basePrice === null
        ? "The vendor publishes no price for this model."
        : model.media === "video"
          ? `Atlas publishes $${model.basePrice}/s as the cheapest resolution tier. The selected settings determine the actual price.`
          : `$${model.basePrice} per image.`,
  };
}

function videoModelLabel(form: ApiFormState): string | null {
  const caps = API_MODELS[form.model]?.video;
  if (!caps) return null;
  switch (caps.kind) {
    case "grok":
      return "Grok Imagine";
    case "seedance":
      return "Seedance 2.0";
    case "higgsfield-video":
      return higgsfieldVideoModel(caps, form.videoJobType).label;
  }
}

/** Everything the composer draws for `form`. */
function view(form: ApiFormState, context: ViewContext) {
  const refs = context.refs;
  const refCount = refs.length;
  const quotes: QuoteMap = new Map(Object.entries(context.quotes));
  const model = getApiModel(form.model);
  const atlas = form.provider === "atlas" ? getAtlasModel(activeAtlasModelId(form)) : null;
  const isImage = form.mediaType === "image";

  // --- Switcher ---------------------------------------------------------
  const providers = PROVIDER_ORDER.filter(
    (candidate) => candidate === form.provider || !context.hiddenProviders.includes(candidate),
  ).map((id) => ({ id, label: PROVIDER_LABELS[id] }));
  let modelRow: unknown = null;
  if (atlas) {
    const favorites = new Set(context.favorites);
    const starred = catalog(form.mediaType).rows.filter(
      (row) => favorites.has(row.id) || favorites.has(row.key),
    );
    modelRow = { kind: "atlas", model: atlasModelSummary(atlas), starred };
  } else if (!isImage) {
    const label = videoModelLabel(form);
    modelRow = label ? { kind: "video", label } : null;
  } else {
    const models = modelsForProvider(form.provider as ApiModel["provider"]);
    modelRow =
      models.length > 1
        ? {
            kind: "registry",
            models: models.map((entry) => ({ id: entry.id, label: entry.label })),
            selected: form.model,
          }
        : null;
  }

  // --- References -------------------------------------------------------
  const hfVideo =
    !atlas && model.video.kind === "higgsfield-video"
      ? higgsfieldVideoModel(model.video, form.videoJobType)
      : null;
  const videoMaxReferences = hfVideo
    ? hfVideo.supportsReferences
      ? hfVideo.maxReferences
      : (hfVideo.supportsStartFrame ? 1 : 0) + (hfVideo.supportsEndFrame ? 1 : 0)
    : model.video.maxReferences;
  // Grok's caps depend on more than the model: the image quality (2.0 takes
  // five), and the video mode and model (Lite takes one, Edit and Extend none).
  const grokVideo =
    !atlas && !isImage && model.video.kind === "grok" ? grokVideoOptionsFor(form, refCount) : null;
  const imageMax = imageMaxReferences(model.image, form.quality);
  const familyMax = maxReferencesFor(form);
  const attachLimit = atlas
    ? familyMax
    : Math.min(
        familyMax,
        isImage ? imageMax : grokVideo ? grokVideo.maxImages : videoMaxReferences,
      );
  const activeMax = atlas
    ? atlasMaxReferences(atlas)
    : isImage
      ? imageMax
      : (grokVideo?.maxImages ?? model.video.maxReferences);
  const frameSlots: string[] | null = atlas
    ? atlasFrameSlots(atlas)
    : !isImage && hfVideo && !hfVideo.supportsReferences
      ? [
          ...(hfVideo.supportsStartFrame ? ["Start"] : []),
          ...(hfVideo.supportsEndFrame ? ["End"] : []),
        ]
      : // Grok 1.5 Lite animates one start image and reads no tags.
        grokVideo && grokVideo.maxImages > 0 && !grokVideo.frameRoleChoices
        ? ["Start"]
        : null;
  // On 1.5 each image says what it does: a reference, a pinned frame, a keyframe.
  const grokRoles: GrokFrameRole[] | null = grokVideo?.frameRoleChoices
    ? resolveGrokFrameRoles(form.grokFrameRoles, refCount)
    : null;
  const grokKeyframes = grokRoles?.filter((entry) => entry.role === "keyframe").length ?? 0;
  const maxKeyframes = model.video.kind === "grok" ? model.video.maxKeyframes : 0;

  let inputMode: unknown = null;
  if (atlas && !isImage) {
    const family = atlasVariants(atlas);
    if (family.image && family.reference) {
      const frames = family.image;
      const references = family.reference;
      const slots = atlasFrameSlots(frames);
      const framesLabel = slots?.length ? slots.join(" & ") : "Frames";
      inputMode = {
        framesId: frames.id,
        referencesId: references.id,
        current:
          atlas.id === references.id ? "references" : atlas.id === frames.id ? "frames" : null,
        framesLabel,
        description: `${
          slots?.length === 1
            ? `Fixed ${framesLabel.toLowerCase()} frame`
            : `Fixed ${framesLabel.toLowerCase()} frame positions`
        }, or visual references${atlasFamilyReadsTags(references) ? " you can tag in the prompt" : ""}.`,
        framesAvailable:
          resolveAtlasVariant(frames, refCount, form.prompt, activeAtlasParams(form)).id ===
            frames.id && refCount <= atlasMaxReferences(frames),
      };
    }
  }
  const issues = atlas
    ? validateAtlasReferences(
        atlas,
        refs.map((ref) => ({
          width: ref.width,
          height: ref.height,
          aspect: ref.aspect,
          bytes: ref.bytes,
        })),
      ).map((issue) => ({ index: issue.referenceIndex, message: issue.message }))
    : [];
  const references =
    attachLimit === 0
      ? null
      : {
          heading: frameSlots
            ? `${frameSlots.join(" & ")} frame${frameSlots.length > 1 ? "s" : ""} (optional)`
            : "Reference images (optional)",
          hint: atlas
            ? atlasReferenceHint(atlas, attachLimit)
            : frameSlots
              ? `${hfVideo?.label ?? "This model"} takes ${frameSlots.length > 1 ? "positions, not tags" : "a start frame, not tags"} — the first selected image is the ${frameSlots[0]?.toLowerCase()} frame${frameSlots[1] ? `, the second the ${frameSlots[1].toLowerCase()} frame` : ""}.`
              : isImage
                ? `Tag them in the prompt with @image1, @image2… (numbers follow the badges). Image editing uses up to ${imageMax} selected references.`
                : grokRoles
                  ? `Up to ${grokVideo?.maxImages} images. Choose under each what it does: a reference (tag it @image1, @image2…), the first or last frame, both (a loop), or a keyframe the clip passes through at a set time — up to ${maxKeyframes}. Left alone, one image is the first frame and two or more are references.`
                  : `Tag them in the prompt with @image1, @image2… (numbers follow the badges). 1 reference = first frame; 2+ = style/content guides (up to ${hfVideo?.maxReferences ?? model.video.maxReferences}).`,
          attachLimit,
          slots: refs.map((_, index) =>
            frameSlots
              ? (frameSlots[index] ?? null)
              : grokRoles?.[index]
                ? grokRoleBadge(grokRoles[index], index + 1)
                : `${index + 1}`,
          ),
          /** Grok 1.5: each selected image's role menu, in selection order. */
          roles: grokRoles
            ? grokRoles.map((entry) => ({
                value: entry.role,
                options: GROK_FRAME_ROLE_CHOICES.map((choice) => ({
                  value: choice.role,
                  label: choice.label,
                  tooltip: choice.hint,
                  disabled:
                    choice.role === "keyframe" &&
                    entry.role !== "keyframe" &&
                    grokKeyframes >= maxKeyframes,
                })),
                keyframe:
                  entry.role === "keyframe"
                    ? {
                        at: entry.at ?? 0,
                        min: 0.33,
                        max: Math.max(0.33, form.duration - 0.33),
                      }
                    : null,
              }))
            : null,
          frames: frameSlots !== null,
          inputMode,
          issues,
          overCapacity:
            refCount > activeMax
              ? `${atlas?.label ?? model.label} accepts ${activeMax} references for ${isImage ? "images" : "video"} — deselect ${refCount - activeMax}.`
              : null,
        };

  // --- Prompt -----------------------------------------------------------
  const tagging = atlas
    ? atlasFamilyReadsTags(atlas)
    : frameSlots === null && grokVideo?.maxImages !== 0;
  const placeholder =
    atlas && !atlasFamilyReadsTags(atlas)
      ? "Describe what you want to see..."
      : grokVideo?.plan.mode === "edit"
        ? "Describe the change, and what must stay the same..."
        : grokVideo?.plan.mode === "extend"
          ? "Describe what happens next..."
          : frameSlots
            ? "Describe the motion you want..."
            : "Describe what you want to see... Type @ to tag a reference image.";
  const enhance: EnhanceContext = atlas
    ? atlasEnhanceContext(atlas, activeAtlasParams(form), refCount)
    : {
        media: form.mediaType,
        targetModel: model.label,
        duration: isImage ? undefined : form.duration,
        aspectRatio: isImage || refCount !== 1 ? form.aspectRatio : undefined,
        referenceCount: refCount,
      };

  // --- Controls and price -------------------------------------------------
  const fields = atlas ? atlasFields(form, atlas, refs) : registryFields(form, model, refs, quotes);
  let price: Price | null;
  if (atlas) {
    const quote = quoteAtlas({
      model: atlas.id,
      params: activeAtlasParams(form),
      jobs: atlasJobsFor(atlas, form),
      referenceCount: refCount,
    });
    price =
      quote.usd === null
        ? { currency: "unknown", reason: quote.reason ?? "" }
        : usdPrice(quote.usd);
  } else {
    // Grok's metered quota depends on the quality, mode, model and source.
    price = priceForVariant(model, variantFor(form, {}, refCount), refCount, quotes);
  }

  return {
    provider: form.provider,
    mediaType: form.mediaType,
    /**
     * What the controls on screen are drawn for. An edit made on them belongs
     * to this model (an Atlas family, whose endpoints share one parameter bag),
     * and is dropped if it reaches a form showing another.
     */
    identity: atlas
      ? `atlas:${form.mediaType}:${atlas.family}`
      : `${form.provider}:${form.mediaType}:${form.model}`,
    providers,
    modelRow,
    prompt: { placeholder, tagging },
    references,
    /** What a hand-off may fill: `maxReferencesFor` on the web. */
    addLimit: familyMax,
    fields,
    price: priceText(price),
    buttonLabel: isImage ? "Generate Image" : "Generate Video",
    retired: Boolean(atlas?.retired),
    enhance,
    /**
     * Prompt Studio's `StudioContext`, exactly the fields
     * `promptStudioRun.send` validates (the web's `studioContextArgs`).
     */
    studio: {
      media: enhance.media,
      targetModel: enhance.targetModel,
      duration: enhance.duration,
      aspectRatio: enhance.aspectRatio,
      referenceCount: enhance.referenceCount,
      frameInputs: enhance.frameInputs,
      tagsInPrompt: tagging && refCount > 0,
      frameSlots: frameSlots && frameSlots.length > 0 ? frameSlots : undefined,
      referenceRoles: grokRoles?.map((entry) =>
        entry.role === "keyframe" ? `keyframe at ${entry.at} seconds` : entry.role,
      ),
    },
    /** Grok refs are re-encoded to its smaller profile at submit. */
    downsizeForGrok: form.provider === "grok",
  };
}

/**
 * One edit and the view after it, in one call: the native side sends edits one
 * at a time and redraws from the answer. The prompt travels apart from the
 * form: the text field owns it, and the rest of the form is the last answer
 * handed back unchanged.
 */
function step(form: ApiFormState, prompt: string, edit: Edit, context: ViewContext) {
  const result = apply({ ...form, prompt }, edit, context.refs);
  return { ...result, view: view(result.form, context) };
}

// ---------------------------------------------------------------------------
// Higgsfield quotes
// ---------------------------------------------------------------------------

/** Configurations on screen with no quote yet, with the action's arguments. */
function quoteRequests(form: ApiFormState, refCount: number, known: string[]) {
  if (form.provider !== "higgsfield") return [];
  const model = getApiModel(form.model);
  if (model.provider !== "higgsfield") return [];
  const have = new Set(known);
  const seen = new Set<string>();
  const requests: { signature: string; args: Record<string, unknown> }[] = [];
  for (const variant of variantsToQuote(model, form, refCount)) {
    const signature = variantSignature(model, variant, refCount);
    if (!signature || have.has(signature) || seen.has(signature)) continue;
    seen.add(signature);
    requests.push({
      signature,
      args: {
        model: model.id,
        mediaType: variant.mediaType,
        aspectRatio: variant.aspectRatio,
        sizeTier: variant.sizeTier,
        videoJobType: variant.videoJobType,
        videoMode: variant.videoMode,
        generateAudio: variant.generateAudio,
        duration: variant.duration,
        resolution: variant.resolution,
        referenceCount: refCount,
      },
    });
  }
  return requests;
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

type Plan =
  | { error: string }
  | {
      kind: "atlas";
      args: {
        model: string;
        prompt: string;
        params: Record<string, AtlasParamValue>;
        jobs: number;
      };
      creating: string;
    }
  | { kind: "image"; args: Record<string, unknown>; creating: string }
  | {
      kind: "video";
      args: Record<string, unknown>;
      creating: string;
      /** Grok Edit/Extend send no images: attached ones are left out, not uploaded. */
      skipReferences?: boolean;
    };

/**
 * What the Generate button sends, or why it cannot: the web's handleGenerate
 * and generateAtlas checks, in their order. References are uploaded by the
 * caller and added to `args`.
 */
function plan(form: ApiFormState, refs: RefInfo[], grokConnected: boolean | null): Plan {
  const refCount = refs.length;
  const rawPrompt = form.prompt.trim();

  if (form.provider === "atlas") {
    const active = getAtlasModel(activeAtlasModelId(form));
    if (active.retired)
      return { error: "Atlas no longer lists this model. Choose an available model to generate." };
    const promptRequired = active.params.some((param) => param.name === "prompt" && param.required);
    if (promptRequired && !rawPrompt) return { error: "Please enter a prompt" };
    const capacityNow = atlasMaxReferences(active);
    if (refCount > capacityNow) {
      return {
        error:
          capacityNow === 0
            ? `${active.label} does not accept reference images — deselect them`
            : `${active.label} takes up to ${capacityNow} reference${capacityNow === 1 ? "" : "s"} — deselect some`,
      };
    }
    const invalid = validateAtlasReferences(
      active,
      refs.map((ref) => ({
        width: ref.width,
        height: ref.height,
        aspect: ref.aspect,
        bytes: ref.bytes,
      })),
    )[0];
    if (invalid) return { error: invalid.message };
    const jobs = atlasJobsFor(active, form);
    // A dry run with placeholder URLs, so a payload error surfaces before any upload.
    try {
      const promptValue = atlasPromptValue(active, rawPrompt);
      buildAtlasRequest({
        model: active.id,
        params: {
          ...activeAtlasParams(form),
          ...(promptValue === undefined ? {} : { prompt: promptValue }),
        },
        referenceUrls: Array.from({ length: refCount }, (_, index) => `pending://${index}`),
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Failed to start generation" };
    }
    return {
      kind: "atlas",
      args: { model: active.id, prompt: rawPrompt, params: activeAtlasParams(form), jobs },
      creating: "Creating Atlas job...",
    };
  }

  const model = getApiModel(form.model);
  if (!rawPrompt) return { error: "Please enter a prompt" };
  if (model.provider === "grok" && grokConnected === false) {
    return { error: "Connect your Grok account first, or pick a Seedream model" };
  }
  const tags = getGrokReferenceTagIndices(rawPrompt);
  const maxTag = tags.length > 0 ? Math.max(...tags) : 0;
  if (tags.some((index) => index < 1)) return { error: "Image tags start at @image1" };
  if (maxTag > refCount) {
    return {
      error: `Prompt references @image${maxTag} but only ${refCount} reference${refCount === 1 ? " is" : "s are"} selected`,
    };
  }
  const caps = form.mediaType === "image" ? model.image : model.video;
  const hfVideo =
    form.mediaType === "video" && model.video.kind === "higgsfield-video"
      ? higgsfieldVideoModel(model.video, form.videoJobType)
      : null;
  // Grok video's own rules — pins, keyframes, Lite's single image, the source
  // clip's length — from the list the form shows and the mutation checks.
  const grokVideo =
    form.mediaType === "video" && model.video.kind === "grok"
      ? grokVideoOptionsFor(form, refCount)
      : null;
  const grokIssue = grokVideo?.issues[0];
  if (grokIssue) return { error: grokIssue };
  // Edit and Extend send no images, so attached ones are left out, not refused.
  const grokEditing = grokVideo !== null && grokVideo.plan.mode !== "generate";
  const maxRefs = hfVideo
    ? hfVideo.supportsReferences
      ? hfVideo.maxReferences
      : (hfVideo.supportsStartFrame ? 1 : 0) + (hfVideo.supportsEndFrame ? 1 : 0)
    : grokVideo
      ? grokVideo.maxImages
      : form.mediaType === "image"
        ? imageMaxReferences(model.image, form.quality)
        : caps.maxReferences;
  if (refCount > maxRefs && !grokEditing) {
    const label = hfVideo?.label ?? model.label;
    return {
      error:
        maxRefs === 0
          ? `${label} does not accept reference images — deselect them`
          : `${label} supports up to ${maxRefs} selected reference${maxRefs === 1 ? "" : "s"} — deselect some`,
    };
  }

  if (form.mediaType === "image") {
    return {
      kind: "image",
      creating: "Creating generation job...",
      args: {
        model: form.model,
        prompt: rawPrompt,
        // fal is sent explicit pixels, so "auto" is settled here where the
        // reference dimensions are known. Grok resolves it server-side.
        aspectRatio:
          model.provider === "fal"
            ? resolveImageRatio(form.aspectRatio, model.image.aspectRatios, refs[0]?.aspect)
            : form.aspectRatio,
        count: form.count,
        quality: form.quality,
        resolution: form.imageSizeTier,
      },
    };
  }
  const seedance = model.video.kind === "seedance";
  const higgsfield = model.video.kind === "higgsfield-video";
  const source = grokEditing ? form.grokSourceVideo : null;
  // Only roles the person chose are sent: an all-automatic list is what the
  // server assumes anyway, and leaving it out keeps a plain request what a
  // backend from before roles accepts.
  const frameRoles = form.grokFrameRoles.slice(0, refCount).map((role) => parseGrokFrameRole(role));
  const sendRoles =
    grokVideo !== null &&
    !grokEditing &&
    grokVideo.frameRoleChoices !== null &&
    frameRoles.some((role) => role !== null);
  return {
    kind: "video",
    creating: "Creating generation job...",
    skipReferences: grokEditing,
    args: {
      model: form.model,
      prompt: rawPrompt,
      duration: form.duration,
      // Edit and Extend follow the source, capped at 720p.
      resolution: source ? source.resolution : form.resolution,
      aspectRatio: grokVideo
        ? grokVideo.aspectRatios === null
          ? undefined
          : grokVideo.aspectRatios.includes(form.aspectRatio)
            ? form.aspectRatio
            : "16:9"
        : refCount === 1
          ? undefined
          : model.video.aspectRatios.includes(form.aspectRatio)
            ? form.aspectRatio
            : "16:9",
      videoTier: seedance ? form.videoTier : undefined,
      videoJobType: higgsfield ? form.videoJobType : undefined,
      videoMode: higgsfield ? form.videoMode : undefined,
      generateAudio: seedance || higgsfield ? form.generateAudio : undefined,
      bitrateMode: seedance ? form.bitrateMode : undefined,
      count: form.videoCount,
      referenceVoices:
        grokVideo?.voices && form.videoVoices.length > 0 ? form.videoVoices : undefined,
      // Each new field only where it says something: Generate on 1.5 is the
      // request it always was.
      grokVideoMode:
        grokVideo && grokVideo.plan.mode !== "generate" ? grokVideo.plan.mode : undefined,
      grokVideoModel:
        grokVideo && !grokEditing && form.grokVideoModel !== GROK_VIDEO_MODEL_V15
          ? form.grokVideoModel
          : undefined,
      frameRoles: sendRoles ? frameRoles : undefined,
      sourceVideoKey: source?.key,
      sourceVideoSeconds: source?.seconds,
      extendDuration: grokVideo?.plan.mode === "extend" ? form.grokExtendDuration : undefined,
    },
  };
}

/** The B2 key an attachment came from, when it is one of the app's outputs. */
function referenceSourceKey(key: string | null): string | null {
  if (!key) return null;
  const clean = key.replace(/^cdn-cgi\/image\/[^/]+\//, "").split(/[?#]/)[0];
  return clean.startsWith("generations/") ||
    Object.values(OUTPUT_PREFIXES).some((prefix) => clean.startsWith(`${prefix}/`))
    ? clean
    : null;
}

// ---------------------------------------------------------------------------
// Reproduce
// ---------------------------------------------------------------------------

type Row = {
  provider?: string;
  apiModel?: string;
  atlasParams?: Record<string, AtlasParamValue>;
  mediaType: MediaType;
  prompt: string;
  aspectRatio?: string;
  count?: number;
  quality?: string;
  resolution?: string;
  duration?: number;
  videoTier?: string;
  videoJobType?: string;
  videoMode?: string;
  generateAudio?: boolean;
  bitrateMode?: string;
  referenceVoices?: string[];
  hasReferenceImage: boolean;
  referenceB2Keys?: string[];
  grokVideoModel?: string;
  grokVideoMode?: string;
  grokFrameRoles?: GrokFrameRole[];
  sourceVideoKey?: string;
  sourceVideoSeconds?: number;
};

/** The registry id a row was made with (`modelIdOf` in api-results.tsx). */
function modelIdOf(row: Row): ApiModelId {
  return row.apiModel && isApiModelId(row.apiModel) ? row.apiModel : "grok";
}

/**
 * The form a row reproduces: the web's `recreate`. `restoredReferences` is how
 * many of its references the caller managed to bring back.
 */
function recreate(form: ApiFormState, row: Row, restoredReferences: number) {
  const referenceB2Keys = row.referenceB2Keys ?? [];
  const restoredModel = modelIdOf(row);
  const isAtlas = row.provider === "atlas" && !!row.apiModel && isAtlasModelId(row.apiModel);
  const base = isAtlas
    ? withAtlasRow(form, getAtlasModel(row.apiModel!), row.atlasParams ?? {})
    : withRegistryModel(form, restoredModel);
  const video = row.mediaType === "video";
  // Grok video rows carry their mode, model, roles and source clip; a row from
  // before those existed means Generate on 1.5 with the automatic roles.
  const grokVideoRow = video && (row.provider ?? "grok") === "grok";
  const grokMode: GrokVideoMode =
    grokVideoRow && isGrokVideoMode(row.grokVideoMode) ? row.grokVideoMode : "generate";
  const editingRow = grokVideoRow && grokMode !== "generate";
  const sourceKey =
    editingRow && row.sourceVideoKey && isGrokSourceVideoKey(row.sourceVideoKey)
      ? row.sourceVideoKey
      : undefined;
  const next: ApiFormState = {
    ...base,
    model: isAtlas ? base.model : restoredModel,
    videoCount: 1,
    mediaType: row.mediaType,
    prompt: restoreGrokReferenceTags(row.prompt, referenceB2Keys.length),
    aspectRatio: row.aspectRatio ?? (video ? "16:9" : "auto"),
    count: row.count ?? base.count,
    quality: isGrokImageQuality(row.quality) ? row.quality : form.quality,
    videoVoices:
      video && (row.provider ?? "grok") === "grok" ? (row.referenceVoices ?? []) : form.videoVoices,
    imageSizeTier: !video ? (row.resolution ?? form.imageSizeTier) : form.imageSizeTier,
    // An edit's resolution is its source's and an extension's duration is the
    // added length — neither is Generate's setting.
    duration: video && !editingRow ? (row.duration ?? form.duration) : form.duration,
    resolution: video && !editingRow ? (row.resolution ?? form.resolution) : form.resolution,
    grokVideoMode: grokVideoRow ? grokMode : form.grokVideoMode,
    grokVideoModel:
      grokVideoRow && !editingRow
        ? isGrokVideoModelId(row.grokVideoModel)
          ? row.grokVideoModel
          : GROK_VIDEO_MODEL_V15
        : form.grokVideoModel,
    // The references are replaced wholesale, so roles kept from the old set
    // would describe pictures that are gone.
    grokFrameRoles:
      grokVideoRow && !editingRow && Array.isArray(row.grokFrameRoles) ? row.grokFrameRoles : [],
    grokExtendDuration:
      grokMode === "extend" ? (row.duration ?? form.grokExtendDuration) : form.grokExtendDuration,
    // Absent fields arrive from the native row as null, not undefined.
    grokSourceVideo:
      sourceKey && typeof row.sourceVideoSeconds === "number"
        ? {
            key: sourceKey,
            seconds: row.sourceVideoSeconds,
            resolution: row.resolution === "480p" ? "480p" : "720p",
          }
        : form.grokSourceVideo,
    videoTier: (row.videoTier as VideoTier | undefined) ?? form.videoTier,
    videoJobType: video ? (row.videoJobType ?? form.videoJobType) : form.videoJobType,
    videoMode: video ? (row.videoMode ?? form.videoMode) : form.videoMode,
    generateAudio: row.generateAudio ?? form.generateAudio,
    bitrateMode:
      row.provider === "fal" && video
        ? row.bitrateMode === "high"
          ? "high"
          : "standard"
        : form.bitrateMode,
  };
  const notice =
    row.hasReferenceImage && referenceB2Keys.length === 0
      ? {
          tone: "warning",
          text: "Settings restored, but references are unavailable for this older generation",
        }
      : restoredReferences > 0
        ? {
            tone: "success",
            text: `Settings and ${restoredReferences} reference image${restoredReferences === 1 ? "" : "s"} restored`,
          }
        : { tone: "success", text: "Settings restored" };
  return { form: normalizeForm(next, restoredReferences).form, notice };
}

expose({
  /** Labels, prices and details for the API results grid (api-results.ts). */
  apiResults,
  composer: {
    defaults,
    hydrate,
    apply,
    view,
    step,
    capacity,
    quoteRequests,
    plan,
    referenceSourceKey,
    recreate,
    catalog,
  },
});
