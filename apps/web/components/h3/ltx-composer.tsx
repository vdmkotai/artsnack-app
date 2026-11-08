"use client";

import * as React from "react";
import { RotateCcw, Shuffle, TextCursorInput } from "lucide-react";

import {
  type Advice,
  Field,
  ImageSlot,
  type InputImage,
  NumberInput,
  Toggle,
} from "@/components/h3/form-controls";
import { H3LoraStack } from "@/components/h3/h3-lora-stack";
import { PromptInput } from "@/components/grok/prompt-input";
import { PromptEnhanceButton } from "@/components/prompt-enhance-button";
import { PromptLibrary } from "@/components/prompt-library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Slider } from "@/components/ui/slider";
import { H3_ASPECTS, type H3Aspect } from "@/lib/h3-video";
import {
  DEFAULT_LTX_SETTINGS,
  LTX_BASE_FILES,
  LTX_COMPANION_LORAS,
  ltxCompanionLora,
  LTX_FPS_OPTIONS,
  LTX_KNOWN_CHECKPOINTS,
  LTX_LIMITS,
  LTX_SHORT_EDGES,
  ltxDimensions,
  ltxFrameCount,
  type LtxVideoSettings,
  normalizeLtxSettings,
  recommendedLtxSettings,
} from "@/lib/ltx-video";

/** The LTX form: settings plus the size preset it was picked from. */
export type LtxFormState = LtxVideoSettings & {
  aspect: H3Aspect | "custom";
  shortEdge: number;
  count: number;
};

export const DEFAULT_LTX_FORM: LtxFormState = {
  ...DEFAULT_LTX_SETTINGS,
  aspect: "9:16",
  shortEdge: 768,
  count: 1,
};

const LTX_FORM_KEY = "artsnack-ltx-video-form";

export function loadLtxForm(): LtxFormState {
  if (typeof window === "undefined") return DEFAULT_LTX_FORM;
  try {
    const raw = window.localStorage.getItem(LTX_FORM_KEY);
    if (!raw) return DEFAULT_LTX_FORM;
    const stored = JSON.parse(raw) as Partial<LtxFormState>;
    return {
      ...DEFAULT_LTX_FORM,
      ...normalizeLtxSettings({ ...DEFAULT_LTX_SETTINGS, ...stored }),
      aspect: stored.aspect ?? DEFAULT_LTX_FORM.aspect,
      shortEdge: stored.shortEdge ?? DEFAULT_LTX_FORM.shortEdge,
      count: Math.min(4, Math.max(1, Math.round(stored.count ?? 1))),
    };
  } catch {
    return DEFAULT_LTX_FORM;
  }
}

export function saveLtxForm(form: LtxFormState): void {
  window.localStorage.setItem(LTX_FORM_KEY, JSON.stringify(form));
}

/** What the composer is told about the pod's LTX side. */
export type LtxCatalog = {
  ready: boolean;
  checkpoints: string[];
  loras: string[];
  /** The Ingredients IC-LoRA is on a pod — Reference sheet mode can run. */
  sheet?: boolean;
};

/** The two-part prompt the Ingredients LoRA was trained on (its model card). */
const SHEET_PROMPT_TEMPLATE =
  "Reference sheet: <who or what each panel shows — the character from several angles, their outfit, any props>\n\nGenerated video: <the scene — where they are, what happens second by second, camera, sound>";

const SHEET_ENHANCE_TARGET =
  'LTX 2.3 with a reference-sheet IC-LoRA. Keep the prompt in exactly two parts: "Reference sheet: …" describing what the sheet shows, then "Generated video: …" describing the scene';

/** Per-checkpoint advice — what each model's author asks for. */
function checkpointAdvice(form: LtxFormState, available: string[]): Advice | null {
  const companion = ltxCompanionLora(form.checkpoint);
  if (companion && !form.loras.some((lora) => lora.name === companion.name)) {
    const short = companion.name.replace(/\.safetensors$/, "");
    return {
      kind: "warn",
      text: available.includes(companion.name)
        ? `This checkpoint is built to run with the LoRA "${short}" at ${companion.strength} — add it below (picking the checkpoint again adds it for you).`
        : `This checkpoint needs the LoRA "${short}" at ${companion.strength}, which is not on the pod yet.`,
    };
  }
  return null;
}

export function LtxComposer({
  form,
  setForm,
  first,
  last,
  sheet,
  catalog,
  catalogError,
  podReady,
  onPick,
  onGallery,
  onClear,
}: {
  form: LtxFormState;
  setForm: React.Dispatch<React.SetStateAction<LtxFormState>>;
  first?: InputImage;
  last?: InputImage;
  /** The reference sheet (an image with the "reference" role). */
  sheet?: InputImage;
  catalog: LtxCatalog | null;
  catalogError?: string;
  podReady: boolean;
  onPick: (role: "first" | "last" | "reference") => void;
  onGallery: (role: "first" | "last" | "reference") => void;
  onClear: (id: string) => void;
}) {
  const update = <K extends keyof LtxFormState>(key: K, value: LtxFormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  const setPreset = (aspect: H3Aspect | "custom", shortEdge: number) =>
    setForm((previous) =>
      aspect === "custom"
        ? { ...previous, aspect, shortEdge }
        : { ...previous, aspect, shortEdge, ...ltxDimensions(shortEdge, aspect) },
    );

  const recommended = recommendedLtxSettings();
  const isRecommended = (key: keyof typeof recommended) => form[key] === recommended[key];
  const allRecommended = (Object.keys(recommended) as (keyof typeof recommended)[]).every(
    isRecommended,
  );
  const frames = ltxFrameCount(form.durationSeconds, form.fps);
  const sheetMode = form.mode === "sheet";
  const sheetStrength = form.sheetStrength ?? 1;

  const checkpoints = catalog?.checkpoints ?? [];
  const checkpointOptions = checkpoints.map((name) => ({
    value: name,
    label: LTX_KNOWN_CHECKPOINTS[name]?.label ?? name.replace(/\.safetensors$/, ""),
    description: LTX_KNOWN_CHECKPOINTS[name]?.note ?? "Custom LTX 2.3 checkpoint",
  }));

  return (
    <>
      <div className="grid grid-cols-3 gap-1 rounded-md border bg-card p-0.5">
        {(
          [
            ["text", "Text → video"],
            ["frames", "Image → video"],
            ["sheet", "Reference sheet"],
          ] as const
        ).map(([mode, label]) => (
          <Button
            key={mode}
            size="sm"
            variant={form.mode === mode ? "default" : "ghost"}
            className="h-7 text-[11px] font-normal"
            onClick={() => update("mode", mode)}
          >
            {label}
          </Button>
        ))}
      </div>

      {form.mode === "frames" && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <ImageSlot
              label="First frame"
              image={first}
              onUpload={() => onPick("first")}
              onGallery={() => onGallery("first")}
              onClear={() => first && onClear(first.id)}
            />
            <ImageSlot
              label="Last frame"
              image={last}
              onUpload={() => onPick("last")}
              onGallery={() => onGallery("last")}
              onClear={() => last && onClear(last.id)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field
              label={`Image strength · ${form.imageStrength.toFixed(2)}`}
              recommended={isRecommended("imageStrength")}
              hint="How tightly the clip holds the frame. 0.7 lets it move; 1.0 can freeze it."
            >
              <Slider
                value={[form.imageStrength]}
                min={0}
                max={1}
                step={0.05}
                onValueChange={(value) =>
                  update("imageStrength", Array.isArray(value) ? value[0] : (value as number))
                }
              />
            </Field>
            <Field
              label={`Image compression · ${form.imageCompression}`}
              recommended={isRecommended("imageCompression")}
              hint="Softens the frame so LTX treats it as video, not a still. 33 in every example."
            >
              <Slider
                value={[form.imageCompression]}
                min={LTX_LIMITS.imageCompression.min}
                max={LTX_LIMITS.imageCompression.max}
                step={1}
                onValueChange={(value) =>
                  update("imageCompression", Array.isArray(value) ? value[0] : (value as number))
                }
              />
            </Field>
          </div>
        </div>
      )}

      {sheetMode && (
        <div className="space-y-2">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
            <ImageSlot
              label="Reference sheet"
              image={sheet}
              onUpload={() => onPick("reference")}
              onGallery={() => onGallery("reference")}
              onClear={() => sheet && onClear(sheet.id)}
            />
            <div className="space-y-1.5 text-[11px] leading-snug text-muted-foreground">
              <p>
                Lightricks&apos; Ingredients IC-LoRA: the clip takes its characters, outfits and
                props from this sheet, not from the first frame.
              </p>
              <p>
                Best sheets: a few large panels on a black background, the same character from
                several angles, no text or labels. It is letterboxed to the clip&apos;s size.
              </p>
            </div>
          </div>
          <Field
            label={`Sheet strength · ${sheetStrength.toFixed(2)}`}
            recommended={sheetStrength >= 1 && sheetStrength <= 1.4}
            hint="1.0–1.4 per the model card; raise it when the clip drifts from the sheet."
            advice={
              catalog && !catalog.sheet
                ? {
                    kind: "warn",
                    text: "The Ingredients LoRA is not on this pod. It is gated on Hugging Face: pods started with HF_TOKEN set download it with the LTX set.",
                  }
                : null
            }
          >
            <Slider
              value={[sheetStrength]}
              min={LTX_LIMITS.sheetStrength.min}
              max={LTX_LIMITS.sheetStrength.max}
              step={0.05}
              onValueChange={(value) =>
                update("sheetStrength", Array.isArray(value) ? value[0] : (value as number))
              }
            />
          </Field>
        </div>
      )}

      <Field
        label="Checkpoint"
        hint={
          catalogError ??
          (catalog && !catalog.ready
            ? "LTX base models are still downloading to the pod (text encoder, VAEs, upscaler) — a few minutes after it starts."
            : undefined)
        }
        advice={checkpointAdvice(form, catalog?.loras ?? [])}
      >
        <SearchableSelect
          value={form.checkpoint}
          onValueChange={(value) =>
            // A checkpoint brings its companion LoRA along (and drops the
            // previous checkpoint's), so the recommended pairing is one click.
            setForm((previous) => {
              const drop = new Set(
                LTX_COMPANION_LORAS.map((entry) => entry.lora.name).filter(
                  (name) => name !== ltxCompanionLora(value)?.name,
                ),
              );
              const loras = previous.loras.filter((lora) => !drop.has(lora.name));
              const companion = ltxCompanionLora(value);
              if (
                companion &&
                (catalog?.loras ?? []).includes(companion.name) &&
                !loras.some((lora) => lora.name === companion.name) &&
                // Every slot taken: leave it to the advice line rather than
                // send an eleventh LoRA the server would reject.
                loras.length < LTX_LIMITS.loras
              ) {
                loras.unshift(companion);
              }
              return { ...previous, checkpoint: value, loras };
            })
          }
          options={checkpointOptions}
          placeholder={podReady ? "Choose a checkpoint…" : "Start the video pod to list models"}
          emptyMessage="No LTX checkpoints on the pod yet"
        />
      </Field>

      <Field label="LoRAs" hint="LTX LoRAs usually want 0.5–1.0; motion helpers ~0.7.">
        <H3LoraStack
          loras={form.loras}
          available={catalog?.loras ?? []}
          onChange={(loras) => update("loras", loras)}
        />
      </Field>

      <div className="space-y-1.5">
        <div className="flex min-h-7 items-center justify-between gap-2">
          <Label htmlFor="ltx-prompt" className="text-xs">
            Prompt
          </Label>
          <div className="flex items-center gap-1">
            {sheetMode && !/^\s*reference sheet:/i.test(form.prompt) && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-[11px]"
                title="The Ingredients LoRA reads a two-part prompt: what the sheet shows, then the scene"
                onClick={() =>
                  update(
                    "prompt",
                    form.prompt.trim()
                      ? SHEET_PROMPT_TEMPLATE.replace(/<the scene[^>]*>/, () => form.prompt.trim())
                      : SHEET_PROMPT_TEMPLATE,
                  )
                }
              >
                <TextCursorInput className="h-3 w-3" /> Two-part prompt
              </Button>
            )}
            <PromptEnhanceButton
              value={form.prompt}
              onReplace={(text) => update("prompt", text)}
              context={{
                media: "video",
                targetModel: sheetMode ? SHEET_ENHANCE_TARGET : "LTX 2.3",
                duration: form.durationSeconds,
                aspectRatio: form.aspect === "custom" ? undefined : form.aspect,
                frameInputs:
                  form.mode !== "frames"
                    ? undefined
                    : first && last
                      ? "both"
                      : first
                        ? "first"
                        : last
                          ? "last"
                          : undefined,
              }}
            />
            <PromptLibrary value={form.prompt} onInsert={(text) => update("prompt", text)} />
          </div>
        </div>
        <PromptInput
          id="ltx-prompt"
          className="[&_textarea]:min-h-[120px]"
          value={form.prompt}
          onChange={(value) => update("prompt", value)}
          references={[]}
          placeholder={
            sheetMode
              ? "Reference sheet: what the sheet shows.\n\nGenerated video: the scene, second by second."
              : "Plain, literal scene script: who, where, what happens second by second, camera, sounds and dialogue in quotes."
          }
        />
        {form.cfg > 1 && (
          <Input
            value={form.negativePrompt}
            onChange={(event) => update("negativePrompt", event.target.value)}
            placeholder="Negative prompt (used because CFG > 1)"
            className="h-8 text-xs"
          />
        )}
      </div>

      <Field label="Size" hint={`${form.width}×${form.height} · up to 1920 on the long edge.`}>
        <div className="flex flex-wrap gap-1">
          {H3_ASPECTS.map((aspect) => (
            <Button
              key={aspect}
              size="sm"
              variant={form.aspect === aspect ? "default" : "outline"}
              className="h-7 px-2 text-[11px]"
              onClick={() => setPreset(aspect, form.shortEdge)}
            >
              {aspect}
            </Button>
          ))}
          <Button
            size="sm"
            variant={form.aspect === "custom" ? "default" : "outline"}
            className="h-7 px-2 text-[11px]"
            onClick={() => setPreset("custom", form.shortEdge)}
          >
            Custom
          </Button>
        </div>
        {form.aspect === "custom" ? (
          <div className="grid grid-cols-2 gap-2">
            <NumberInput
              value={form.width}
              min={LTX_LIMITS.dimension.min}
              max={LTX_LIMITS.dimension.max}
              step={64}
              onChange={(value) => update("width", value)}
            />
            <NumberInput
              value={form.height}
              min={LTX_LIMITS.dimension.min}
              max={LTX_LIMITS.dimension.max}
              step={64}
              onChange={(value) => update("height", value)}
            />
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {LTX_SHORT_EDGES.map((edge) => (
              <Button
                key={edge}
                size="sm"
                variant={form.shortEdge === edge ? "default" : "outline"}
                className="h-7 px-2 text-[11px]"
                onClick={() => setPreset(form.aspect, edge)}
              >
                {edge}p
              </Button>
            ))}
          </div>
        )}
      </Field>

      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Field
          label={`Duration · ${form.durationSeconds} s · ${frames} frames`}
          hint="LTX 2.3 holds up to 20 s; longer clips take disproportionately longer."
        >
          <Slider
            value={[form.durationSeconds]}
            min={LTX_LIMITS.durationSeconds.min}
            max={LTX_LIMITS.durationSeconds.max}
            step={1}
            onValueChange={(value) =>
              update("durationSeconds", Array.isArray(value) ? value[0] : (value as number))
            }
          />
        </Field>
        <Field label="FPS">
          <div className="flex gap-1">
            {LTX_FPS_OPTIONS.map((fps) => (
              <Button
                key={fps}
                size="sm"
                variant={form.fps === fps ? "default" : "outline"}
                className="h-8 px-2 text-xs"
                onClick={() => update("fps", fps)}
              >
                {fps}
              </Button>
            ))}
          </div>
        </Field>
      </div>

      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <div>
          <p className="text-xs font-medium">Quality and speed</p>
          <p className="text-[11px] text-muted-foreground">
            {allRecommended
              ? "The recommended two-pass recipe."
              : "Changed from the recommended settings."}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={allRecommended}
          title="8 steps, two passes, CFG 1, image strength 0.7, compression 33"
          onClick={() => setForm((previous) => ({ ...previous, ...recommended }))}
        >
          <RotateCcw className="h-3 w-3" /> Recommended settings
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle
          label="Two passes (upscale ×2)"
          hint={
            sheetMode
              ? "Off for a reference sheet: one full-size pass, as in Lightricks' workflow, so the likeness is not lost in an upscale."
              : "Renders at half size, upscales the latent 2× with Lightricks' upscaler, refines 3 steps. Sharper and faster than one full-size pass."
          }
          recommended={!sheetMode && isRecommended("twoPass")}
          checked={form.twoPass && !sheetMode}
          disabled={sheetMode}
          onChange={(value) => update("twoPass", value)}
        />
        <Toggle
          label="Audio"
          hint="LTX renders the soundtrack with the video; off drops it from the file."
          checked={form.audio}
          onChange={(value) => update("audio", value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field
          label="Steps"
          recommended={!sheetMode && isRecommended("steps")}
          hint={
            sheetMode
              ? "Fixed for a reference sheet: Lightricks' 8-step schedule."
              : "8 = Lightricks' fixed distilled schedule (distilled models). Dev without a distill LoRA: ~30 on the LTXV scheduler."
          }
        >
          <NumberInput
            disabled={sheetMode}
            value={form.steps}
            min={LTX_LIMITS.steps.min}
            max={LTX_LIMITS.steps.max}
            onChange={(value) => update("steps", value)}
          />
        </Field>
        <Field
          label="CFG"
          recommended={isRecommended("cfg")}
          hint="1 = guidance-free (distilled). Above 1 enables the negative prompt and doubles the time."
        >
          <NumberInput
            value={form.cfg}
            min={LTX_LIMITS.cfg.min}
            max={LTX_LIMITS.cfg.max}
            step={0.5}
            onChange={(value) => update("cfg", value)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Seed" hint={form.seed === -1 ? "Random each time" : undefined}>
          <div className="flex gap-1">
            <Input
              type="number"
              className="h-8"
              value={form.seed === -1 ? "" : form.seed}
              placeholder="random"
              onChange={(event) =>
                update(
                  "seed",
                  event.target.value === ""
                    ? -1
                    : Math.max(0, Math.round(Number(event.target.value))),
                )
              }
            />
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label="Random seed"
              onClick={() => update("seed", -1)}
            >
              <Shuffle className="h-3.5 w-3.5" />
            </Button>
          </div>
        </Field>
        <Field label="Clips">
          <div className="flex gap-1">
            {[1, 2, 3, 4].map((count) => (
              <Button
                key={count}
                size="sm"
                variant={form.count === count ? "default" : "outline"}
                className="h-8 flex-1 px-0 text-xs"
                onClick={() => update("count", count)}
              >
                {count}
              </Button>
            ))}
          </div>
        </Field>
      </div>
    </>
  );
}

/** Why the LTX form cannot run yet, first problem first. */
export function ltxProblems(
  form: LtxFormState,
  state: {
    podReady: boolean;
    catalog: LtxCatalog | null;
    first?: InputImage;
    last?: InputImage;
    sheet?: InputImage;
  },
): string[] {
  return [
    !state.podReady && "Start the video pod first",
    state.podReady &&
      state.catalog &&
      !state.catalog.ready &&
      "LTX base models are still downloading to the pod",
    state.catalog &&
      state.catalog.ready &&
      !state.catalog.checkpoints.includes(form.checkpoint) &&
      (form.checkpoint === LTX_BASE_FILES.checkpoint
        ? "The official LTX checkpoint is not on this pod — pick another one"
        : "That checkpoint is not on the pod"),
    !form.prompt.trim() && "Write a prompt",
    form.mode === "frames" && !state.first && !state.last && "Add a first or last frame",
    form.mode === "sheet" && !state.sheet && "Add a reference sheet",
    form.mode === "sheet" &&
      state.catalog?.ready &&
      !state.catalog.sheet &&
      "The Ingredients LoRA is not on this pod",
  ].filter(Boolean) as string[];
}
