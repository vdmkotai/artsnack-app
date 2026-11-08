"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * "Details" affordance on a failed tile: the full vendor response, which is
 * far too long and too unbroken to sit in a grid cell, shown on demand and
 * copyable for a support thread or a bug report.
 */
export function FailureDetails({ title, message }: { title: string; message: string }) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure origin, denied permission) — the text is
      // on screen and selectable, so there is nothing to report here.
    }
  }, [message]);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-destructive hover:bg-destructive/15"
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        Details
      </PopoverTrigger>
      <PopoverContent
        align="center"
        className="w-[min(28rem,calc(100vw-2rem))] space-y-2"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium">{title}</p>
          <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={copy}>
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <pre className="max-h-[50vh] overflow-auto rounded bg-muted/60 p-2 text-[11px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          {message}
        </pre>
      </PopoverContent>
    </Popover>
  );
}
