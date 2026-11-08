import { auth, clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import {
  DESKTOP_HANDOFF_PATH,
  desktopSignInDeepLink,
  nativeHandoffPath,
  nativeSignInDeepLink,
  parseNativeHandoffRequest,
} from "@/lib/desktop-bridge";
import { HandoffFailure, HandoffLauncher } from "./handoff-launcher";

/**
 * Where the macOS shell sends the system browser to sign in.
 *
 * Google refuses OAuth inside any embedded browser — "This browser or app may
 * not be secure" — and Electron is one however it introduces itself. So the
 * shell opens this page in the real browser instead. proxy.ts has already
 * required a signed-in, allowlisted user by the time it renders (an anonymous
 * visitor was bounced to /sign-in and comes back here afterwards), so all it
 * does is mint a single-use Clerk sign-in token for that user and send the
 * browser to the artsnack:// link the shell registered. The shell turns the
 * ticket into a session with Clerk's <SignIn> on its own /sign-in page.
 *
 * Two minutes is generous for a click on "Open ArtSnack" and short enough
 * that a leaked link is worthless by the time anyone reads it. The token is
 * also consumed on first use.
 *
 * A failure to mint is rendered, message and all, rather than thrown: this is
 * a private instance with one user, and the generic error boundary hides the
 * only thing that would explain what to fix.
 *
 * The native macOS app (apps/macos) asks with `?client=native&state=…` and gets
 * its own `artsnack-native://` link with the state echoed back; see
 * packages/shared/desktop-bridge.ts. Without those params this is the Electron
 * shell's handoff, unchanged.
 */
export const dynamic = "force-dynamic";

export default async function DesktopHandoffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const native = parseNativeHandoffRequest(await searchParams);
  const { userId } = await auth();
  if (!userId) {
    const back = native ? nativeHandoffPath(native.state) : DESKTOP_HANDOFF_PATH;
    redirect(`/sign-in?redirect_url=${encodeURIComponent(back)}`);
  }

  try {
    const client = await clerkClient();
    const token = await client.signInTokens.createSignInToken({
      userId,
      expiresInSeconds: 120,
    });
    const href = native
      ? nativeSignInDeepLink(token.token, native.state)
      : desktopSignInDeepLink(token.token);
    return <HandoffLauncher href={href} />;
  } catch (error) {
    console.error("[desktop/handoff] createSignInToken failed", error);
    return <HandoffFailure message={describeClerkError(error)} />;
  }
}

/**
 * Clerk's backend SDK throws a ClerkAPIResponseError whose useful part is the
 * `errors` array, not `message`; fall back to whatever is there.
 */
function describeClerkError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as {
      errors?: { message?: string; longMessage?: string; code?: string }[];
      status?: number;
      message?: string;
      clerkTraceId?: string;
    };
    const parts = (e.errors ?? []).map((x) => x.longMessage || x.message || x.code).filter(Boolean);
    const head = parts.length ? parts.join("; ") : e.message || String(error);
    const status = e.status ? ` (HTTP ${e.status})` : "";
    const trace = e.clerkTraceId ? ` — trace ${e.clerkTraceId}` : "";
    return `${head}${status}${trace}`;
  }
  return String(error);
}
