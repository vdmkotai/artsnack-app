"use client";

import * as React from "react";
import { useAction, useQuery } from "convex/react";
import { Coins, Loader2 } from "lucide-react";

import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";

/**
 * Remaining Higgsfield plan credits.
 *
 * Higgsfield spends from a plan rather than a card, so the number that actually
 * matters while generating is what is left — not a running total of what has
 * been used. Refreshed on mount and after every generation; the action itself
 * throttles the vendor call.
 */
export function CreditsBadge({ className }: { className?: string }) {
  const account = useQuery(api.higgsfield.getAccount);
  const refresh = useAction(api.higgsfieldProcessor.refreshBalance);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    void refresh({}).catch(() => setFailed(true));
  }, [refresh]);

  // Not connected yet, or the balance call failed — say nothing rather than
  // showing a zero that would read as "out of credits".
  if (failed || account === null) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1 text-xs",
        className,
      )}
      title={
        account
          ? `Higgsfield plan${account.planType ? ` · ${account.planType}` : ""}`
          : "Loading Higgsfield balance"
      }
    >
      <Coins className="h-3.5 w-3.5 text-muted-foreground" />
      {account === undefined ? (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      ) : (
        <>
          <span className="font-medium tabular-nums">
            {Math.round(account.credits).toLocaleString()}
          </span>
          <span className="text-muted-foreground">credits</span>
        </>
      )}
    </span>
  );
}
