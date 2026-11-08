/**
 * A Convex token from Clerk, retried through transient failures.
 *
 * Convex treats a `null` from the token fetcher as "authentication failed" and
 * never asks again on its own: the stock Clerk adapter turns every thrown error
 * into `null`, so a single refresh that fell on a laptop waking from sleep, or
 * on a dropped Wi-Fi, left the whole app running anonymously — empty grids,
 * "Sign in to view favorites" — until a reload. Clerk throws when it cannot
 * reach its API (ClerkOfflineError among others) and returns `null` only when
 * there is no session, so only the throw is retried.
 *
 * Outside any component because the React Compiler cannot compile a try
 * statement; the clock, the wait and the online check are parameters so the
 * policy can be tested without a browser.
 */

/** How long one token request keeps retrying before Convex is told it failed. */
export const TOKEN_RETRY_DEADLINE_MS = 45_000;
/**
 * How long a single `getToken` call may take. Clerk retries internally with its
 * own backoff, so one call can outlast the whole budget above unless it is cut
 * short; a late answer from an abandoned call is ignored (Clerk caches it, so
 * the next call gets it at once).
 */
export const TOKEN_ATTEMPT_TIMEOUT_MS = 20_000;
/** Ceiling on the backoff between retries; also the wait while offline. */
export const TOKEN_RETRY_MAX_DELAY_MS = 8_000;

export type GetClerkToken = (options: {
  template?: "convex";
  skipCache?: boolean;
}) => Promise<string | null>;

export type TokenRetryEnvironment = {
  now: () => number;
  isOnline: () => boolean;
  /** Resolves after `ms`, or earlier if the network comes back. */
  wait: (ms: number) => Promise<void>;
  /** Resolves after `ms` unless cancelled first. */
  timeout: (ms: number) => { done: Promise<void>; cancel: () => void };
};

/** Waits `ms`, or until the browser reports it is back online. */
function waitOrOnline(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", done);
      resolve();
    };
    const timer = window.setTimeout(done, ms);
    window.addEventListener("online", done);
  });
}

function browserTimeout(ms: number) {
  let timer = 0;
  const done = new Promise<void>((resolve) => {
    timer = window.setTimeout(resolve, ms);
  });
  return { done, cancel: () => window.clearTimeout(timer) };
}

const browserEnvironment: TokenRetryEnvironment = {
  now: () => Date.now(),
  isOnline: () => navigator.onLine,
  wait: waitOrOnline,
  timeout: browserTimeout,
};

type Attempt = { kind: "token"; token: string | null } | { kind: "failed" };

/** The delay before retry number `attempt` (0-based). */
export function tokenRetryDelay(attempt: number, online: boolean): number {
  return online ? Math.min(500 * 2 ** attempt, TOKEN_RETRY_MAX_DELAY_MS) : TOKEN_RETRY_MAX_DELAY_MS;
}

export async function fetchConvexToken(
  getToken: GetClerkToken,
  useTemplate: boolean,
  forceRefreshToken: boolean,
  environment: TokenRetryEnvironment = browserEnvironment,
): Promise<string | null> {
  const deadline = environment.now() + TOKEN_RETRY_DEADLINE_MS;
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - environment.now();
    if (remaining <= 0) return null;
    const timer = environment.timeout(Math.min(TOKEN_ATTEMPT_TIMEOUT_MS, remaining));
    const outcome: Attempt = await Promise.race([
      getToken(
        useTemplate
          ? { template: "convex", skipCache: forceRefreshToken }
          : { skipCache: forceRefreshToken },
      ).then(
        (token): Attempt => ({ kind: "token", token }),
        (): Attempt => ({ kind: "failed" }),
      ),
      timer.done.then((): Attempt => ({ kind: "failed" })),
    ]);
    timer.cancel();
    if (outcome.kind === "token") return outcome.token;
    const left = deadline - environment.now();
    if (left <= 0) return null;
    await environment.wait(Math.min(tokenRetryDelay(attempt, environment.isOnline()), left));
  }
}
