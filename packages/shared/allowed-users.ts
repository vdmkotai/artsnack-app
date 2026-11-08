/**
 * Who is allowed to use this deployment.
 *
 * Clerk's own sign-up restriction (`app:allowlist`) is a paid feature this plan
 * does not carry, and it would not have been enough on its own: Convex trusts
 * any valid token from the Clerk instance, so a flag in Clerk's dashboard would
 * still leave every Convex mutation reachable by a stranger who signed up. The
 * gate therefore lives in the application, and is applied in both places that
 * accept a token — the Next.js proxy and every public Convex function.
 *
 * `ALLOWED_USER_IDS` is a comma-separated list of Clerk user ids
 * (`identity.subject` in Convex, `userId` in the proxy). It must be set in
 * Vercel and in *both* Convex deployments; the two Convex environments do not
 * share variables, and a missing value on one of them would otherwise silently
 * reopen the door.
 *
 * Unset means "nobody", not "everybody". Failing open here would turn one
 * forgotten variable back into the exact hole this closes, and the failure mode
 * of failing closed is loud and immediate rather than silent and permanent.
 *
 * ## Development instances are exempt
 *
 * Clerk user ids are scoped to a Clerk *instance*, and a deployment usually has
 * two: the Clerk production instance on the app's own domain
 * (`clerk.<your-domain>`), and a development instance at
 * `<slug>.clerk.accounts.dev` that local dev signs into. The same person has a
 * different id in each. So a single `ALLOWED_USER_IDS` holding the production
 * ids — which is what `vercel env pull` writes into `apps/web/.env.local` —
 * locks the owner out of their own local dev the moment they sign in, and the
 * only visible symptom is a redirect to /no-access.
 *
 * Rather than maintain a second, hand-synced list of dev ids that the next
 * `vercel env pull` would silently clobber again, the allowlist simply does not
 * apply when the Clerk instance is a development one. `isClerkDevelopmentInstance`
 * reads that off `CLERK_JWT_ISSUER_DOMAIN`, which is already set in the proxy and
 * in both Convex deployments, so no environment variable has to change and no
 * list has to be kept in sync.
 *
 * This cannot leak into production. Clerk development instances always live on
 * `*.clerk.accounts.dev`; a production instance is on the app's own domain and
 * can never report that host. Serving production off a development instance is
 * not something a stray variable does by accident — it would mean production
 * running on keys capped at 100 users. And the check still fails closed: an
 * unset or unparseable issuer is *not* treated as development, so the allowlist
 * applies exactly as before.
 */

/** Parse the raw env value into a set of ids, tolerating spaces and stray commas. */
export function parseAllowedUserIds(raw: string | undefined | null): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/**
 * True when `CLERK_JWT_ISSUER_DOMAIN` names a Clerk *development* instance.
 *
 * Matched on the parsed hostname rather than with a substring test, so that a
 * host merely containing the string (`clerk.accounts.dev.example.com`) does not
 * count. Anything that is not a parseable URL is not a development instance —
 * the unset case has to land on the safe side.
 */
export function isClerkDevelopmentInstance(issuerDomain: string | undefined | null): boolean {
  if (!issuerDomain) return false;
  const trimmed = issuerDomain.trim();
  if (!trimmed) return false;
  let hostname: string;
  try {
    // The variable is written both ways in practice — with the scheme in the
    // web and Convex environments, and occasionally as a bare host.
    hostname = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return false;
  }
  return hostname.toLowerCase().endsWith(".clerk.accounts.dev");
}

/**
 * True when this Clerk user id may use the deployment.
 *
 * The environment is passed as one object rather than as positional arguments
 * because the issuer is what decides whether the list is consulted at all, and a
 * caller that forgets it should have to say so out loud.
 */
export function isAllowedUserId(
  userId: string | null | undefined,
  env: {
    allowedUserIds: string | undefined;
    clerkIssuerDomain: string | undefined;
  },
): boolean {
  if (!userId) return false;
  if (isClerkDevelopmentInstance(env.clerkIssuerDomain)) return true;
  return parseAllowedUserIds(env.allowedUserIds).has(userId);
}
