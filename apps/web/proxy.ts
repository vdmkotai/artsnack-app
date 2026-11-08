import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isAllowedUserId } from "@/lib/allowed-users";

/**
 * Public routes.
 *
 * `/api/images` stays public on purpose: it is what lets the browser and the
 * CDN cache media, and an `<img src>` carries no Clerk session on a cross-origin
 * hop. Nothing else under `/api` is public: an open route would be an
 * unauthenticated relay spending the owner's API keys.
 *
 * `/media/*` is not matched at all: it is next.config.ts's rewrite to the public
 * media CDN, fetched by the media cache worker, which must not be sent to a
 * Clerk handshake when the session token is between refreshes.
 *
 * `/robots.txt` is public because it is the instruction to stay out: behind the
 * gate a crawler got a 404, which robots.txt semantics read as "no rules".
 *
 * `/no-access` MUST be public even though only a signed-in user ever reaches it:
 * it is where a session that fails the allowlist is sent, so gating it on the
 * allowlist would redirect it to itself forever.
 */
const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/no-access",
  "/robots.txt",
  "/api/images(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;

  await auth.protect();

  const { userId } = await auth();
  if (
    !isAllowedUserId(userId, {
      allowedUserIds: process.env.ALLOWED_USER_IDS,
      clerkIssuerDomain: process.env.CLERK_JWT_ISSUER_DOMAIN,
    })
  ) {
    // JSON for the API surface so a fetch() sees a parseable body.
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "This account does not have access." }, { status: 403 });
    }
    // A redirect to a real page, not HTML returned from here. The page needs
    // Clerk's JS to actually end the session: `__client` lives on Clerk's
    // Frontend-API domain, so nothing this middleware can write to the response
    // will clear it, and a static page could only ever offer a link that leads
    // straight back into the same check.
    return NextResponse.redirect(new URL("/no-access", req.url));
  }
});

export const config = {
  matcher: [
    "/((?!_next|media/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
