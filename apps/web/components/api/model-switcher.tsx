"use client";

import * as React from "react";
import { Film, Image as ImageIcon, ScanText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AtlasModelPicker } from "@/components/api/atlas-model-picker";
import {
  API_MODELS,
  higgsfieldVideoModel,
  modelsForProvider,
  type ApiModelId,
  type MediaType,
} from "@/lib/api-models";
import type { ApiFormState, ComposerProvider } from "@/lib/normalize-form";
import { cn } from "@/lib/utils";

/**
 * Media type, then provider, then model — in that order, because that is the
 * order the choices actually depend on each other.
 *
 * The previous layout put the model first and the media type inside the form,
 * which produced the thing this was rebuilt to fix: "Seedream 4.5" sat
 * highlighted at the top while Video was selected below it, and a line of small
 * print underneath explained that video would in fact come from Seedance. The
 * model row was, for video, decorative — it selected an image model that had no
 * bearing on the clip about to be generated.
 *
 * Now the second row only ever offers models that the active media type will
 * really use. Where a provider bundles a fixed video model behind its image one
 * (fal, Higgsfield), the row states which model is going to run instead of
 * offering a choice that does nothing; the controls that *do* change it — the
 * Seedance tier, Higgsfield's video model — stay in the form beside their price
 * previews.
 */

const PROVIDER_LABELS: Record<ComposerProvider, string> = {
  grok: "Grok",
  higgsfield: "Higgsfield",
  fal: "fal.ai",
  atlas: "Atlas Cloud",
};

const PROVIDER_ORDER: ComposerProvider[] = ["grok", "higgsfield", "fal", "atlas"];

export function ModelSwitcher({
  form,
  onSelectProvider,
  onSelectModel,
  onSelectAtlasModel,
  onSelectMediaType,
  disabled,
  /** Rendered on the right of the first row — the credits badge lives here. */
  accessory,
  /**
   * The Self-hosted / API switch, which used to own a 64px row of its own above
   * both columns — and therefore above the results grid as well. It is two
   * buttons; it shares this row instead.
   */
  tabs,
  describeActive = false,
  onSelectDescribe,
  hiddenProviders = [],
}: {
  form: ApiFormState;
  onSelectProvider: (provider: ComposerProvider) => void;
  onSelectModel: (id: ApiModelId) => void;
  onSelectAtlasModel: (id: string) => void;
  onSelectMediaType: (media: MediaType) => void;
  disabled?: boolean;
  accessory?: React.ReactNode;
  tabs?: React.ReactNode;
  /**
   * The Image → Prompt tool sits in the provider row because that is where
   * the owner looks for "what can the API tab do", but it is not a provider:
   * while it is on, no provider is pressed and the media and model rows,
   * which would configure nothing, are gone.
   */
  describeActive?: boolean;
  onSelectDescribe?: () => void;
  /**
   * Providers switched off on the Settings page. The one the form is on stays
   * regardless — a reproduced or saved row can land there — so the pressed
   * button never disappears from under the form that is using it.
   */
  hiddenProviders?: readonly ComposerProvider[];
}) {
  const { provider, mediaType } = form;
  const isImage = mediaType === "image";
  const providers = PROVIDER_ORDER.filter(
    (candidate) => candidate === provider || !hiddenProviders.includes(candidate),
  );

  return (
    <div className="space-y-1.5">
      {/* Every choice keeps its own one-click control — nothing moved behind a
          dropdown or a disclosure. What went away is the "Media type" label
          (the two icons say it), the full-bleed width of the two buttons, and
          the vertical stacking of three rows that each held one decision. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {tabs}

        {!describeActive && (
          <div
            role="group"
            aria-label="Media type"
            className="inline-flex items-center gap-0.5 rounded-md border bg-card p-0.5"
          >
            <Button
              variant={isImage ? "default" : "ghost"}
              size="sm"
              className="h-6 px-2 text-[11px] font-normal"
              disabled={disabled}
              aria-pressed={isImage}
              onClick={() => onSelectMediaType("image")}
            >
              <ImageIcon className="mr-1 h-3 w-3" />
              Image
            </Button>
            <Button
              variant={!isImage ? "default" : "ghost"}
              size="sm"
              className="h-6 px-2 text-[11px] font-normal"
              disabled={disabled}
              aria-pressed={!isImage}
              onClick={() => onSelectMediaType("video")}
            >
              <Film className="mr-1 h-3 w-3" />
              Video
            </Button>
          </div>
        )}

        {accessory && <span className="ml-auto">{accessory}</span>}
      </div>

      <div
        role="group"
        aria-label="Provider"
        className="flex flex-wrap items-center gap-0.5 rounded-md border bg-card p-0.5"
      >
        {providers.map((candidate) => (
          <Button
            key={candidate}
            variant={!describeActive && provider === candidate ? "default" : "ghost"}
            size="sm"
            className="h-6 px-2 text-[11px] font-normal"
            aria-pressed={!describeActive && provider === candidate}
            disabled={disabled}
            onClick={() => onSelectProvider(candidate)}
          >
            {PROVIDER_LABELS[candidate]}
          </Button>
        ))}
        {onSelectDescribe && (
          <>
            <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
            <Button
              variant={describeActive ? "default" : "ghost"}
              size="sm"
              className="h-6 px-2 text-[11px] font-normal"
              aria-pressed={describeActive}
              disabled={disabled}
              title="Describe an image as a prompt"
              onClick={onSelectDescribe}
            >
              <ScanText className="mr-1 h-3 w-3" />
              Image → Prompt
            </Button>
          </>
        )}
      </div>

      {!describeActive && (
        <ModelRow
          form={form}
          onSelectModel={onSelectModel}
          onSelectAtlasModel={onSelectAtlasModel}
          disabled={disabled}
        />
      )}
    </div>
  );
}

function ModelRow({
  form,
  onSelectModel,
  onSelectAtlasModel,
  disabled,
}: {
  form: ApiFormState;
  onSelectModel: (id: ApiModelId) => void;
  onSelectAtlasModel: (id: string) => void;
  disabled?: boolean;
}) {
  if (form.provider === "atlas") {
    const id = form.mediaType === "video" ? form.atlasVideoModel : form.atlasImageModel;
    // The moderation status and the rate are the reason to be on this provider,
    // so they stay in front of the user — as two badges on the picker's own
    // line, which is where AtlasModelBadges renders them.
    return (
      <AtlasModelPicker
        media={form.mediaType}
        value={id}
        onChange={onSelectAtlasModel}
        disabled={disabled}
      />
    );
  }

  // For video, the image-model row selects nothing that affects the output, so
  // it is replaced by a statement of which model will actually run.
  if (form.mediaType === "video") {
    const label = videoModelLabel(form);
    if (!label) return null;
    return (
      <p className="px-0.5 text-[11px] text-muted-foreground">
        Video model: <span className="font-medium text-foreground">{label}</span>
      </p>
    );
  }

  const models = modelsForProvider(form.provider);
  if (models.length <= 1) return null;

  return (
    <div
      role="group"
      aria-label="Model"
      className="flex flex-wrap items-center gap-0.5 rounded-md border bg-card/60 p-0.5"
    >
      {models.map((model) => (
        <Button
          key={model.id}
          variant={form.model === model.id ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={form.model === model.id}
          disabled={disabled}
          className={cn(
            "h-6 px-2 text-[11px] font-normal",
            form.model === model.id && "font-medium",
          )}
          onClick={() => onSelectModel(model.id)}
        >
          {model.label}
        </Button>
      ))}
    </div>
  );
}

/** Which model the active provider will use for video, named honestly. */
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
