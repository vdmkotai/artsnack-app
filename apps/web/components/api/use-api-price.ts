"use client";

import * as React from "react";
import { useAction, useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { type ApiModel } from "@/lib/api-models";
import {
  variantSignature,
  variantsToQuote,
  type PriceVariant,
  type QuoteMap,
} from "@/lib/api-price";
import { type ApiFormState } from "@/lib/normalize-form";

/**
 * The arithmetic moved to packages/shared so the iOS app can price its own
 * Generate button from the same source. Re-exported here because the components
 * using it have always imported it from this module, and because fetching a
 * quote and computing a price belong together at the call site.
 */
export {
  priceForVariant,
  variantFor,
  variantSignature,
  variantsToQuote,
  type PriceVariant,
  type QuoteMap,
} from "@/lib/api-price";

/**
 * The variants to quote for a form, computed once per distinct configuration.
 *
 * `variantsToQuote` runs the full form normaliser once per variant, and the
 * form changes on every keystroke in the prompt — which none of the variants
 * depend on. Keyed on the fields that do, so typing reuses the last list (and
 * its identity, which is what keeps the quote effect below from re-running).
 * The cache used to be a `useMemo` with a hand-picked dependency list, and the
 * eslint-disable that needed switched the React Compiler off for this hook.
 */
const wantedCache = new Map<string, PriceVariant[]>();
const WANTED_CACHE_LIMIT = 64;

function wantedVariants(
  model: ApiModel,
  form: ApiFormState,
  referenceCount: number,
): PriceVariant[] {
  const key = JSON.stringify([
    model.id,
    referenceCount,
    form.mediaType,
    form.aspectRatio,
    form.duration,
    form.resolution,
    form.videoTier,
    form.videoJobType,
    form.videoMode,
    form.imageSizeTier,
    form.count,
    form.videoCount,
    form.generateAudio,
  ]);
  const cached = wantedCache.get(key);
  if (cached) return cached;
  const variants = variantsToQuote(model, form, referenceCount);
  wantedCache.set(key, variants);
  if (wantedCache.size > WANTED_CACHE_LIMIT) {
    const oldest = wantedCache.keys().next().value;
    if (oldest !== undefined) wantedCache.delete(oldest);
  }
  return variants;
}

const NO_VARIANTS: PriceVariant[] = [];

/**
 * Keeps Higgsfield quotes warm for the options on screen.
 *
 * Quotes are cached server-side by signature and change only when Higgsfield
 * changes its pricing, so this fetches each distinct configuration once and
 * then reads from cache. Non-Higgsfield models never reach the network.
 */
export function useHiggsfieldQuotes(
  model: ApiModel,
  form: ApiFormState,
  referenceCount: number,
): QuoteMap {
  const isHiggsfield = model.provider === "higgsfield";
  const cached = useQuery(api.higgsfield.listCosts, isHiggsfield ? {} : "skip");
  const estimate = useAction(api.higgsfieldProcessor.estimateCost);
  const requested = React.useRef(new Set<string>());

  const quotes = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const row of cached ?? []) map.set(row.signature, row.credits);
    return map;
  }, [cached]);

  // The same array for the same configuration, so this only changes when the
  // form really moved — see `wantedVariants`.
  const wanted = isHiggsfield ? wantedVariants(model, form, referenceCount) : NO_VARIANTS;

  React.useEffect(() => {
    if (!isHiggsfield || cached === undefined) return;
    // Variants overlap — the base config repeats among the per-duration and
    // per-resolution ones — so the same quote would otherwise be asked for twice.
    const seen = new Set<string>();
    const missing: { variant: PriceVariant; signature: string }[] = [];
    for (const variant of wanted) {
      const signature = variantSignature(model, variant, referenceCount);
      if (!signature) continue;
      if (quotes.has(signature) || requested.current.has(signature) || seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      missing.push({ variant, signature });
    }
    if (missing.length === 0) return;

    let cancelled = false;
    void (async () => {
      // Sequential on purpose: each one is a CLI round trip on the vendor's
      // side, and a burst of them would be rude and slower than it looks.
      for (const entry of missing) {
        if (cancelled) return;
        requested.current.add(entry.signature);
        try {
          await estimate({
            model: model.id,
            mediaType: entry.variant.mediaType,
            aspectRatio: entry.variant.aspectRatio,
            sizeTier: entry.variant.sizeTier,
            videoJobType: entry.variant.videoJobType,
            videoMode: entry.variant.videoMode,
            generateAudio: entry.variant.generateAudio,
            duration: entry.variant.duration,
            resolution: entry.variant.resolution,
            referenceCount,
          });
        } catch {
          // Release it: a blip while the credentials are still being seeded
          // would otherwise leave that configuration priceless for the session.
          requested.current.delete(entry.signature);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isHiggsfield, cached, wanted, quotes, model, referenceCount, estimate]);

  return quotes;
}
