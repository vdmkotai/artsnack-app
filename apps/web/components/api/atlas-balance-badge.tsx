"use client";

import * as React from "react";
import { useAction } from "convex/react";
import { Loader2, Wallet } from "lucide-react";

import { api } from "@/convex/_generated/api";
import { formatUsd } from "@/lib/api-pricing";
import { cn } from "@/lib/utils";

/**
 * What is left in the Atlas account.
 *
 * Atlas spends a prepaid balance, so the useful number while composing is the
 * remainder, not a running total of what has been spent — the failure mode this
 * exists to prevent is a queued batch dying on a 402 halfway through.
 *
 * An action rather than a query, because reading it means calling the vendor.
 * That also means it does not update itself, so it is refreshed on mount and
 * whenever `refreshKey` changes — the panel bumps that after every submission,
 * which is the only moment the figure can have moved.
 */
export function AtlasBalanceBadge({
  refreshKey,
  className,
}: {
  refreshKey?: number;
  className?: string;
}) {
  const getBalance = useAction(api.atlasBalance.get);
  const [balance, setBalance] = React.useState<{
    available: number | null;
    cash: number | null;
    frozen: number | null;
    currency: string;
  } | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getBalance({})
      .then((result) => {
        if (cancelled) return;
        setBalance(
          result
            ? {
                available: result.available,
                cash: result.cash,
                frozen: result.frozen,
                currency: result.currency,
              }
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setBalance(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [getBalance, refreshKey]);

  // No key configured, or the vendor would not answer. Saying nothing beats a
  // zero, which reads as "you are out of money".
  if (!loading && (balance === null || balance.available === null)) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1 text-xs",
        // Below roughly one 15-second Seedance clip, the number stops being
        // background information and becomes the thing about to go wrong.
        balance?.available !== null &&
          balance !== null &&
          balance.available < 2 &&
          "border-amber-500/50 text-amber-600 dark:text-amber-400",
        className,
      )}
      title={
        balance?.cash !== null && balance?.cash !== undefined
          ? `Atlas balance ${formatUsd(balance.cash)}${balance.frozen ? `; ${formatUsd(balance.frozen)} held by active generations` : ""}`
          : "Atlas Cloud account balance"
      }
    >
      <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
      {loading || balance === null || balance.available === null ? (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      ) : (
        <span className="font-medium tabular-nums">{formatUsd(balance.available)} available</span>
      )}
      {!loading &&
        balance?.frozen !== null &&
        balance?.frozen !== undefined &&
        balance.frozen > 0 && (
          <span className="tabular-nums text-muted-foreground">
            · {formatUsd(balance.frozen)} held
          </span>
        )}
    </span>
  );
}
