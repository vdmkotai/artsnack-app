"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, ImagePlus, Plus, WandSparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PromptInput } from "@/components/grok/prompt-input";
import { PromptLibrary } from "@/components/prompt-library";
import { PromptEnhanceButton } from "@/components/prompt-enhance-button";
import { PromptStudio } from "@/components/prompt-studio/prompt-studio";
import { atlasEnhanceContext, type EnhanceContext } from "@/lib/prompt-enhance";
import { OptionPrice } from "@/components/api/price-tag";
import { FieldRow, InfoHint } from "@/components/api/field-row";
import type { RefImage } from "@/components/api/types";
import {
  VIDEO_COUNTS,
  centerCropRect,
  higgsfieldVideoModel,
  imageAspectRatios,
  imageMaxReferences,
  videoDurations,
  videoResolutions,
  type ApiModel,
  type VideoTier,
} from "@/lib/api-models";
import {
  grokRoleBadge,
  resolveGrokFrameRoles,
  withGrokFrameRole,
  withGrokKeyframeTime,
} from "@/lib/grok-imagine";
import {
  GrokFrameRoleControl,
  GrokIssues,
  GrokSourceVideoSlot,
  GrokVideoModeRow,
} from "@/components/api/grok-video-controls";
import { ChoiceOptions } from "@/components/api/choice-options";
import { AtlasParams } from "@/components/api/atlas-params";
import {
  atlasCountOptions,
  atlasImageCountHint,
  atlasFamilyReadsTags,
  atlasFrameSlots,
  atlasMaxReferences,
  atlasReferenceHint,
  atlasVariants,
  resolveAtlasVariant,
  type AtlasModel,
  type AtlasParamValue,
} from "@/lib/atlas-models";
import type { AtlasReferenceIssue } from "@/lib/atlas-reference-validation";
import { quoteAtlas, quoteAtlasImages } from "@/lib/atlas-price";
import { REFERENCE_IMAGE_ACCEPT, isAttachableImageFile } from "@/lib/image-file";
import { formatMetered, formatPrice, usdPrice, type Price } from "@/lib/api-pricing";
import { priceForVariant, variantFor, type QuoteMap } from "@/components/api/use-api-price";
import { grokFrameCropsFor, grokVideoOptionsFor, type ApiFormState } from "@/lib/normalize-form";
import { cn } from "@/lib/utils";

const TIER_LABELS: Record<VideoTier, string> = {
  mini: "Mini",
  fast: "Fast",
  standard: "Standard",
};

/**
 * Where a crop to `ratio` falls on a thumbnail that shows the whole picture
 * (`object-contain` in a square), as CSS percentages of the square, with
 * everything outside it dimmed.
 */
function cropOverlayStyle(aspect: number, ratio: string): React.CSSProperties {
  const picture =
    aspect >= 1
      ? { left: 0, top: (1 - 1 / aspect) / 2, width: 1, height: 1 / aspect }
      : { left: (1 - aspect) / 2, top: 0, width: aspect, height: 1 };
  const scale = 1000;
  const sourceWidth = Math.round(aspect * scale);
  const crop = centerCropRect(sourceWidth, scale, ratio);
  const percent = (value: number) => `${value * 100}%`;
  return {
    left: percent(picture.left + (crop.x / sourceWidth) * picture.width),
    top: percent(picture.top + (crop.y / scale) * picture.height),
    width: percent((crop.width / sourceWidth) * picture.width),
    height: percent((crop.height / scale) * picture.height),
    // The thumbnail's overflow clips this to the square.
    boxShadow: "0 0 0 999px rgb(0 0 0 / 0.5)",
  };
}

/**
 * Everything the Atlas branch needs. Present exactly when Atlas is the active
 * provider — its models declare their own parameters, so none of the fields on
 * `ApiFormState` below describe them.
 */
export type AtlasFormSlice = {
  model: AtlasModel;
  params: Record<string, AtlasParamValue>;
  onParamChange: (name: string, value: AtlasParamValue) => void;
  /** Fan-out count, so the inline per-option prices match the button. */
  jobs: number;
};

interface ApiFormProps {
  model: ApiModel;
  atlas?: AtlasFormSlice;
  form: ApiFormState;
  updateField: <K extends keyof ApiFormState>(field: K, value: ApiFormState[K]) => void;
  refImages: RefImage[];
  selectedRefs: RefImage[];
  referenceIssues: AtlasReferenceIssue[];
  maxReferences: number;
  onToggleRef: (id: string) => void;
  onPreviewRef: (reference: RefImage) => void;
  onRemoveRef: (id: string) => void;
  onPickFiles: (files: File[] | FileList) => void;
  onOpenGallery: () => void;
  /** Higgsfield credit quotes, keyed by configuration signature. */
  quotes: QuoteMap;
  /** Grok Edit/Extend: uploads an mp4 as the source clip. Absent hides upload. */
  onPickSourceVideo?: (file: File) => void;
  /** True while a picked source clip is uploading. */
  sourceVideoBusy?: boolean;
  /**
   * Prompt Studio. The panel owns where it shows (the results pane) and
   * whether it is open; the form renders it there through a portal, because
   * everything it writes for — prompt, references, model settings — is here.
   */
  studio?: {
    open: boolean;
    host: HTMLElement | null;
    onOpenChange: (open: boolean) => void;
  };
}

export function ApiForm({
  model,
  atlas,
  form,
  updateField,
  refImages,
  selectedRefs,
  referenceIssues,
  maxReferences,
  onToggleRef,
  onPreviewRef,
  onRemoveRef,
  onPickFiles,
  onOpenGallery,
  quotes,
  onPickSourceVideo,
  sourceVideoBusy = false,
  studio,
}: ApiFormProps) {
  const [isDragging, setIsDragging] = React.useState(false);
  const [studioMounted, setStudioMounted] = React.useState(false);
  React.useEffect(() => {
    if (studio?.open) setStudioMounted(true);
  }, [studio?.open]);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const imageCaps = model.image;
  const videoCaps = model.video;
  const refCount = selectedRefs.length;
  const isImage = form.mediaType === "image";

  /**
   * Everything the Grok video form shows, from the shared rules — mode, model,
   * which images do what, what is hidden, and what would be refused. Null for
   * every other provider and for images.
   */
  const grokVideo =
    !atlas && !isImage && videoCaps.kind === "grok" ? grokVideoOptionsFor(form, refCount) : null;
  const grokRoles = grokVideo?.frameRoleChoices
    ? resolveGrokFrameRoles(form.grokFrameRoles, refCount)
    : null;
  /** The ratio each selected image will be cropped to on upload, if any. */
  const frameCrops = grokVideo ? grokFrameCropsFor(form, refCount) : null;

  // A single reference defines the frame for video, so the ratio control has
  // nothing to decide; image edits can still override it. On Grok the plan
  // decides: a pinned first frame or a source clip sets the shape.
  const showAspectRatio = isImage || (grokVideo ? grokVideo.aspectRatios !== null : refCount !== 1);

  const allowedResolutions = grokVideo
    ? grokVideo.resolutions
    : videoResolutions(
        videoCaps,
        form.videoTier,
        form.videoJobType,
        form.videoMode,
        refCount,
        // Any preset voice makes a Grok job reference-to-video, which loses 1080p.
        videoCaps.kind === "grok" ? form.videoVoices.length : 0,
      );
  const allowedDurations = grokVideo
    ? grokVideo.durations
    : videoDurations(videoCaps, form.videoJobType);
  // Higgsfield's video models are not interchangeable: only the Seedance pair
  // takes a reference list, and one of them has no end frame at all.
  //
  // Forced to null under Atlas. The `model` prop is the last legacy model the
  // user was on and is dormant while Atlas drives the form, so leaving this
  // live made the shared reference block describe that dormant model: a "Start
  // & End frames" heading and a caption naming Wan 2.7, above a picker feeding
  // an entirely different Atlas model. That is the same mismatch this rework
  // existed to remove, one panel further down.
  const hfVideo =
    !atlas && videoCaps.kind === "higgsfield-video"
      ? higgsfieldVideoModel(videoCaps, form.videoJobType)
      : null;
  // The attachment cap spans both media types so nothing is dropped when
  // switching, but there is no point offering a slot the active one will reject.
  // Frame-slot models take one media input per slot, not a list, so the
  // aggregate cap of 9 would offer eight slots the vendor rejects.
  const videoMaxReferences = hfVideo
    ? hfVideo.supportsReferences
      ? hfVideo.maxReferences
      : (hfVideo.supportsStartFrame ? 1 : 0) + (hfVideo.supportsEndFrame ? 1 : 0)
    : grokVideo
      ? grokVideo.maxImages
      : videoCaps.maxReferences;
  // Grok 2.0 takes five edit sources, the legacy pair three.
  const imageMaxRefs = imageMaxReferences(imageCaps, form.quality);
  // Under Atlas the cap is the selected Atlas model's own, already computed by
  // the panel and passed in as `maxReferences`. Intersecting it with the legacy
  // model's caps hid upload slots — a Higgsfield frame model's 2 would mask an
  // Atlas model that accepts 9.
  const activeMaxReferences = atlas
    ? maxReferences
    : Math.min(maxReferences, isImage ? imageMaxRefs : videoMaxReferences);
  /**
   * Names for the positional media slots, or null where the model takes a
   * reference list instead. Kept in the same order the payload builder assigns
   * them, so the badge on a thumbnail is the slot it actually fills.
   */
  const frameSlots: string[] | null = atlas
    ? // Atlas declares its slots per model: `image` + `last_image` is a
      // first/last-frame pair and wants Start/End badges, while
      // `reference_images` is a list where the number is the meaning.
      atlasFrameSlots(atlas.model)
    : !isImage && hfVideo && !hfVideo.supportsReferences
      ? [
          ...(hfVideo.supportsStartFrame ? ["Start"] : []),
          ...(hfVideo.supportsEndFrame ? ["End"] : []),
        ]
      : // Grok 1.5 Lite animates one start image and reads no tags.
        grokVideo && grokVideo.maxImages > 0 && !grokVideo.frameRoleChoices
        ? ["Start"]
        : null;
  const atlasVariantFamily = atlas ? atlasVariants(atlas.model) : {};
  const atlasImageInputModes =
    atlas &&
    !isImage &&
    atlasVariantFamily.image !== undefined &&
    atlasVariantFamily.reference !== undefined
      ? {
          frames: atlasVariantFamily.image,
          references: atlasVariantFamily.reference,
        }
      : null;
  const atlasImageInputMode = atlasImageInputModes
    ? atlas?.model.id === atlasImageInputModes.references.id
      ? "references"
      : atlas?.model.id === atlasImageInputModes.frames.id
        ? "frames"
        : null
    : null;
  const atlasFrameModeSlots = atlasImageInputModes
    ? atlasFrameSlots(atlasImageInputModes.frames)
    : null;
  const atlasFrameModeLabel = atlasFrameModeSlots?.length
    ? atlasFrameModeSlots.join(" & ")
    : "Frames";
  const atlasFrameModeDescription =
    atlasFrameModeSlots?.length === 1
      ? `Fixed ${atlasFrameModeLabel.toLowerCase()} frame`
      : `Fixed ${atlasFrameModeLabel.toLowerCase()} frame positions`;
  const atlasReferenceModeReadsTags = atlasImageInputModes
    ? atlasFamilyReadsTags(atlasImageInputModes.references)
    : false;
  const atlasFrameModeAvailable = atlasImageInputModes
    ? resolveAtlasVariant(atlasImageInputModes.frames, refCount, form.prompt, atlas?.params ?? {})
        .id === atlasImageInputModes.frames.id &&
      refCount <= atlasMaxReferences(atlasImageInputModes.frames)
    : false;
  const aspectRatios = isImage
    ? imageAspectRatios(imageCaps, form.quality)
    : (grokVideo?.aspectRatios ?? hfVideo?.aspectRatios ?? videoCaps.aspectRatios);
  // With a pinned first frame Grok takes the clip's shape from the picture, so
  // the ratio there crops the frames before upload — its own field, and
  // "auto" (the picture as it is) first.
  const frameRatios = grokVideo?.frameAspectRatios ?? null;
  const frameCropRatio =
    frameRatios && form.grokFrameAspectRatio !== "auto" ? form.grokFrameAspectRatio : undefined;
  const ratioControl = frameRatios
    ? {
        ratios: frameRatios,
        value: form.grokFrameAspectRatio,
        field: "grokFrameAspectRatio" as const,
      }
    : showAspectRatio
      ? { ratios: aspectRatios, value: form.aspectRatio, field: "aspectRatio" as const }
      : null;

  /** Cost of the current settings with one field swapped, for the inline prices. */
  // `quality` is optional rather than defaulted to `form.quality`: the React
  // Compiler cannot reorder a parameter default that reads another value, and
  // skips the whole component when it meets one.
  const imagePriceFor = (sizeTier: string, count: number, quality?: string) =>
    priceForVariant(
      // The ratio is part of the quote signature, so leaving it out here would
      // ask for a price nobody ever fetches and leave the button showing "…".
      // The quality picks Grok's model, and with it the metered rate.
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
    );

  /**
   * Cost of the video the button would actually produce.
   *
   * Routed through the same normalizer the click runs, because previewing the
   * raw combination prices a configuration that cannot exist: a cheaper tier
   * that can't do the current resolution, or Wan at a duration only Seedance
   * offers. It also has to carry the selected model and mode — Wan at 5s is 7.5
   * credits where Seedance is 22.5, so pricing every option against the default
   * model was wrong by a factor of three.
   */
  const videoPriceFor = (overrides: Partial<ApiFormState> = {}) =>
    priceForVariant(
      model,
      // Grok's mode, model, roles and source clip ride along in the variant —
      // Lite at 480p and 1.5 at 1080p meter twelve times apart.
      variantFor(form, { mediaType: "video", ...overrides }, refCount),
      refCount,
      quotes,
    );

  /** What a Grok role change does to the role list, by the shared rule. */
  const setGrokRole = (index: number, role: Parameters<typeof withGrokFrameRole>[3]) =>
    updateField(
      "grokFrameRoles",
      withGrokFrameRole(form.grokFrameRoles, refCount, index, role, form.duration),
    );
  const setGrokKeyframeTime = (index: number, at: number) =>
    updateField(
      "grokFrameRoles",
      withGrokKeyframeTime(form.grokFrameRoles, refCount, index, at, form.duration),
    );
  const grokKeyframeCount = grokRoles?.filter((entry) => entry.role === "keyframe").length ?? 0;

  // What the enhancer is told about the generation it writes for. Atlas keeps
  // its settings under the vendor's parameter names, which the shared helper
  // knows how to read; the legacy providers use the flat form fields.
  const enhanceContext: EnhanceContext = atlas
    ? atlasEnhanceContext(atlas.model, atlas.params, refCount)
    : {
        media: form.mediaType,
        targetModel: model.label,
        duration: isImage ? undefined : form.duration,
        aspectRatio: frameCropRatio ?? (showAspectRatio ? form.aspectRatio : undefined),
        referenceCount: refCount,
      };

  // No tagging where the model has no reference list: offering @image1
  // would highlight it as valid and send it to the vendor verbatim, as
  // literal text in the prompt.
  //
  // Atlas is per model rather than wholesale: Seedance's
  // reference-to-video reads "image 1" and Seedance 2.5 reads
  // `@imageN`, while every edit endpoint parses nothing out of the
  // prompt at all. buildAtlasRequest translates ours into whichever
  // the model documents, and strips them where none is documented —
  // so the editor offers tagging exactly where it will be read.
  const promptTagRefs = atlas
    ? // The *family*, not this endpoint: typing a tag on
      // /image-to-video is what moves the form to its
      // /reference-to-video sibling, so refusing to offer the tag
      // there would make the switch unreachable.
      atlasFamilyReadsTags(atlas.model)
      ? selectedRefs
      : []
    : frameSlots || grokVideo?.maxImages === 0
      ? []
      : selectedRefs;

  return (
    <div className="max-w-3xl mx-auto lg:max-w-none space-y-3">
      {studio &&
        (studio.open || studioMounted) &&
        studio.host &&
        createPortal(
          <PromptStudio
            open={studio.open}
            prompt={form.prompt}
            onReplace={(text) => updateField("prompt", text)}
            // Tags address the studio's model whatever the generator reads;
            // whether they may appear in the prompt it writes is the context's
            // `tagsInPrompt`.
            references={selectedRefs}
            context={{
              ...enhanceContext,
              tagsInPrompt: promptTagRefs.length > 0,
              frameSlots: frameSlots && frameSlots.length > 0 ? frameSlots : undefined,
              referenceRoles: grokRoles?.map((entry) =>
                entry.role === "keyframe" ? `keyframe at ${entry.at} seconds` : entry.role,
              ),
            }}
            onClose={() => studio.onOpenChange(false)}
          />,
          studio.host,
        )}
      {/* Media type and model selection moved up into ModelSwitcher, where the
          three choices sit in the order they depend on each other. The caption
          that used to live here — "<image model> generates images; video comes
          from <video model>" — is gone with them: the switcher now names the
          model that will actually run instead of explaining why the one on
          screen is not it. */}

      <div className="space-y-1">
        <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
          <Label htmlFor="api-prompt">Prompt</Label>
          <div className="flex items-center gap-1">
            <PromptEnhanceButton
              value={form.prompt}
              onReplace={(text) => updateField("prompt", text)}
              context={enhanceContext}
            />
            {studio && (
              <Button
                type="button"
                variant={studio.open ? "secondary" : "ghost"}
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                aria-pressed={studio.open}
                title="Write the prompt with AI: describe the idea, pick from variants, refine"
                onClick={() => studio.onOpenChange(!studio.open)}
              >
                <WandSparkles className="h-3.5 w-3.5" />
                Write with AI
              </Button>
            )}
            <PromptLibrary value={form.prompt} onInsert={(text) => updateField("prompt", text)} />
          </div>
        </div>
        <PromptInput
          id="api-prompt"
          value={form.prompt}
          onChange={(value) => updateField("prompt", value)}
          references={promptTagRefs}
          placeholder={
            atlas && !atlasFamilyReadsTags(atlas.model)
              ? "Describe what you want to see..."
              : grokVideo?.plan.mode === "edit"
                ? "Describe the change, and what must stay the same..."
                : grokVideo?.plan.mode === "extend"
                  ? "Describe what happens next..."
                  : frameSlots
                    ? "Describe the motion you want..."
                    : "Describe what you want to see... Type @ to tag a reference image."
          }
        />
      </div>

      {grokVideo && (
        <GrokVideoModeRow
          options={grokVideo}
          mode={form.grokVideoMode}
          model={form.grokVideoModel}
          onModeChange={(mode) => updateField("grokVideoMode", mode)}
          onModelChange={(next) => updateField("grokVideoModel", next)}
          modelPrice={(next) => formatMetered(videoPriceFor({ grokVideoModel: next }))}
        />
      )}

      {/* Absent, not disabled, when the model takes no images at all — a
          text-to-video endpoint offered an upload box that could only ever
          produce a rejected request, and a dimmed control still reads as
          "later" rather than "never". */}
      {activeMaxReferences === 0 ? null : (
        <div
          className={cn(
            "space-y-2 rounded-lg transition-colors",
            isDragging && "ring-2 ring-primary bg-primary/5",
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node)) return;
            setIsDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            const files = [...event.dataTransfer.files].filter(isAttachableImageFile);
            if (files.length > 0) onPickFiles(files);
          }}
        >
          {atlasImageInputModes && (
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-0.5">
                <Label className="text-xs">Use attached images as</Label>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {atlasFrameModeDescription}, or visual references
                  {atlasReferenceModeReadsTags ? " you can tag in the prompt" : ""}.
                </p>
              </div>
              <div
                role="group"
                aria-label="Image input mode"
                className="inline-flex shrink-0 rounded-md bg-muted p-0.5"
              >
                <button
                  type="button"
                  aria-label={`Use ${atlasFrameModeLabel} frames`}
                  aria-pressed={atlasImageInputMode === "frames"}
                  disabled={!atlasFrameModeAvailable}
                  title={
                    atlasFrameModeAvailable
                      ? `Use the selected images as ${atlasFrameModeLabel.toLowerCase()} frames`
                      : "Remove extra or reference-only inputs before switching to frames"
                  }
                  onClick={() => updateField("atlasVideoModel", atlasImageInputModes.frames.id)}
                  className={cn(
                    "h-7 rounded px-2 text-xs transition-colors",
                    atlasImageInputMode === "frames"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                    !atlasFrameModeAvailable && "cursor-not-allowed opacity-40",
                  )}
                >
                  {atlasFrameModeLabel}
                </button>
                <button
                  type="button"
                  aria-label="Use reference images"
                  aria-pressed={atlasImageInputMode === "references"}
                  onClick={() => updateField("atlasVideoModel", atlasImageInputModes.references.id)}
                  className={cn(
                    "h-7 rounded px-2 text-xs transition-colors",
                    atlasImageInputMode === "references"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  References
                </button>
              </div>
            </div>
          )}
          <div className="flex items-center gap-1">
            <Label className="text-xs">
              {/* Happy Horse has a start frame and no end frame, so the heading is
                built from the slots the model actually has. */}
              {frameSlots
                ? `${frameSlots.join(" & ")} frame${frameSlots.length > 1 ? "s" : ""} (optional)`
                : "Reference images (optional)"}
            </Label>
            {/* The two sentences that used to sit under the thumbnails. The
                first ("drag & drop, upload, or pick from your gallery") merely
                narrated the dashed tiles that are already on screen; what is
                left is the part that differs per model — which slot each image
                fills, and whether the prompt can tag them at all. */}
            <InfoHint
              text={
                atlas
                  ? atlasReferenceHint(atlas.model, activeMaxReferences)
                  : frameSlots
                    ? `${hfVideo?.label ?? "This model"} takes ${frameSlots.length > 1 ? "positions, not tags" : "a start frame, not tags"} — the first selected image is the ${frameSlots[0]?.toLowerCase()} frame${frameSlots[1] ? `, the second the ${frameSlots[1].toLowerCase()} frame` : ""}.`
                    : isImage
                      ? `Tag them in the prompt with @image1, @image2… (numbers follow the badges). Image editing uses up to ${imageMaxRefs} selected references.`
                      : grokRoles
                        ? `Up to ${grokVideo?.maxImages} images. Choose under each what it does: a reference (tag it @image1, @image2…), the first or last frame, both (a loop), or a keyframe the clip passes through at a set time — up to ${videoCaps.kind === "grok" ? videoCaps.maxKeyframes : 4}. Left alone, one image is the first frame and two or more are references.`
                        : `Tag them in the prompt with @image1, @image2… (numbers follow the badges). 1 reference = first frame; 2+ = style/content guides (up to ${hfVideo?.maxReferences ?? videoCaps.maxReferences}).`
              }
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {refImages.map((ref) => {
              const selectedIndex = selectedRefs.findIndex((candidate) => candidate.id === ref.id);
              const issue = referenceIssues.find(
                (candidate) => candidate.referenceIndex === selectedIndex,
              );
              // Frame models take positions, not a list: what the badge says is
              // what the clip does, so "1" would be a worse label than "Start".
              const grokRole = grokRoles && selectedIndex >= 0 ? grokRoles[selectedIndex] : null;
              const slotLabel = frameSlots
                ? (frameSlots[selectedIndex] ?? null)
                : grokRole
                  ? grokRoleBadge(grokRole, selectedIndex + 1)
                  : `${selectedIndex + 1}`;
              // A frame that will be cropped shows whole, with what is cut
              // away dimmed — a centre crop can take a head off.
              const crop = selectedIndex >= 0 ? (frameCrops?.[selectedIndex] ?? null) : null;
              return (
                <div key={ref.id} className={cn(!ref.selected && "opacity-40")}>
                  {/* Its own box, so the badge and buttons stay pinned to the
                      thumbnail when a Grok role control sits under it. */}
                  <div className="relative">
                    <button
                      type="button"
                      aria-label="Preview reference image"
                      title="Preview reference image"
                      className={cn(
                        "relative block h-20 w-20 overflow-hidden rounded-lg border cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        issue && "border-destructive ring-2 ring-destructive/60",
                      )}
                      onClick={() => onPreviewRef(ref)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={ref.previewUrl}
                        alt={
                          ref.selected
                            ? frameSlots
                              ? `${slotLabel ?? "Unused"} frame`
                              : `Reference ${selectedIndex + 1}`
                            : "Deselected reference"
                        }
                        className={cn(
                          "h-full w-full",
                          crop ? "object-contain bg-muted" : "object-cover",
                        )}
                      />
                      {crop && (
                        <span
                          aria-hidden
                          className="absolute border border-white/90 pointer-events-none"
                          style={cropOverlayStyle(ref.aspect, crop)}
                        />
                      )}
                    </button>
                    {ref.selected && slotLabel && (
                      <span className="absolute bottom-1 left-1 text-[10px] font-bold bg-background/90 rounded px-1.5 py-0.5 pointer-events-none">
                        {slotLabel}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={ref.selected ? "Deselect reference" : "Select reference"}
                      onClick={() => onToggleRef(ref.id)}
                      className={cn(
                        "absolute top-1 left-1 h-4 w-4 rounded border flex items-center justify-center",
                        ref.selected
                          ? "bg-primary border-primary text-primary-foreground"
                          : "bg-background/80 border-border text-transparent",
                      )}
                    >
                      <Check className="h-3 w-3" />
                    </button>
                    <Button
                      variant="destructive"
                      size="icon"
                      className="absolute -top-2 -right-2 h-5 w-5"
                      aria-label="Remove reference image"
                      onClick={() => onRemoveRef(ref.id)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                  {grokRole && videoCaps.kind === "grok" && (
                    <GrokFrameRoleControl
                      role={grokRole}
                      keyframeCount={grokKeyframeCount}
                      maxKeyframes={videoCaps.maxKeyframes}
                      duration={form.duration}
                      onRoleChange={(role) => setGrokRole(selectedIndex, role)}
                      onTimeChange={(at) => setGrokKeyframeTime(selectedIndex, at)}
                    />
                  )}
                </div>
              );
            })}
            {refImages.length < activeMaxReferences && (
              <>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-20 w-20 rounded-lg border border-dashed flex flex-col items-center justify-center gap-1 text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                >
                  <Plus className="h-5 w-5" />
                  <span className="text-[10px]">Upload</span>
                </button>
                <button
                  type="button"
                  onClick={onOpenGallery}
                  className="h-20 w-20 rounded-lg border border-dashed flex flex-col items-center justify-center gap-1 text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                >
                  <ImagePlus className="h-5 w-5" />
                  <span className="text-[10px]">Gallery</span>
                </button>
              </>
            )}
          </div>
          {referenceIssues.length > 0 && (
            <div
              role="alert"
              className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1 text-xs leading-relaxed">
                <p className="font-medium">This model cannot use the highlighted reference.</p>
                {referenceIssues.map((issue) => (
                  <p key={`${issue.referenceIndex}-${issue.code}`}>{issue.message}</p>
                ))}
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={REFERENCE_IMAGE_ACCEPT}
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files?.length) onPickFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </div>
      )}

      {grokVideo?.source && (
        <GrokSourceVideoSlot
          source={form.grokSourceVideo}
          range={grokVideo.source}
          busy={sourceVideoBusy}
          onPick={onPickSourceVideo}
          onClear={() => updateField("grokSourceVideo", null)}
        />
      )}

      {/* Atlas replaces every control below with ones generated from the
          selected model's schema. The prompt and reference blocks above are
          shared: they are the same job whoever runs it, and duplicating the
          drag-and-drop, gallery picker and @-tagging for a fourth provider
          would be four copies to keep in step. */}
      {atlas ? (
        <>
          {Object.keys(atlasVariantFamily).length > 1 && (
            <FieldRow label="Input mode" wide>
              <select
                aria-label="Atlas input mode"
                className="h-8 max-w-full rounded-md border bg-card px-2 text-xs"
                value={atlas.model.id}
                onChange={(event) =>
                  updateField(isImage ? "atlasImageModel" : "atlasVideoModel", event.target.value)
                }
              >
                {Object.entries(atlasVariantFamily).map(([variant, candidate]) => (
                  <option
                    key={candidate.id}
                    value={candidate.id}
                    disabled={
                      resolveAtlasVariant(candidate, refCount, form.prompt, atlas.params).id !==
                      candidate.id
                    }
                  >
                    {variant === "text"
                      ? "Text"
                      : variant === "image"
                        ? isImage
                          ? "Image input"
                          : `${atlasFrameSlots(candidate)?.join(" / ") ?? "Image"} ${(atlasFrameSlots(candidate)?.length ?? 1) === 1 ? "frame" : "frames"}`
                        : candidate.params.some((param) => param.name === "video_clips")
                          ? "Video reference"
                          : "References"}
                  </option>
                ))}
              </select>
            </FieldRow>
          )}
          <AtlasParams
            referenceCount={refCount}
            referenceDimensions={
              selectedRefs[0]?.width && selectedRefs[0]?.height
                ? { width: selectedRefs[0].width, height: selectedRefs[0].height }
                : undefined
            }
            model={atlas.model}
            params={atlas.params}
            onChange={atlas.onParamChange}
            jobs={atlas.jobs}
          />

          {/* The fan-out is ours, not a vendor parameter, so it is not in the
              model's schema and AtlasParams cannot render it. It still has to
              be here: `videoCount` is shared with the other providers, so
              arriving from fal with 4 selected silently submitted — and paid
              for — four Atlas jobs with no control anywhere on screen. */}
          {atlas.model.media === "video" ? (
            <FieldRow
              label={
                atlas.model.params.some((param) => param.name === "count")
                  ? "Number of requests"
                  : "Number of videos"
              }
              hint="Each request is a separate run and charge. Models with Outputs per request return that many outputs from each run."
              wide
            >
              <ChoiceOptions
                label={
                  atlas.model.params.some((param) => param.name === "count")
                    ? "Number of requests"
                    : "Number of videos"
                }
                options={VIDEO_COUNTS}
                value={form.videoCount}
                onChange={(count) => updateField("videoCount", Number(count))}
                price={(count) =>
                  formatPrice(atlasCountPrice(atlas.model, atlas.params, Number(count)))
                }
              />
            </FieldRow>
          ) : (
            <FieldRow
              label={
                atlas.model.params.some((param) => param.name === "count")
                  ? "Number of requests"
                  : "Number of images"
              }
              hint={atlasImageCountHint(atlas.model)}
              wide
            >
              <ChoiceOptions
                label={
                  atlas.model.params.some((param) => param.name === "count")
                    ? "Number of requests"
                    : "Number of images"
                }
                options={atlasCountOptions(form.count)}
                value={form.count}
                onChange={(count) => updateField("count", Number(count))}
                price={(count) =>
                  formatPrice(atlasImagesPrice(atlas.model, atlas.params, Number(count)))
                }
              />
            </FieldRow>
          )}
        </>
      ) : (
        <>
          {ratioControl && (
            <div className="space-y-1">
              <div className="flex items-center gap-1">
                <Label className="text-xs">Aspect ratio</Label>
                {frameRatios && (
                  <InfoHint text="Grok takes the clip's shape from its first frame. A ratio here crops the pinned frames (first, last, keyframes) to that shape from the centre before they are sent; Original sends them as they are. References are never cropped." />
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {ratioControl.ratios.map((ratio) => (
                  <Button
                    key={ratio}
                    variant={ratioControl.value === ratio ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-[11px] font-normal"
                    onClick={() => updateField(ratioControl.field, ratio)}
                  >
                    {frameRatios && ratio === "auto" ? "Original" : ratio}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {isImage && (
            <>
              {/* Grok's five qualities need the full width; the size tier
                  goes under them rather than squeezing both into halves. */}
              <div className={cn("grid gap-3", imageCaps.kind === "grok" ? "grid-cols-1" : "")}>
                {imageCaps.kind === "grok" && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1">
                      <Label className="text-xs">Quality</Label>
                      <InfoHint text="Standard and Quality are the original model pair; the 2.0 entries run grok-imagine-image-2.0, which also takes five edit sources and 21:9 / 5:2. 2.0 Auto is low for a new image and medium for an edit. xAI retires Quality on 2 Nov 2026 and serves it as 2.0 Low from then on." />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {imageCaps.qualities.map((quality) => (
                        <Button
                          key={quality.value}
                          variant={form.quality === quality.value ? "default" : "outline"}
                          size="sm"
                          // Sized to their labels: five with prices do not fit
                          // one row, and stretched wraps leave one full-width.
                          className="h-7 px-2 text-[11px] font-normal"
                          aria-pressed={form.quality === quality.value}
                          onClick={() =>
                            updateField("quality", quality.value as ApiFormState["quality"])
                          }
                        >
                          {quality.label}
                          <OptionPrice
                            price={imagePriceFor(form.imageSizeTier, form.count, quality.value)}
                          />
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
                {imageCaps.sizeTiers.length > 1 && (
                  <div className="space-y-1">
                    <Label className="text-xs">
                      {imageCaps.kind === "higgsfield-image" && imageCaps.sizeParam === "quality"
                        ? "Quality"
                        : "Resolution"}
                    </Label>
                    <div className="flex gap-1.5">
                      {imageCaps.sizeTiers.map((tier) => (
                        <Button
                          key={tier.value}
                          variant={form.imageSizeTier === tier.value ? "default" : "outline"}
                          size="sm"
                          className="h-7 flex-1 text-[11px] font-normal"
                          onClick={() => updateField("imageSizeTier", tier.value)}
                        >
                          {tier.label}
                          <OptionPrice price={imagePriceFor(tier.value, form.count)} />
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {imageCaps.counts.length > 1 && (
                <div className="space-y-1">
                  <Label className="text-xs">Number of images</Label>
                  <div className="flex gap-1.5">
                    {imageCaps.counts.map((count) => (
                      <Button
                        key={count}
                        variant={form.count === count ? "default" : "outline"}
                        size="sm"
                        className="h-7 flex-1 text-[11px] font-normal"
                        onClick={() => updateField("count", count)}
                      >
                        {count}
                        <OptionPrice price={imagePriceFor(form.imageSizeTier, count)} />
                      </Button>
                    ))}
                  </div>
                  {refCount > 0 && imageCaps.kind === "grok" && (
                    <p className="text-[11px] text-muted-foreground">
                      Reference edits run as parallel Grok requests.
                    </p>
                  )}
                  {refCount > 1 && model.id === "seedream-5-pro" && (
                    <p className="text-[11px] text-muted-foreground">
                      Pro charges $0.0045 per reference beyond the first, per image.
                    </p>
                  )}
                  {imageCaps.kind === "higgsfield-image" && form.count > 1 && (
                    <p className="text-[11px] text-muted-foreground">
                      Higgsfield has no batch parameter, so each image is a separate job.
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {!isImage && (
            <>
              {videoCaps.kind === "higgsfield-video" && (
                <div className="space-y-1">
                  <Label className="text-xs">Video model</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {videoCaps.models.map((video) => (
                      <Button
                        key={video.jobType}
                        variant={form.videoJobType === video.jobType ? "default" : "outline"}
                        size="sm"
                        aria-pressed={form.videoJobType === video.jobType}
                        onClick={() => updateField("videoJobType", video.jobType)}
                      >
                        {video.label}
                        {/* The model is the single biggest lever on cost here —
                        Wan at 5s is 7.5 credits where Seedance is 22.5. */}
                        <OptionPrice price={videoPriceFor({ videoJobType: video.jobType })} />
                      </Button>
                    ))}
                  </div>
                  {hfVideo && !hfVideo.supportsReferences && (
                    <p className="text-[11px] text-muted-foreground">
                      {hfVideo.label} animates a start frame. Prompt tagging with @image is a
                      Seedance feature and does nothing here.
                    </p>
                  )}
                </div>
              )}

              {hfVideo?.modeParam && (
                <div className="space-y-1">
                  <Label className="capitalize">{hfVideo.modeParam.name}</Label>
                  <div className="flex gap-1.5">
                    {hfVideo.modeParam.values.map((value) => (
                      <Button
                        key={value}
                        variant={form.videoMode === value ? "default" : "outline"}
                        size="sm"
                        className="flex-1 uppercase"
                        aria-pressed={form.videoMode === value}
                        onClick={() => updateField("videoMode", value)}
                      >
                        {value}
                        <OptionPrice price={videoPriceFor({ videoMode: value })} />
                      </Button>
                    ))}
                  </div>
                  {hfVideo.jobType === "seedance_2_0" && form.videoMode === "fast" && (
                    <p className="text-[11px] text-muted-foreground">
                      Fast mode is limited to 480p and 720p.
                    </p>
                  )}
                </div>
              )}

              {videoCaps.kind === "seedance" && (
                <div className="space-y-1">
                  <Label className="text-xs">Quality tier</Label>
                  <div className="flex gap-1.5">
                    {videoCaps.tiers.map((tier) => (
                      <Button
                        key={tier}
                        variant={form.videoTier === tier ? "default" : "outline"}
                        size="sm"
                        className="h-7 flex-1 text-[11px] font-normal"
                        onClick={() => updateField("videoTier", tier)}
                      >
                        {TIER_LABELS[tier]}
                        <OptionPrice price={videoPriceFor({ videoTier: tier })} />
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {grokVideo ? (
                grokVideo.durationField === "duration" ? (
                  // Fifteen lengths are a list, not a row of buttons.
                  <div className="space-y-1">
                    <Label className="text-xs">Duration</Label>
                    <ChoiceOptions
                      label="Duration"
                      options={grokVideo.durations}
                      value={form.duration}
                      format={(seconds) => `${seconds}s`}
                      onChange={(seconds) => updateField("duration", Number(seconds))}
                      price={(seconds) =>
                        formatMetered(videoPriceFor({ duration: Number(seconds) }))
                      }
                    />
                  </div>
                ) : grokVideo.durationField === "grokExtendDuration" ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1">
                      <Label className="text-xs">Seconds to add</Label>
                      <InfoHint text="The result is the source clip plus these seconds." />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {grokVideo.durations.map((seconds) => (
                        <Button
                          key={seconds}
                          variant={form.grokExtendDuration === seconds ? "default" : "outline"}
                          size="sm"
                          aria-pressed={form.grokExtendDuration === seconds}
                          onClick={() => updateField("grokExtendDuration", seconds)}
                        >
                          +{seconds}s
                          <OptionPrice price={videoPriceFor({ grokExtendDuration: seconds })} />
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null
              ) : (
                <div className="space-y-1">
                  <Label className="text-xs">Duration</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {allowedDurations.map((seconds) => (
                      <Button
                        key={seconds}
                        variant={form.duration === seconds ? "default" : "outline"}
                        size="sm"
                        onClick={() => updateField("duration", seconds)}
                      >
                        {seconds}s
                        <OptionPrice price={videoPriceFor({ duration: seconds })} />
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {allowedResolutions.length > 1 && (
                <div className="space-y-1">
                  <Label className="text-xs">Resolution</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {allowedResolutions.map((resolution) => (
                      <Button
                        key={resolution}
                        variant={form.resolution === resolution ? "default" : "outline"}
                        size="sm"
                        onClick={() => updateField("resolution", resolution)}
                      >
                        {resolution}
                        <OptionPrice price={videoPriceFor({ resolution })} />
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {videoCaps.kind === "grok" && grokVideo?.voices && (
                <div className="space-y-1">
                  <Label className="text-xs">Voices</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {videoCaps.voices.map((voice) => {
                      const selected = form.videoVoices.includes(voice);
                      return (
                        <Button
                          key={voice}
                          variant={selected ? "default" : "outline"}
                          size="sm"
                          className="h-7 px-2 text-[11px] font-normal capitalize"
                          // At the cap the chosen voices stay tappable so they
                          // can be unpicked; the rest disable rather than
                          // guessing which selection a fourth tap should evict.
                          disabled={!selected && form.videoVoices.length >= videoCaps.maxVoices}
                          aria-pressed={selected}
                          onClick={() =>
                            updateField(
                              "videoVoices",
                              selected
                                ? form.videoVoices.filter((entry) => entry !== voice)
                                : [...form.videoVoices, voice],
                            )
                          }
                        >
                          {voice}
                        </Button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Up to {videoCaps.maxVoices} preset voices the subjects speak with — reference
                    them in the prompt as {"<AUDIO_0>"}, {"<AUDIO_1>"}, … or let the model assign
                    them. Any voice makes the clip reference-to-video, which caps it at 720p.
                  </p>
                </div>
              )}

              <div className="space-y-1">
                <Label className="text-xs">Number of videos</Label>
                <div className="flex gap-1.5">
                  {VIDEO_COUNTS.map((count) => (
                    <Button
                      key={count}
                      variant={form.videoCount === count ? "default" : "outline"}
                      size="sm"
                      className="h-7 flex-1 text-[11px] font-normal"
                      aria-pressed={form.videoCount === count}
                      onClick={() => updateField("videoCount", count)}
                    >
                      {count}
                      <OptionPrice price={videoPriceFor({ videoCount: count })} />
                    </Button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {/* Not a vendor batch parameter: no video model here has one, so
                  each clip is a separate job charged in full. */}
                  Each clip is a separate run on the same prompt — and a separate charge.
                </p>
              </div>

              {grokVideo && <GrokIssues issues={grokVideo.issues} />}

              {(videoCaps.kind === "seedance" || hfVideo?.audioParam) && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label className="text-xs">Audio</Label>
                    <div className="flex gap-1.5">
                      <Button
                        variant={form.generateAudio ? "default" : "outline"}
                        size="sm"
                        className="h-7 flex-1 text-[11px] font-normal"
                        onClick={() => updateField("generateAudio", true)}
                      >
                        On
                        {/* Kling charges for it: 10 credits at 5s against 7.5. */}
                        <OptionPrice price={videoPriceFor({ generateAudio: true })} />
                      </Button>
                      <Button
                        variant={!form.generateAudio ? "default" : "outline"}
                        size="sm"
                        className="h-7 flex-1 text-[11px] font-normal"
                        onClick={() => updateField("generateAudio", false)}
                      >
                        Off
                        <OptionPrice price={videoPriceFor({ generateAudio: false })} />
                      </Button>
                    </div>
                  </div>
                  {videoCaps.kind === "seedance" && videoCaps.bitrateModeByTier[form.videoTier] && (
                    <div className="space-y-1">
                      <Label className="text-xs">Bitrate</Label>
                      <div className="flex gap-1.5">
                        {(["standard", "high"] as const).map((mode) => (
                          <Button
                            key={mode}
                            variant={form.bitrateMode === mode ? "default" : "outline"}
                            size="sm"
                            className="flex-1 capitalize"
                            onClick={() => updateField("bitrateMode", mode)}
                          >
                            {mode}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Price of N Atlas images, split the way they will be sent, for the count buttons. */
function atlasImagesPrice(
  model: AtlasModel,
  params: Record<string, AtlasParamValue>,
  images: number,
): Price | null {
  const quote = quoteAtlasImages({ model: model.id, params, images });
  return quote.usd === null
    ? { currency: "unknown", reason: quote.reason ?? "" }
    : usdPrice(quote.usd);
}

/** Price of N Atlas clips at the current settings, for the fan-out buttons. */
function atlasCountPrice(
  model: AtlasModel,
  params: Record<string, AtlasParamValue>,
  jobs: number,
): Price | null {
  const quote = quoteAtlas({ model: model.id, params, jobs });
  return quote.usd === null
    ? { currency: "unknown", reason: quote.reason ?? "" }
    : usdPrice(quote.usd);
}
