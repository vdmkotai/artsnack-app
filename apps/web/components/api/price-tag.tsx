"use client";

import { formatMetered, formatPrice, type Price } from "@/lib/api-pricing";
import { cn } from "@/lib/utils";

/**
 * The price of a generation, in every place one is shown.
 *
 * Providers bill in different units — fal in dollars, Higgsfield in plan
 * credits, Grok not at all — so the unit travels with the amount rather than
 * being converted through a rate we would have had to invent.
 *
 * `null` means a Higgsfield quote is still in flight. Those come from the
 * vendor's own `generate cost`, so there is a beat before the real figure
 * arrives; a placeholder is honest where a made-up number would not be.
 */
export function PriceTag({
  price,
  approximate,
  className,
}: {
  price: Price | null;
  /** Renders a ≈ prefix for figures not yet confirmed against a finished job. */
  approximate?: boolean;
  className?: string;
}) {
  const isPending = price === null;
  return (
    <span
      className={cn("text-xs text-muted-foreground", !isPending && "tabular-nums", className)}
      title={
        isPending
          ? "Asking Higgsfield for a quote"
          : price.currency === "included" && price.meteredUsd !== undefined
            ? price.measured
              ? "Included in SuperGrok — xAI metered this against the subscription's quota"
              : "Included in SuperGrok — what xAI's API rates meter against the subscription's quota"
            : undefined
      }
    >
      {approximate && !isPending && price.currency !== "included" ? "≈" : ""}
      {formatPrice(price)}
    </span>
  );
}

/**
 * Compact inline price beside an individual option button. A SuperGrok price
 * shows only its metered quota ("≈$0.08"), and nothing where it has none.
 */
export function OptionPrice({ price }: { price: Price | null }) {
  if (price && price.currency === "included") {
    const metered = formatMetered(price);
    return metered === null ? null : (
      <span className="ml-1 text-[10px] tabular-nums opacity-70">{metered}</span>
    );
  }
  return <span className="ml-1 text-[10px] tabular-nums opacity-70">{formatPrice(price)}</span>;
}
