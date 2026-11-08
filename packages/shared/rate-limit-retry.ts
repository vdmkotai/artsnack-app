/**
 * Retries an operation that the vendor refused with a rate limit.
 *
 * Only for refusals that are known to have done nothing — a 429 from Atlas's
 * submit or xAI's image endpoints means the request was not accepted, so a
 * second attempt cannot queue or bill a duplicate. Anything else is thrown at
 * once: a timeout after the request left is ambiguous and stays the caller's
 * call.
 *
 * The waits grow and carry jitter, because the callers are fan-outs: ten
 * siblings refused in the same second and retried on the same schedule would
 * collide again on every attempt. A vendor's own Retry-After is honoured in
 * full, never shortened — retrying before it only spends attempts on refusals
 * the vendor already announced. A wait that does not fit the budget fails at
 * once instead: the callers run inside a ten-minute action that still has the
 * request itself, and the upload, to do.
 */

export type RateLimitRetryOptions = {
  /** Undefined when the error is not a rate limit; else the vendor's wait, or null. */
  rateLimitWaitMs: (error: unknown) => number | null | undefined;
  /** Base waits before each retry; their count is the number of retries. */
  delaysMs?: readonly number[];
  /** Upper bound on any one of our own waits. A vendor's figure is not capped. */
  maxWaitMs?: number;
  /** All waiting together, vendor figures included. Past it the 429 surfaces. */
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

/** About 30 s of our own waiting in all. */
export const RATE_LIMIT_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const;
const MAX_WAIT_MS = 30_000;
/** Leaves an image action most of its ten minutes for the work itself. */
export const RATE_LIMIT_BUDGET_MS = 90_000;

/** The wait before retry `attempt` (0-based): ±25% around the base, or the vendor's figure. */
export function rateLimitWaitMs(
  attempt: number,
  vendorWaitMs: number | null,
  options: Pick<RateLimitRetryOptions, "delaysMs" | "maxWaitMs" | "random"> = {},
): number {
  const random = options.random ?? Math.random;
  // Jitter on top of a vendor's figure only lengthens it, never undercuts it.
  if (vendorWaitMs !== null) return Math.round(Math.max(0, vendorWaitMs) + random() * 500);
  const delays = options.delaysMs ?? RATE_LIMIT_DELAYS_MS;
  const base = delays[Math.min(attempt, delays.length - 1)];
  const jittered = base * (0.75 + random() * 0.5);
  return Math.round(Math.min(options.maxWaitMs ?? MAX_WAIT_MS, Math.max(0, jittered)));
}

export async function withRateLimitRetry<T>(
  run: () => Promise<T>,
  options: RateLimitRetryOptions,
): Promise<T> {
  const delays = options.delaysMs ?? RATE_LIMIT_DELAYS_MS;
  const budget = options.budgetMs ?? RATE_LIMIT_BUDGET_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const vendorWait = options.rateLimitWaitMs(error);
      if (vendorWait === undefined || attempt >= delays.length) throw error;
      const wait = rateLimitWaitMs(attempt, vendorWait, options);
      if (waited + wait > budget) throw error;
      waited += wait;
      await sleep(wait);
    }
  }
}

/** Seconds or an HTTP date, as Retry-After allows; null when absent or unreadable. */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
