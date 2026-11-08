import type { NextConfig } from "next";

/**
 * Headers applied to everything.
 *
 * `X-Robots-Tag` is the belt to app/robots.ts's braces: robots.txt is a request
 * not to crawl, this is an instruction not to index whatever was crawled anyway.
 * `nosniff` matters more than it looks — /api/images serves bytes whose
 * Content-Type originally arrived on a client upload, and without it a browser
 * is free to sniff HTML out of something labelled as an image.
 *
 * No CSP here: the obvious policy omits *.convex.site and Clerk's frame and
 * worker origins and would break sign-in. There is also no injection sink in
 * the app (no dangerouslySetInnerHTML anywhere), so the honest order is nosniff
 * first and CSP later in Report-Only, if it is ever wanted.
 *
 * No HSTS either — Vercel already sends `max-age=63072000`, and adding a
 * shorter one would only weaken it.
 */
const SECURITY_HEADERS = [
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet, noimageindex" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  experimental: {
    // How long a prefetched page stays usable in the client router. Every tab is
    // a static shell — all of its data comes from Convex — so a prefetched copy
    // cannot go stale within a deployment, and the default five minutes only
    // meant that the first click after a coffee break went back through the
    // Clerk proxy before anything moved. A new deployment still forces a fresh
    // load on the next server request, so this never pins old code.
    staleTimes: { static: 86_400 },
  },
  // Nothing here is a public product; the header is noise that only helps a
  // scanner fingerprint the stack.
  poweredByHeader: false,
  // typedRoutes stays OFF. It is stable and it did catch one loose `string`
  // href (now typed properly in lib/reference-handoff.ts), but Clerk's auth
  // pages are optional catch-alls — `/sign-in/[[...sign-in]]` — and Next only
  // generates `/sign-in/${slug}` for those, so the five plain `<Link
  // href="/sign-in">` in the app are all reported as "not an existing route".
  // They resolve fine at runtime. Silencing them needs `as Route`, whose type
  // only exists after a build has written .next/types, which would in turn make
  // `bun run typecheck` fail on a fresh clone. Not worth that trade.
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // The media cache worker must be re-checked on every load, or a fix to it
      // waits out whatever the browser decided to cache.
      { source: "/media-cache-sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
  // `/media/*` is the media CDN (NEXT_PUBLIC_MEDIA_URL) under our own origin. The local media cache
  // (public/media-cache-sw.js) downloads through it because the CDN sends no
  // CORS headers, and a cross-origin response the worker cannot read cannot be
  // cached or sliced into ranges. It proxies only that host and only public
  // objects, so proxy.ts leaves it unauthenticated.
  async rewrites() {
    const media = process.env.NEXT_PUBLIC_MEDIA_URL;
    return media ? [{ source: "/media/:path*", destination: `${media}/:path*` }] : [];
  },
};

export default nextConfig;
