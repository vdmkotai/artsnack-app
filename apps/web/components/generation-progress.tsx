import {
  generationProgressLabel,
  generationProgressPercent,
  type GenerationProgressRecord,
} from "@/lib/generation-progress";
import { cn } from "@/lib/utils";

export function GenerationProgress({
  value,
  className,
}: {
  value: GenerationProgressRecord;
  className?: string;
}) {
  const percent = generationProgressPercent(value);
  const label = generationProgressLabel(value);

  return (
    <div className={cn("w-full space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate" title={label}>
          {label}
        </span>
        {percent !== undefined ? (
          <span className="shrink-0 tabular-nums">{Math.round(percent)}%</span>
        ) : null}
      </div>
      <div
        aria-label={label}
        aria-valuemax={percent === undefined ? undefined : 100}
        aria-valuemin={percent === undefined ? undefined : 0}
        aria-valuenow={percent === undefined ? undefined : Math.round(percent)}
        className="h-1.5 overflow-hidden rounded-full bg-primary/15"
        role="progressbar"
      >
        {percent === undefined ? (
          <div className="h-full w-full animate-pulse bg-gradient-to-r from-transparent via-primary/70 to-transparent" />
        ) : (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
    </div>
  );
}
