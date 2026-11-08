"use client";

import { useEffect } from "react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import {
  Wand2,
  Clock,
  Images,
  Heart,
  // Clapperboard, // used by hidden "Video Generation" tab
  // GalleryVerticalEnd, // used by hidden "Video History" tab
  Zap,
  Library,
  Search,
  Settings,
} from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { useAuth } from "@clerk/nextjs";
import { cn } from "@/lib/utils";
import { useDesktop, useTrafficLightInset } from "@/hooks/use-desktop";

function isAuthDebugEnabled(): boolean {
  return process.env.NODE_ENV === "development";
}

function logAuthClientDebug(event: string, payload: Record<string, unknown>) {
  if (!isAuthDebugEnabled()) {
    return;
  }

  const timestamp = new Date().toISOString();
  console.log(`[VK_AUTH_CLIENT ${timestamp}] ${event}`, {
    href: window.location.href,
    ...payload,
  });
}

export function TabNav() {
  const pathname = usePathname();
  const { isLoaded, isSignedIn, userId } = useAuth();
  const desktop = useDesktop();
  const trafficLightInset = useTrafficLightInset();

  useEffect(() => {
    logAuthClientDebug("pathname_changed", {
      pathname,
      search: window.location.search,
      isLoaded,
      isSignedIn,
      userId: userId ?? null,
      hasClerkDbJwt: window.location.search.includes("__clerk_db_jwt"),
    });
  }, [pathname, isLoaded, isSignedIn, userId]);

  // No app chrome before sign-in. The auth pages should show the Clerk card and
  // nothing else, and an anonymous visitor who lands on a protected route — which
  // Clerk rewrites to a 404 rather than redirecting — should not be handed a
  // navigation bar for an app they cannot enter either. /no-access is in the
  // same list for the opposite reason: that visitor *is* signed in, so the
  // isSignedIn test below would happily draw a nav full of links they cannot
  // follow.
  //
  // The pathname test is what makes this flash-free: it is known synchronously on
  // the very first render, so an auth page never paints a nav that then vanishes.
  // The isSignedIn test covers the general case and only settles once Clerk has
  // loaded, which on a protected route always resolves to "signed in" — so on the
  // pages that do show the nav, nothing moves.
  //
  // Deliberately a client-side check: hiding this from the server would mean
  // calling Clerk's auth() in the root layout, which opts all 27 currently-static
  // pages into dynamic rendering for the sake of one <header>.
  const isChromelessRoute =
    pathname.startsWith("/sign-in") ||
    pathname.startsWith("/sign-up") ||
    pathname.startsWith("/no-access");
  if (isChromelessRoute || (isLoaded && !isSignedIn)) return null;

  const tabs = [
    { href: "/generate", icon: Wand2, label: "Generate" },
    // Temporarily hidden (video generation) — re-enable / feature-flag later:
    // { href: "/generate-video", icon: Clapperboard, label: "Video Generation" },
    { href: "/history", icon: Clock, label: "History" },
    // Temporarily hidden (video history) — re-enable / feature-flag later:
    // { href: "/history-video", icon: GalleryVerticalEnd, label: "Video History" },
    { href: "/gallery", icon: Images, label: "Gallery" },
    { href: "/favorites", icon: Heart, label: "Favorites" },
    { href: "/prompts", icon: Library, label: "Prompts" },
    { href: "/enhance", icon: Zap, label: "Enhance" },
  ];

  return (
    // In the macOS shell this header is the window's title bar: data-desktop-drag
    // makes it the drag region (globals.css), and the left padding keeps the
    // first tab clear of the traffic lights, which float over the top-left
    // corner of a frameless window and vanish in full screen.
    <header
      data-desktop-drag
      className="sticky top-0 z-50 w-full border-b bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60"
    >
      <div
        className="flex h-14 w-full items-center justify-between px-4 lg:px-8"
        style={trafficLightInset === null ? undefined : { paddingLeft: trafficLightInset }}
      >
        <nav aria-label="Main" className="flex items-center gap-1">
          {desktop && (
            <span
              aria-hidden
              className="mr-2 hidden select-none items-center gap-2 pr-3 text-sm font-medium tracking-tight text-muted-foreground/90 font-heading md:flex"
            >
              <svg width="18" height="18" viewBox="0 0 32 32" className="shrink-0">
                <defs>
                  <linearGradient id="artsnack-mark" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#f97316" />
                    <stop offset="1" stopColor="#ec4899" />
                  </linearGradient>
                </defs>
                <path
                  d="M8 24 L12 8 L16 18 L20 10 L24 24"
                  stroke="url(#artsnack-mark)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
                <circle cx="24" cy="10" r="2.5" fill="url(#artsnack-mark)" />
              </svg>
              ArtSnack
            </span>
          )}
          {tabs.map((tab) => {
            const isActive = pathname === tab.href;
            const Icon = tab.icon;

            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  "relative flex h-10 w-10 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                  isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                )}
                aria-label={tab.label}
                // Colour is the only other signal that this is the page you
                // are on, and colour alone is not a signal.
                aria-current={isActive ? "page" : undefined}
              >
                <Icon className="h-5 w-5" />
                <PendingHint />
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/search"
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground",
              pathname === "/search" ? "bg-accent text-accent-foreground" : "text-muted-foreground",
            )}
            aria-label="Search"
            aria-current={pathname === "/search" ? "page" : undefined}
          >
            <Search className="h-5 w-5" />
          </Link>
          <Link
            href="/settings"
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground",
              pathname === "/settings"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground",
            )}
            aria-label="Settings"
            aria-current={pathname === "/settings" ? "page" : undefined}
          >
            <Settings className="h-5 w-5" />
          </Link>
          {/* No signed-out branch: the whole header returns null in that
              case, so a "Sign In" button here could never render. */}
          <UserButton
            appearance={{
              elements: {
                avatarBox: "h-8 w-8",
              },
            }}
          />
        </div>
      </div>
    </header>
  );
}

/**
 * A click that has to wait for the server shows it at once.
 *
 * The tabs are static and prefetched, so normally the router already holds the
 * next page and this never appears. It exists for the cold case — a prefetch
 * that has not landed yet, or one dropped by an expired session — where the old
 * page used to sit there looking as if the click had missed. Always rendered and
 * fixed-size, so toggling it moves nothing; the delay keeps a fast navigation
 * from flashing it.
 */
function PendingHint() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-2 bottom-0.5 h-0.5 rounded-full bg-primary transition-opacity",
        pending ? "opacity-100 delay-100 animate-pulse" : "opacity-0 delay-0",
      )}
    />
  );
}
