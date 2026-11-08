/**
 * The state behind lib/convex-identity.ts, without React or Convex imports so
 * it can be tested on its own (Bun's module mocks are process-wide, and other
 * suites replace "convex/react").
 */

type Phase = "pending" | "cycling" | "confirmed";

let tracked: { user: string | null; phase: Phase } = { user: null, phase: "pending" };
let confirmedUser: string | null = null;
const listeners = new Set<() => void>();

function setConfirmedUser(next: string | null) {
  if (next === confirmedUser) return;
  confirmedUser = next;
  for (const listener of listeners) listener();
}

export function subscribeConfirmedUser(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Advances the confirmation for one observation of Clerk's user and Convex's
 * auth state. Exported for tests; the tracker below is its only caller.
 */
export function observeConvexIdentity(user: string | null, convexReady: boolean): string | null {
  if (user !== tracked.user) {
    tracked = { user, phase: "pending" };
    setConfirmedUser(null);
  }
  if (user === null) return confirmedUser;
  if (tracked.phase === "pending" && !convexReady) {
    tracked = { user, phase: "cycling" };
  } else if (tracked.phase === "cycling" && convexReady) {
    tracked = { user, phase: "confirmed" };
    setConfirmedUser(user);
  }
  return confirmedUser;
}

/** Test-only: back to the state of a fresh page. */
export function resetConvexIdentityForTests() {
  tracked = { user: null, phase: "pending" };
  confirmedUser = null;
}

export function getConfirmedUser(): string | null {
  return confirmedUser;
}
