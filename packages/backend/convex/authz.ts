import type { Auth, UserIdentity } from "convex/server";
import { isAllowedUserId } from "../../shared/allowed-users";

/**
 * Authentication *and* authorization for every public Convex function.
 *
 * Checking `getUserIdentity()` alone only proves the caller holds a valid token
 * from our Clerk instance — not that they are supposed to be here. Clerk's own
 * sign-up restriction is a paid feature this plan does not have, so anyone able
 * to create an account against the instance would otherwise arrive holding a
 * perfectly valid identity and be able to spend the account-wide fal balance
 * and Higgsfield plan credits. The allowlist is what makes the identity mean
 * something. See packages/shared/allowed-users.ts for why it fails closed, and
 * for why it does not apply when the Clerk instance is a development one.
 *
 * Queries and mutations differ in how they should react to a stranger, so there
 * are two entry points rather than one with a flag:
 *
 *   requireAllowedUser  throws — for anything that writes or spends.
 *   allowedUserOrNull   returns null — for read queries whose callers already
 *                       render an empty state while auth settles, and would
 *                       otherwise flash an error boundary on every cold load.
 */

type AuthCtx = { auth: Auth };

function isAllowed(identity: UserIdentity): boolean {
  return isAllowedUserId(identity.subject, {
    allowedUserIds: process.env.ALLOWED_USER_IDS,
    // The same variable auth.config.ts hands Convex as the trusted issuer, so
    // "is this a development instance" is answered by the very value that
    // decides which instance's tokens are accepted at all.
    clerkIssuerDomain: process.env.CLERK_JWT_ISSUER_DOMAIN,
  });
}

/** The caller's identity, or a thrown error if they are absent or not allowed. */
export async function requireAllowedUser(ctx: AuthCtx): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  if (!isAllowed(identity)) throw new Error("This account does not have access");
  return identity;
}

/** The caller's identity, or null if they are absent or not allowed. */
export async function allowedUserOrNull(ctx: AuthCtx): Promise<UserIdentity | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || !isAllowed(identity)) return null;
  return identity;
}
