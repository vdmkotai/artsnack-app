/**
 * What one click costs, before it happens.
 *
 * Split out of the web app's `use-api-price` hook so the same arithmetic can
 * price the Generate button on iOS. Everything here is pure: given a model, a
 * configuration and whatever Higgsfield quotes have arrived, it returns a price.
 * Fetching those quotes is a client concern and stays with the hook.
 */

import {
  higgsfieldVideoModel,
  videoDurations,
  videoResolutions,
  type ApiModel,
  type MediaType,
  type VideoTier,
} from "./api-models";
import {
  creditsPrice,
  imageCostUsd,
  includedPrice,
  usdPrice,
  videoCostUsd,
  type Price,
} from "./api-pricing";
import { grokImageMeteredUsd, grokVideoMeteredUsd, type GrokVideoInput } from "./grok-imagine";
import { buildHiggsfieldJob, costSignature } from "./higgsfield-job";
import { HIGGSFIELD_LIST_PRICE } from "./higgsfield-prices";
import { grokVideoInputFor, normalizeForm, type ApiFormState } from "./normalize-form";

/** One priceable configuration: the current form, or a single option swapped. */
export type PriceVariant = {
  mediaType: MediaType;
  aspectRatio?: string;
  duration?: number;
  resolution?: string;
  videoTier?: VideoTier;
  /** Which Higgsfield video model — they are priced very differently. */
  videoJobType?: string;
  videoMode?: string;
  sizeTier?: string;
  count?: number;
  /** Clips per click. Never part of a quote — the vendor prices one job. */
  videoCount?: number;
  /**
   * Audio, which is priced: Kling at 5s is 10 credits with sound and 7.5
   * without. Leaving it out of the quote overstated a silent clip by a third.
   */
  generateAudio?: boolean;
  /** Grok images: the quality, which picks the model and its rate. */
  quality?: string;
  /**
   * Grok video: mode, model, roles, voices, source and extension — everything
   * but the reference count, duration and resolution, which come from the
   * fields above. Absent prices Generate on 1.5, as it always did.
   */
  grok?: Omit<GrokVideoInput, "referenceCount" | "duration" | "prompt">;
};

export type QuoteMap = ReadonlyMap<string, number>;

/**
 * Signature a Higgsfield quote is cached under. Mirrors the server so a price
 * fetched by the form is the same one the mutation reads back at submit.
 */
export function variantSignature(
  model: ApiModel,
  variant: PriceVariant,
  referenceCount: number,
): string | null {
  if (model.provider !== "higgsfield") return null;
  try {
    const request = buildHiggsfieldJob({
      model: model.id,
      mediaType: variant.mediaType,
      prompt: "cost probe",
      aspectRatio:
        variant.mediaType === "video" && referenceCount === 1 ? undefined : variant.aspectRatio,
      sizeTier: variant.sizeTier,
      videoJobType: variant.videoJobType,
      mode: variant.videoMode,
      generateAudio: variant.generateAudio,
      durationSeconds: variant.duration,
      resolution: variant.resolution,
      referenceCount,
    });
    return costSignature(request);
  } catch {
    return null;
  }
}

/**
 * Price of one configuration.
 *
 * fal and Grok are computed locally — a rate card and a subscription. Higgsfield
 * publishes no rates, so its figure comes from the vendor's own quote and is
 * `null` until that lands.
 */
export function priceForVariant(
  model: ApiModel,
  variant: PriceVariant,
  referenceCount: number,
  quotes: QuoteMap,
): Price | null {
  if (model.provider === "grok") {
    // Covered by the subscription, but metered against its quota at xAI's API
    // rates — which differ by up to 12× between Lite at 480p and 1.5 at 1080p,
    // so the figure is worth showing even though nothing is charged per job.
    if (variant.mediaType === "image") {
      return includedPrice(
        grokImageMeteredUsd({
          quality: variant.quality,
          sizeTier: variant.sizeTier ?? model.image.defaultSizeTier,
          count: variant.count ?? 1,
          referenceCount,
        }),
      );
    }
    return includedPrice(
      grokVideoMeteredUsd({
        ...variant.grok,
        referenceCount,
        duration: variant.duration ?? model.video.defaultDuration,
        resolution: variant.resolution ?? model.video.defaultResolution,
      }) * jobsFor(variant),
    );
  }

  if (model.provider === "higgsfield") {
    const signature = variantSignature(model, variant, referenceCount);
    // A live quote wins; the captured rate card stands in until one arrives, so
    // the button shows a real number on the first paint rather than an ellipsis.
    const credits = signature
      ? (quotes.get(signature) ?? HIGGSFIELD_LIST_PRICE[signature])
      : undefined;
    if (credits === undefined) return null;
    // Higgsfield has no batch parameter for either medium, so several outputs
    // are several jobs and several charges. Quoting one would understate the
    // click by that factor.
    return creditsPrice(credits * jobsFor(variant));
  }

  if (variant.mediaType === "image") {
    return usdPrice(
      imageCostUsd({
        model: model.id,
        sizeTier: variant.sizeTier ?? model.image.defaultSizeTier,
        count: variant.count ?? 1,
        referenceCount,
      }),
    );
  }
  // Video has no batch parameter anywhere, so the count is our own fan-out and
  // the per-clip rate multiplies — unlike images, where fal and Grok take an `n`
  // and imageCostUsd already accounts for it.
  return usdPrice(
    videoCostUsd({
      model: model.id,
      tier: variant.videoTier,
      resolution: variant.resolution ?? model.video.defaultResolution,
      durationSeconds: variant.duration ?? model.video.defaultDuration,
    }) * jobsFor(variant),
  );
}

/** Jobs one click starts — which is what gets billed, whatever the unit. */
function jobsFor(variant: PriceVariant): number {
  return Math.max(1, (variant.mediaType === "image" ? variant.count : variant.videoCount) ?? 1);
}

/** The form as a priceable variant, after the clamps a click would apply. */
export function variantFor(
  form: ApiFormState,
  overrides: Partial<ApiFormState>,
  referenceCount: number,
): PriceVariant {
  const next = normalizeForm({ ...form, ...overrides }, referenceCount).form;
  return {
    mediaType: next.mediaType,
    aspectRatio: next.aspectRatio,
    duration: next.duration,
    resolution: next.resolution,
    videoTier: next.videoTier,
    videoJobType: next.videoJobType,
    videoMode: next.videoMode,
    sizeTier: next.imageSizeTier,
    count: next.count,
    videoCount: next.videoCount,
    generateAudio: next.generateAudio,
    quality: next.quality,
    grok: grokVariantFor(next, referenceCount),
  };
}

/**
 * The Grok half of a variant. Edit and Extend price on the source's own
 * output resolution — there is no resolution control, the clip follows it.
 */
export function grokVariantFor(form: ApiFormState, referenceCount: number): PriceVariant["grok"] {
  const input = grokVideoInputFor(form, referenceCount);
  return {
    mode: input.mode,
    model: input.model,
    frameRoles: input.frameRoles,
    voiceCount: input.voiceCount,
    extendDuration: input.extendDuration,
    source: input.source,
  };
}

/**
 * Every configuration the form can currently reach with one click.
 *
 * Each candidate goes through the same normalizer the click runs, so a quote is
 * asked for exactly the configuration a button would produce — quoting the raw
 * combination fetched prices for states that clamp into something else, and
 * left the button that does exist showing an ellipsis.
 */
export function variantsToQuote(
  model: ApiModel,
  form: ApiFormState,
  referenceCount: number,
): PriceVariant[] {
  const variant = (overrides: Partial<ApiFormState>) => variantFor(form, overrides, referenceCount);

  if (form.mediaType === "image") {
    // The count is a multiplier applied locally, so one quote per size tier is
    // all the vendor needs to be asked for.
    return [
      variant({}),
      ...model.image.sizeTiers.map((tier) => variant({ imageSizeTier: tier.value })),
    ];
  }

  // Video is where the cost actually swings, so every option the user can click
  // gets its own quote — including the model and mode, which change it most.
  const videoModels = model.video.kind === "higgsfield-video" ? model.video.models : [];
  return [
    variant({}),
    // The selected model's lengths, not the union: Wan's 2s and Kling's 3s are
    // on screen as buttons, and quoting the aggregate left exactly those two
    // showing an ellipsis that never resolved.
    ...videoDurations(model.video, form.videoJobType).map((duration) => variant({ duration })),
    ...videoResolutions(
      model.video,
      form.videoTier,
      form.videoJobType,
      form.videoMode,
      referenceCount,
    ).map((resolution) => variant({ resolution })),
    ...videoModels.map((video) => variant({ videoJobType: video.jobType })),
    // Audio is priced on Kling — 10 credits with sound at 5s, 7.5 without.
    ...[true, false].map((generateAudio) => variant({ generateAudio })),
    ...(model.video.kind === "higgsfield-video"
      ? (higgsfieldVideoModel(model.video, form.videoJobType).modeParam?.values ?? []).map(
          (videoMode: string) => variant({ videoMode }),
        )
      : []),
  ];
}
