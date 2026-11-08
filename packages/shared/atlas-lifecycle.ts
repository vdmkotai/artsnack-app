/** Durable poll ownership shared by the processor and its rescue cron. */
export type AtlasPollLeaseRow = {
  status: "pending" | "processing" | "completed" | "failed";
  provider?: string;
  falRequestId?: string;
  atlasPollLeaseId?: string;
  atlasPollLeaseUntil?: number;
};

/** A scheduled continuation should claim its reservation within one minute. */
export const ATLAS_RESUME_START_GRACE_MS = 60_000;

/** Four minutes of polling plus room to hand the result to the save phase. */
export const ATLAS_POLL_LEASE_MS = 6 * 60_000;

/** Large video downloads and B2 uploads get a separate renewable lease. */
export const ATLAS_OUTPUT_SAVE_LEASE_MS = 6 * 60_000;

/** Whole polling budget, preserved across action hand-offs and watchdog runs. */
export const ATLAS_TOTAL_WAIT_MS = 32 * 60_000;

function isRecoverableAtlasPoll(row: AtlasPollLeaseRow): boolean {
  return row.status === "processing" && row.provider === "atlas" && Boolean(row.falRequestId);
}

/** A missing or expired lease means no action can be trusted to keep polling. */
export function atlasNeedsPollRescue(row: AtlasPollLeaseRow, now: number): boolean {
  return isRecoverableAtlasPoll(row) && (row.atlasPollLeaseUntil ?? 0) <= now;
}

/**
 * The scheduled owner may renew its own lease. A different action may take over
 * only after that lease expires, which prevents overlapping 100MB+ downloads.
 */
export function atlasCanClaimPoll(row: AtlasPollLeaseRow, leaseId: string, now: number): boolean {
  if (!isRecoverableAtlasPoll(row)) return false;
  return row.atlasPollLeaseId === leaseId || (row.atlasPollLeaseUntil ?? 0) <= now;
}

/** Legacy rows fall back to their creation time; new requests persist the exact deadline. */
export function atlasRecoveryDeadline(
  row: { createdAt: number; atlasWaitEndsAt?: number },
  totalWaitMs: number,
): number {
  return row.atlasWaitEndsAt ?? row.createdAt + totalWaitMs;
}

/** Scheduler handoff is best effort because the lease watchdog is the durable retry. */
export async function tryAtlasHandoff(
  handoff: () => Promise<unknown>,
  report: (error: unknown) => void,
): Promise<boolean> {
  try {
    await handoff();
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}
