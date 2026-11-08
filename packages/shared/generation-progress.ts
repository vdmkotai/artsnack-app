export const GENERATION_PROGRESS_STAGES = [
  "queued",
  "preparing",
  "preparing-inputs",
  "submitting",
  "provider-queued",
  "generating",
  "downloading-output",
  "uploading-output",
  "saving-output",
  "finalizing",
] as const;

export type GenerationProgressStage = (typeof GENERATION_PROGRESS_STAGES)[number];

export type GenerationProgressRecord = {
  status?: string;
  mediaType?: "image" | "video";
  dispatchedAt?: number;
  progressStage?: string;
  progressMessage?: string;
  progressCurrent?: number;
  progressTotal?: number;
  queuePosition?: number;
};

/** Provider logs are useful status text, but they are still untrusted input. */
export function sanitizeProgressMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 160) : undefined;
}

export function generationProgressPercent(
  progress: Pick<GenerationProgressRecord, "progressCurrent" | "progressTotal">,
): number | undefined {
  const current = progress.progressCurrent;
  const total = progress.progressTotal;
  if (
    typeof current !== "number" ||
    typeof total !== "number" ||
    !Number.isFinite(current) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return undefined;
  }
  return Math.max(0, Math.min(100, (current / total) * 100));
}

function queueLabel(position: number | undefined): string {
  if (position === undefined) return "Waiting in provider queue...";
  if (position <= 0) return "Next in provider queue...";
  return `${position} ${position === 1 ? "job" : "jobs"} ahead...`;
}

/** One wording policy for hosted API, self-hosted image, and video cards. */
export function generationProgressLabel(progress: GenerationProgressRecord): string {
  const message = sanitizeProgressMessage(progress.progressMessage);
  const media = progress.mediaType === "video" ? "video" : "image";

  switch (progress.progressStage) {
    case "queued":
      return (
        message ??
        (progress.dispatchedAt === undefined ? "Waiting for a worker slot..." : "Queued...")
      );
    case "preparing":
      return message ?? "Preparing request...";
    case "preparing-inputs":
      return (
        message ??
        (media === "video" ? "Preparing source media..." : "Preparing reference images...")
      );
    case "submitting":
      return message ?? "Sending to provider...";
    case "provider-queued":
      return message ?? queueLabel(progress.queuePosition);
    case "generating":
      return message ?? `Generating ${media}...`;
    case "saving-output":
      return message ?? "Saving result to media storage...";
    case "downloading-output":
      return message ?? "Downloading generated media...";
    case "uploading-output":
      return message ?? "Uploading result to media storage...";
    case "finalizing":
      return message ?? "Finalizing result...";
    default:
      if (progress.status === "pending") {
        return progress.dispatchedAt === undefined ? "Waiting for a worker slot..." : "Queued...";
      }
      return `Generating ${media}...`;
  }
}
