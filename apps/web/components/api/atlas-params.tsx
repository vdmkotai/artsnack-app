"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FieldGrid, FieldRow, InfoHint } from "@/components/api/field-row";
import {
  atlasFormParams,
  atlasUnsupportedParams,
  clampAtlasValue,
  type AtlasModel,
  type AtlasParam,
  type AtlasParamValue,
} from "@/lib/atlas-models";
import {
  ATLAS_SIZE_TIERS,
  dimensionPresets,
  dimensionsFor,
  formatDimensions,
  matchPreset,
  parseDimensions,
  specialSizeNote,
  type AtlasSizeTier,
} from "@/lib/atlas-dimensions";
import { defaultAtlasRecord, readAtlasRecords } from "@/lib/atlas-records";
import { atlasResolutionSetsPrice, hasAtlasPrice, quoteAtlas } from "@/lib/atlas-price";
import { cn } from "@/lib/utils";
import { TencentUpscaleParams } from "@/components/api/tencent-upscale-params";
import { TENCENT_UPSCALER, type ImageDimensions } from "@/lib/tencent-upscale";
import { ChoiceOptions } from "@/components/api/choice-options";
import { AspectRatioOptions } from "@/components/api/aspect-ratio-options";
import {
  atlasControlLabel,
  atlasControlOptions,
  atlasToggleValues,
  atlasUsesSlider,
  atlasHasRatioOptions,
  atlasIsCount,
  atlasOptionLabel,
  atlasNamedSizeOptions,
} from "@/lib/atlas-control-presentation";
import { DimensionOptions, dimensionOptionGroups } from "@/components/api/dimension-options";

/**
 * Renders an Atlas model's controls from its own schema.
 *
 * Most controls come directly from the catalogue. Tencent's image upscaler
 * has a dedicated size editor because its sizing fields are alternatives,
 * not independent controls. For the generic renderer, the catalogue says a
 * parameter is an enum of `["480p","720p"]` with a default of `"480p"`, and
 * this draws two buttons; it says another is an integer bounded at
 * [-1, 4294967295], and this draws a number field. That is the whole reason
 * 300 models cost the same to support as one — and the reason a model Atlas
 * adds next month works after a `bun run atlas:sync` and no code.
 *
 * `prompt` is deliberately skipped: the composer already has a prompt box with
 * saved prompts and @-tagging attached to it, and a second plain textarea for
 * the same field would be worse in every way.
 *
 * Layout is dense on purpose, and the density is also derived from the schema
 * rather than chosen per model. Each parameter is one row — name and control on
 * the same line, the vendor's description behind an info icon — and each row
 * claims one or two of the two grid columns according to how much room its
 * control actually needs. Across the catalogue that puts 84% of the 1104
 * parameters in half a row, which is what keeps a seven-parameter model from
 * pushing the Generate button 660px down the panel.
 */

/** Beyond this many choices a segmented row wraps into an unreadable block. */
const MAX_SEGMENTED_OPTIONS = 8;

/**
 * Past this many characters of option labels, a segmented row cannot share a
 * line with its own name and stay legible, so it takes the full width.
 */
const SEGMENTED_CHAR_BUDGET = 18;

/**
 * How much of the two-column grid a control needs.
 *
 * Read off `kind`, option count and label length — never off the parameter's
 * name — so a model nobody has seen yet lays itself out correctly.
 */
function controlLayout(param: AtlasParam): { wide: boolean; stacked: boolean } {
  if (atlasHasRatioOptions(param) || atlasNamedSizeOptions(param))
    return { wide: true, stacked: true };
  if (atlasIsCount(param)) return { wide: true, stacked: false };
  if (atlasToggleValues(param)) return { wide: false, stacked: false };
  switch (param.kind) {
    case "boolean":
      return { wide: false, stacked: false };
    case "dimensions":
      // A ratio row plus a tier row plus the pixel readout. Nothing about that
      // fits beside a label.
      return { wide: true, stacked: true };
    case "string-list":
      return { wide: true, stacked: true };
    case "string":
      return param.multiline ? { wide: true, stacked: true } : { wide: false, stacked: false };
    case "enum": {
      const options = param.options ?? [];
      if (dimensionOptionGroups(options)) return { wide: true, stacked: true };
      // Long enums collapse to a select, which is narrow whatever it holds.
      if (options.length > MAX_SEGMENTED_OPTIONS) return { wide: false, stacked: false };
      const chars = options.reduce<number>((total, option) => total + String(option).length, 0);
      return { wide: chars > SEGMENTED_CHAR_BUDGET, stacked: false };
    }
    case "integer":
    case "number": {
      const sliderable = atlasUsesSlider(param);
      return { wide: Boolean(sliderable), stacked: false };
    }
    default:
      // Media parameters never reach here — atlasFormParams filters them out —
      // but a kind added by a future sync should get a whole row, not a crash.
      return { wide: true, stacked: true };
  }
}

export function AtlasParams({
  model,
  params,
  onChange,
  jobs,
  disabled,
  referenceCount = 0,
  referenceDimensions,
}: {
  model: AtlasModel;
  referenceCount?: number;
  referenceDimensions?: ImageDimensions;
  params: Record<string, AtlasParamValue>;
  onChange: (name: string, value: AtlasParamValue) => void;
  /** Fan-out count, so the per-option prices match what the button will charge. */
  jobs: number;
  disabled?: boolean;
}) {
  const controls = atlasFormParams(model);
  const unsupported = atlasUnsupportedParams(model);

  /**
   * Cost of the current settings with one parameter swapped, for inline prices.
   *
   * Returns null when the swap changes nothing. Atlas prices video by duration
   * and images by count. Most parameters therefore quote the same figure;
   * printing it beside each option would imply a cost difference that does not
   * exist. A price is only worth showing where it is actually a difference.
   */
  const priceWith = React.useCallback(
    (name: string, value: AtlasParamValue): string | null => {
      const at = (candidate: AtlasParamValue) =>
        quoteAtlas({ model: model.id, params: { ...params, [name]: candidate }, jobs });

      const quote = at(value);
      if (!hasAtlasPrice(quote)) return null;

      const param = model.params.find((entry) => entry.name === name);
      const alternatives: AtlasParamValue[] =
        (param ? atlasControlOptions(param)?.slice() : null) ??
        (param?.kind === "boolean" ? [true, false] : []);
      const varies = alternatives.some((candidate) => {
        const other = at(candidate);
        return hasAtlasPrice(other) ? other.usd !== quote.usd : true;
      });
      if (!varies) return null;

      return quote.usd >= 1 ? `$${quote.usd.toFixed(2)}` : `$${quote.usd.toFixed(3)}`;
    },
    [model.id, model.params, params, jobs],
  );

  if (model.id === TENCENT_UPSCALER) {
    return (
      <TencentUpscaleParams
        params={params}
        onChange={onChange}
        source={referenceDimensions}
        disabled={disabled}
      />
    );
  }

  if (controls.length === 0 && unsupported.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <FieldGrid>
        {controls.map((param) => (
          <AtlasControl
            key={`${model.id}:${param.name}`}
            param={param}
            value={params[param.name]}
            onChange={(value) => onChange(param.name, value)}
            priceWith={priceWith}
            disabled={disabled}
            referenceCount={referenceCount}
          />
        ))}
      </FieldGrid>

      {/* Was three lines of prose explaining that a parameter exists and is not
          being sent. 45 of the 264 models have one, and none of them can act on
          it — so it states the fact and keeps the explanation in the tooltip. */}
      {/* Atlas's model catalogue publishes only a "from" rate. Known tier
          prices appear on the choices; unknown ones remain explicitly a floor. */}
      {atlasResolutionSetsPrice(model) && (
        <p className="text-xs text-muted-foreground">
          When resolution changes the charge, options show the confirmed tier total. If a higher
          tier has no confirmed rate, any base estimate is only a floor.
        </p>
      )}

      {model.retired && (
        <p className="text-xs text-destructive">
          Atlas no longer lists this model. Its saved settings are shown here; choose an available
          model to generate.
        </p>
      )}
      {unsupported.length > 0 && (
        <div className="flex items-center gap-1 pt-0.5">
          <span className="text-[11px] text-muted-foreground">Not settable here:</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {unsupported.map((param) => param.name).join(", ")}
          </span>
          <InfoHint
            text={`${model.label} also accepts ${unsupported
              .map((param) => param.name)
              .join(", ")} — structured input this form cannot collect. ${
              unsupported.length === 1 ? "It is" : "They are"
            } optional and left unset.`}
          />
        </div>
      )}
    </div>
  );
}

function AtlasControl({
  param,
  value,
  onChange,
  priceWith,
  disabled,
  referenceCount = 0,
}: {
  param: AtlasParam;
  referenceCount?: number;
  value: AtlasParamValue | undefined;
  onChange: (value: AtlasParamValue) => void;
  priceWith: (name: string, value: AtlasParamValue) => string | null;
  disabled?: boolean;
}) {
  const current = clampAtlasValue(param, value);
  const { wide, stacked } = controlLayout(param);

  return (
    <FieldRow
      label={atlasControlLabel(param)}
      hint={param.description}
      required={param.required}
      wide={wide}
      stacked={stacked}
    >
      {param.kind === "record-list" || param.kind === "image-record-list" ? (
        <RecordList
          param={param}
          value={value}
          onChange={onChange}
          disabled={disabled}
          referenceCount={referenceCount}
        />
      ) : (
        <Body
          param={param}
          current={current}
          onChange={onChange}
          priceWith={priceWith}
          disabled={disabled}
        />
      )}
    </FieldRow>
  );
}

/** A segmented row, sized to sit on the same line as its own label. */
function Segmented({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-0.5 rounded-md border bg-card p-0.5", className)}>
      {children}
    </div>
  );
}

function SegmentedOption({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant={active ? "default" : "ghost"}
      size="sm"
      aria-pressed={active}
      disabled={disabled}
      className="h-6 min-w-0 px-2 text-[11px] font-normal"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function Body({
  param,
  current,
  onChange,
  priceWith,
  disabled,
}: {
  param: AtlasParam;
  current: AtlasParamValue;
  onChange: (value: AtlasParamValue) => void;
  priceWith: (name: string, value: AtlasParamValue) => string | null;
  disabled?: boolean;
}) {
  const label = atlasControlLabel(param);
  const toggle = atlasToggleValues(param);
  if (toggle) {
    const onPrice = priceWith(param.name, toggle.on);
    const offPrice = priceWith(param.name, toggle.off);
    if (onPrice || offPrice) {
      return (
        <Segmented>
          {[
            { value: toggle.on, label: "On", price: onPrice },
            { value: toggle.off, label: "Off", price: offPrice },
          ].map((option) => (
            <SegmentedOption
              key={String(option.value)}
              active={current === option.value}
              disabled={disabled}
              onClick={() => onChange(option.value)}
            >
              {option.label}
              {option.price && <span className="ml-1 opacity-70">{option.price}</span>}
            </SegmentedOption>
          ))}
        </Segmented>
      );
    }
    return (
      <Switch
        checked={current === toggle.on}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked ? toggle.on : toggle.off)}
        aria-label={label}
      />
    );
  }

  const options = atlasControlOptions(param);
  if (options) {
    const namedSizes = atlasNamedSizeOptions(param);
    if (namedSizes)
      return (
        <AspectRatioOptions
          options={namedSizes}
          value={String(current)}
          label={label}
          disabled={disabled}
          onChange={onChange}
        />
      );
    const dimensionGroups = dimensionOptionGroups(options);
    if (dimensionGroups)
      return (
        <DimensionOptions
          groups={dimensionGroups.groups}
          specials={dimensionGroups.specials}
          value={current}
          label={label}
          disabled={disabled}
          onChange={onChange}
        />
      );
    if (atlasHasRatioOptions(param))
      return (
        <AspectRatioOptions
          options={options.map((value) => ({
            value: String(value),
            label: atlasOptionLabel(param, value),
          }))}
          value={String(current)}
          label={label}
          disabled={disabled}
          onChange={onChange}
        />
      );
    return (
      <ChoiceOptions
        options={options}
        value={current}
        onChange={onChange}
        label={label}
        disabled={disabled}
        segmented={atlasIsCount(param) || options.length <= MAX_SEGMENTED_OPTIONS}
        format={(option) => atlasOptionLabel(param, option)}
        price={(option) => priceWith(param.name, option)}
      />
    );
  }

  if (param.kind === "integer" || param.kind === "number") {
    const numeric = typeof current === "number" ? current : 0;
    // Bounded numeric controls share a slider and an exact number field.
    // Seeds keep their direct input regardless of the
    // presence of bounds.
    const sliderable = atlasUsesSlider(param);

    if (sliderable) {
      return (
        <span className="flex flex-1 items-center gap-2">
          <Slider
            value={[numeric]}
            min={param.min}
            max={param.max}
            step={param.kind === "integer" ? 1 : 0.1}
            disabled={disabled}
            onValueChange={(next) => {
              const first = Array.isArray(next) ? next[0] : next;
              if (typeof first === "number") onChange(first);
            }}
            className="min-w-0 flex-1"
            aria-label={label}
          />
          <NumberField param={param} value={numeric} onChange={onChange} disabled={disabled} />
        </span>
      );
    }

    return (
      <NumberField
        param={param}
        value={current === "" ? "" : numeric}
        onChange={onChange}
        disabled={disabled}
      />
    );
  }

  if (param.kind === "dimensions") {
    return <DimensionField param={param} value={current} onChange={onChange} disabled={disabled} />;
  }

  if (param.kind === "string-list" || param.kind === "url-list") {
    const list = Array.isArray(current) ? current : [];
    return (
      <Textarea
        value={list.join("\n")}
        disabled={disabled}
        rows={2}
        placeholder={param.kind === "url-list" ? "One public URL per line" : "One per line"}
        aria-label={param.label}
        className="min-h-0 py-1.5 text-xs"
        onChange={(event) =>
          onChange(event.target.value.split("\n").filter((line) => line.trim().length > 0))
        }
      />
    );
  }

  if (param.multiline) {
    return (
      <Textarea
        value={typeof current === "string" ? current : ""}
        disabled={disabled}
        rows={2}
        className="min-h-0 py-1.5 text-xs"
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <Input
      value={typeof current === "string" ? current : ""}
      disabled={disabled}
      className={cn("h-7 text-xs", param.kind === "url" ? "w-full" : "w-36")}
      type={param.kind === "url" ? "url" : "text"}
      placeholder={param.kind === "url" ? "https://…" : undefined}
      aria-label={param.label}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * Output size, as a ratio and a tier rather than a string to retype.
 *
 * The vendors take this as free text — `1024*1024` — and the generic renderer
 * drew exactly that: a text box with the default sitting in it. Nobody composes
 * an aspect ratio by editing four digits, so the ratios people actually ask for
 * are presets, the long side is a tier, and the text box stays behind "Custom"
 * for the times a specific number is the point.
 */
function DimensionField({
  param,
  value,
  onChange,
  disabled,
}: {
  param: AtlasParam;
  value: AtlasParamValue;
  onChange: (value: AtlasParamValue) => void;
  disabled?: boolean;
}) {
  const current = typeof value === "string" ? value : "";
  const matched = matchPreset(param, current);
  const special = param.specialValues?.includes(current) ?? false;
  const [custom, setCustom] = React.useState(() => current !== "" && !special && matched === null);
  const [tier, setTier] = React.useState<AtlasSizeTier>(() => matched?.tier ?? "1K");
  const [draft, setDraft] = React.useState<string | null>(null);

  const presets = React.useMemo(() => dimensionPresets(param, tier), [param, tier]);
  const size = parseDimensions(current);
  const isAuto = current.trim() === "";

  return (
    <div className="space-y-1">
      <AspectRatioOptions
        label="Aspect ratio"
        options={[
          ...(param.allowAuto ? [{ value: "", label: "Auto" }] : []),
          ...(param.specialValues ?? []).map((word) => ({
            value: word,
            label: atlasOptionLabel(param, word),
            aspect: null,
          })),
          ...presets.map((preset) => ({ value: preset.value, label: preset.ratio })),
          { value: "custom", label: "Custom" },
        ]}
        value={custom ? "custom" : current}
        disabled={disabled}
        onChange={(next) => {
          setCustom(next === "custom");
          if (next !== "custom") onChange(next);
          // From Auto or a size word there are no numbers to edit, and the
          // width/height fields only commit against a parsed size — so seed one.
          else if (!size) onChange(formatDimensions(dimensionsFor(param, "1:1", tier)));
        }}
      />

      {custom ? (
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            step={16}
            value={draft ?? String(size?.width ?? "")}
            disabled={disabled}
            onChange={(event) => {
              setDraft(null);
              const width = Number(event.target.value);
              if (Number.isFinite(width) && width > 0 && size) {
                onChange(formatDimensions({ width, height: size.height }));
              }
            }}
            className="h-7 w-20 text-xs"
            aria-label="Width"
          />
          <span className="text-xs text-muted-foreground">×</span>
          <Input
            type="number"
            step={16}
            value={String(size?.height ?? "")}
            disabled={disabled}
            onChange={(event) => {
              const height = Number(event.target.value);
              if (Number.isFinite(height) && height > 0 && size) {
                onChange(formatDimensions({ width: size.width, height }));
              }
            }}
            className="h-7 w-20 text-xs"
            aria-label="Height"
          />
          <InfoHint
            text={`Snapped to 16px. Sides ${param.minSide ?? 512}–${param.maxSide ?? 2048}${
              param.maxPixels ? `, at most ${(param.maxPixels / 1_000_000).toFixed(1)}MP` : ""
            }.`}
          />
        </div>
      ) : isAuto || special ? (
        // No shape to scale: a tier here would silently pick 1:1 for the user.
        <span className="text-[11px] text-muted-foreground">
          {isAuto ? "matches the source image" : specialSizeNote(current)}
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex gap-0.5">
            {ATLAS_SIZE_TIERS.map((entry) => (
              <Button
                key={entry.value}
                variant={tier === entry.value ? "secondary" : "ghost"}
                size="sm"
                disabled={disabled}
                aria-pressed={tier === entry.value}
                className="h-6 px-2 text-[11px] font-normal"
                onClick={() => {
                  setTier(entry.value);
                  // Keep the shape, change the scale — the ratio is the choice
                  // the user made and the tier is a knob on top of it.
                  const next = dimensionPresets(param, entry.value).find(
                    (preset) => preset.ratio === (matched?.ratio ?? "1:1"),
                  );
                  if (next) onChange(next.value);
                }}
              >
                {entry.value}
              </Button>
            ))}
          </div>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {size ? `${size.width} × ${size.height}` : current}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * A number the user can actually type.
 *
 * The obvious version — `value={n}` with `onChange={Number(...)}` straight into
 * form state — is unusable here, because every keystroke round-trips through
 * `normalizeForm` → `clampAtlasValue`, which clamps to the parameter's bounds
 * and announces the move as a toast. Clearing a duration field to retype it
 * sent `""` → `0` → clamped to the minimum; typing "12" went 1 → 15 (clamped)
 * → 15, so the user ended on the most expensive length after three toasts and
 * could not reach 12 at all.
 *
 * So the draft lives here as a string while the field has focus, and only a
 * parsed, finite value is pushed upward. Blur reconciles: an empty or unparsable
 * draft falls back to the last committed value rather than to zero.
 */
function NumberField({
  param,
  value,
  onChange,
  disabled,
}: {
  param: AtlasParam;
  /** "" is an unset seed: the vendor picks one per run. */
  value: number | "";
  onChange: (value: number | "") => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const unsettable = clampAtlasValue(param, undefined) === "";

  return (
    <Input
      type="number"
      aria-label={atlasControlLabel(param)}
      value={draft ?? String(value)}
      placeholder={unsettable ? "Random" : undefined}
      min={param.min}
      max={param.max}
      step={param.kind === "integer" ? 1 : "any"}
      disabled={disabled}
      className="h-7 w-24 text-right font-mono text-xs"
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        // Clearing an unset-able seed hands it back to the vendor.
        if (unsettable && next.trim() === "") {
          onChange("");
          return;
        }
        // Intermediate states a person types on the way to a real number:
        // empty, a lone minus, a trailing decimal point.
        if (next.trim() === "" || next === "-" || next.endsWith(".")) return;
        const parsed = Number(next);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/**
 * The rate, as a badge beside the model.
 *
 * A chip on the picker's own line rather than a sentence of prose above the
 * prompt box, which cost 40px on every single model.
 */
export function AtlasModelBadges({ model, className }: { model: AtlasModel; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1", className)}>
      <Badge
        variant="outline"
        className="h-5 px-1.5 text-[10px] font-normal tabular-nums text-muted-foreground"
        title={
          model.basePrice === null
            ? "The vendor publishes no price for this model."
            : model.media === "video"
              ? `Atlas publishes $${model.basePrice}/s as the cheapest resolution tier. The selected settings determine the actual price.`
              : `$${model.basePrice} per image.`
        }
      >
        {model.basePrice === null
          ? "no price"
          : `${model.media === "video" ? "from " : ""}$${model.basePrice}/${model.media === "video" ? "s" : "img"}`}
      </Badge>
    </span>
  );
}

function safeRecords(value: AtlasParamValue | undefined) {
  try {
    return readAtlasRecords(value);
  } catch {
    return [];
  }
}

function RecordList({
  param,
  value,
  onChange,
  disabled,
  referenceCount,
}: {
  param: AtlasParam;
  value: AtlasParamValue | undefined;
  onChange: (value: AtlasParamValue) => void;
  disabled?: boolean;
  referenceCount: number;
}) {
  const stored = safeRecords(value);
  const attached = param.kind === "image-record-list";
  const count = attached ? referenceCount : stored.length;
  const rows = Array.from({ length: count }, (_, index) => ({
    ...defaultAtlasRecord(param, index),
    ...stored[index],
  }));
  const write = (next: typeof rows) => onChange(JSON.stringify(next));
  return (
    <div className="w-full space-y-2">
      {param.name === "elements" && (
        <p className="text-xs text-muted-foreground">
          Use &lt;&lt;&lt;element_1&gt;&gt;&gt;, &lt;&lt;&lt;element_2&gt;&gt;&gt; in the prompt to
          tag these subjects in order.
        </p>
      )}
      {param.imageFieldArray && (
        <p className="text-xs text-muted-foreground">
          Use the same subject ID for multiple views of one subject (up to three). Image tags follow
          the attached image, even when views are grouped.
        </p>
      )}
      {attached && count === 0 && (
        <p className="text-xs text-muted-foreground">
          Attach reference images above to set their details.
        </p>
      )}
      {rows.map((row, index) => (
        <div key={index} className="space-y-2 rounded-md border p-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">
              {attached ? `Image ${index + 1}` : `${param.label} ${index + 1}`}
            </span>
            {!attached && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => write(rows.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            )}
          </div>
          {(param.fields ?? [])
            .filter((field) => field.name !== "index")
            .map((field) => (
              <AtlasControl
                key={field.name}
                param={field}
                value={row[field.name]}
                disabled={disabled}
                priceWith={() => null}
                onChange={(next) =>
                  write(
                    rows.map((entry, i) =>
                      i === index ? { ...entry, [field.name]: next } : entry,
                    ),
                  )
                }
              />
            ))}
        </div>
      ))}
      {!attached && count < (param.maxItems ?? 9) && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => write([...rows, defaultAtlasRecord(param, count)])}
        >
          Add{" "}
          {param.label === "Video Clips"
            ? "video clip"
            : param.name === "elements"
              ? "subject"
              : "shot"}
        </Button>
      )}
    </div>
  );
}
