import type { Doc } from "@/convex/_generated/dataModel";
import { API_MODELS, GROK_VIDEO_MODEL_LITE, isApiModelId, type ApiModelId } from "@/lib/api-models";
import { grokImageModelOf, grokMeteredUsdForRow } from "@/lib/grok-imagine";
import { isAtlasModelId, getAtlasModel } from "@/lib/atlas-models";
import { atlasCostForDisplay } from "@/lib/atlas-price";
import { isAtlasDraft } from "@/lib/atlas-drafts";
import type { ComposerProvider } from "@/lib/normalize-form";
import {
  INCLUDED_PRICE,
  creditsPrice,
  formatCredits,
  formatPrice,
  formatUsd,
  includedPrice,
  usdPrice,
  type Price,
} from "@/lib/api-pricing";

/**
 * What a `grokGenerations` row is — provider, model label, price — without the
 * grid around it. The results grid and the lightbox's details panel both read
 * rows through these, and the panel lives below the grid in the import graph.
 */

export type GenerationDoc = Doc<"grokGenerations">;

/** All output keys for a record, with back-compat for legacy single-key rows. */
export function outputKeys(gen: { b2Key?: string; b2Keys?: string[] }): string[] {
  if (gen.b2Keys && gen.b2Keys.length > 0) return gen.b2Keys;
  return gen.b2Key ? [gen.b2Key] : [];
}

/** Rows written before the model switcher existed were all Grok. */
export function modelIdOf(gen: GenerationDoc): ApiModelId {
  return gen.apiModel && isApiModelId(gen.apiModel) ? gen.apiModel : "grok";
}

/** A clip from the self-hosted video pod (MiniMax H3, or a migrated Wan 2.2
 *  clip). Not a ComposerProvider: it has no API composer and no per-clip price —
 *  the pod is billed by the hour — so every helper below checks it first. */
export function isSelfHostedVideo(gen: GenerationDoc): boolean {
  return gen.provider === "comfy";
}

export function providerOf(gen: GenerationDoc): ComposerProvider {
  if (gen.provider === "fal" || gen.provider === "higgsfield" || gen.provider === "atlas") {
    return gen.provider;
  }
  return "grok";
}

/**
 * Re-price estimated Atlas rows with the current formula.
 *
 * Their stored estimate was calculated at submission time, so fixing the
 * formula alone would leave already-running tiles showing the old understated
 * estimate until a successful completion replaced it with Atlas's final `price`.
 */
export function effectiveCostUsd(gen: GenerationDoc): number | undefined {
  if (providerOf(gen) !== "atlas") return gen.costUsd;
  return atlasCostForDisplay({
    model: gen.apiModel,
    params: gen.atlasParams,
    costUsd: gen.costUsd,
    costEstimated: gen.costEstimated,
  });
}

/** Images a row sent with its prompt, however the row recorded them. */
function referenceCountOf(gen: GenerationDoc): number {
  return (
    gen.referenceB2Keys?.length ??
    gen.referenceStorageIds?.length ??
    (gen.hasReferenceImage ? 1 : 0)
  );
}

/** Which Grok image model a Grok image row ran on; `null` for anything else. */
export function grokImageModelOfRow(
  gen: GenerationDoc,
): ReturnType<typeof grokImageModelOf> | null {
  if (
    isSelfHostedVideo(gen) ||
    providerOf(gen) !== "grok" ||
    modelIdOf(gen) !== "grok" ||
    gen.mediaType === "video"
  ) {
    return null;
  }
  return grokImageModelOf({ quality: gen.quality, referenceCount: referenceCountOf(gen) });
}

/** The details panel's Quality line: the form's label, with what 2.0 Auto served. */
export function qualityLabelOf(gen: GenerationDoc): string | undefined {
  const grokImage = grokImageModelOfRow(gen);
  if (!grokImage) return gen.quality;
  return grokImage.served ? `${grokImage.label} · served as ${grokImage.served}` : grokImage.label;
}

/** The slug and `quality` a Grok image request sent, e.g. "grok-imagine-image-2.0 · quality: low". */
export function grokImageWireOf(gen: GenerationDoc): string | null {
  const grokImage = grokImageModelOfRow(gen);
  if (!grokImage) return null;
  return grokImage.quality ? `${grokImage.model} · quality: ${grokImage.quality}` : grokImage.model;
}

/**
 * The label on a tile.
 *
 * Atlas rows carry a vendor slug in `apiModel`, not a registry id, so
 * `modelIdOf` falls through to "grok" for them — which is how an Atlas video
 * came to be badged as Grok and priced as "subscription". The slug is resolved
 * against the generated catalogue here, with the raw string as the fallback for
 * a model that has since left it.
 */
export function badgeOf(gen: GenerationDoc): string {
  if (isSelfHostedVideo(gen)) {
    if (gen.ltxSettings) return `LTX · ${(gen.apiModel ?? "").replace(/\.safetensors$/, "")}`;
    if (!gen.h3Settings) return "Wan 2.2 · legacy";
    return `H3 · ${(gen.apiModel ?? "").replace(/\.safetensors$/, "")}`;
  }
  if (providerOf(gen) === "atlas" && gen.apiModel) {
    const label = isAtlasModelId(gen.apiModel) ? getAtlasModel(gen.apiModel).label : gen.apiModel;
    return isAtlasDraft(gen) ? `${label} · Draft` : label;
  }
  const badge = API_MODELS[modelIdOf(gen)].badge;
  // Grok's video rows ran on one of three models in one of three modes; the
  // default (Generate on 1.5) keeps the plain badge it always had.
  if (providerOf(gen) === "grok" && gen.mediaType === "video") {
    if (gen.grokVideoMode === "edit") return `${badge} Edit`;
    if (gen.grokVideoMode === "extend") return `${badge} Extend`;
    if (gen.grokVideoModel === GROK_VIDEO_MODEL_LITE) return `${badge} Lite`;
  }
  // Grok's image rows ran on one of five quality entries across three models.
  const grokImage = grokImageModelOfRow(gen);
  if (grokImage) return `${badge} ${grokImage.label}`;
  return badge;
}

/**
 * The SuperGrok quota a Grok row metered: what xAI reported where it reported
 * it, the rate card's figure otherwise. A failed row metered nothing worth
 * showing, so it gets the bare "included".
 */
export function grokPriceOf(gen: GenerationDoc): Price {
  if (gen.status === "failed") return INCLUDED_PRICE;
  if (gen.meteredUsd !== undefined) return includedPrice(gen.meteredUsd, true);
  const produced = outputKeys(gen).length;
  return includedPrice(
    grokMeteredUsdForRow({
      mediaType: gen.mediaType,
      quality: gen.quality,
      resolution: gen.resolution,
      // A batch that came back short metered what it produced.
      count: gen.status === "completed" && produced > 0 ? produced : gen.count,
      duration: gen.duration,
      referenceCount: referenceCountOf(gen),
      grokVideoMode: gen.grokVideoMode,
      grokVideoModel: gen.grokVideoModel,
      grokFrameRoles: gen.grokFrameRoles,
      referenceVoices: gen.referenceVoices,
      sourceVideoSeconds: gen.sourceVideoSeconds,
    }),
  );
}

/** Structured price of a finished generation, for the lightbox. */
export function priceOfGeneration(gen: GenerationDoc): Price | null {
  if (isSelfHostedVideo(gen)) return null;
  switch (providerOf(gen)) {
    case "fal":
      return usdPrice(gen.costUsd ?? 0);
    case "atlas": {
      // Left unset on purpose when the settings did not determine a price —
      // an auto length, or a duration taken from a source clip. Reporting that
      // as $0.00 would be the one wrong answer.
      const cost = effectiveCostUsd(gen);
      return cost === undefined
        ? { currency: "unknown", reason: "Atlas did not publish a rate for these settings" }
        : usdPrice(cost);
    }
    case "higgsfield":
      return gen.creditsUsed === undefined ? null : creditsPrice(gen.creditsUsed);
    case "grok":
      return grokPriceOf(gen);
  }
}

/**
 * What this generation cost, in the unit its provider bills in.
 *
 * `null` only when a Higgsfield quote never landed — a bare "credits" with no
 * figure reads as a broken label, so the badge drops the segment instead.
 */
export function priceOf(gen: GenerationDoc): string | null {
  if (isSelfHostedVideo(gen)) return null;
  switch (providerOf(gen)) {
    case "fal":
      return formatUsd(gen.costUsd ?? 0);
    case "atlas": {
      const cost = effectiveCostUsd(gen);
      return cost === undefined ? null : formatUsd(cost);
    }
    case "higgsfield":
      // Half credits are real here (7.5, 12.5, 22.5); rounding each tile made a
      // batch of four disagree with the button that started it.
      return gen.creditsUsed === undefined ? null : `${formatCredits(gen.creditsUsed)} credits`;
    case "grok": {
      const price = grokPriceOf(gen);
      return price.currency === "included" && price.meteredUsd !== undefined
        ? formatPrice(price)
        : "subscription";
    }
  }
}
