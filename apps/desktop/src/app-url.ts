/**
 * Which web app the shell loads, and which hosts may load inside its window.
 * Pure functions with no Electron import, so they can be tested directly.
 *
 * Nothing is built in. The URL comes from, first match wins:
 *   1. a `--url=` argument;
 *   2. the `ARTSNACK_DESKTOP_URL` environment variable when the app starts;
 *   3. the URL baked into a packaged build (`ARTSNACK_DESKTOP_URL` set when
 *      running `bun run dist`, see scripts/package.ts), since an app started
 *      from the Dock or Finder gets no shell environment.
 */

export type AppUrlConfig = { ok: true; url: URL } | { ok: false; problem: string };

export interface AppUrlSources {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** The URL a packaged build was made for, if any. */
  packaged?: string | null;
}

export function resolveAppUrl({ argv, env, packaged }: AppUrlSources): AppUrlConfig {
  const fromArg = argv.find((a) => a.startsWith("--url="))?.slice("--url=".length);
  const candidates: Array<[source: string, value: string | null | undefined]> = [
    ["--url", fromArg],
    ["ARTSNACK_DESKTOP_URL", env.ARTSNACK_DESKTOP_URL],
    ["The packaged build's URL", packaged],
  ];
  const found = candidates.find(([, value]) => value?.trim());
  if (!found) {
    return {
      ok: false,
      problem:
        "No web app is configured. Set ARTSNACK_DESKTOP_URL (or pass --url=) to the address of your ArtSnack web app, or package the app with ARTSNACK_DESKTOP_URL set.",
    };
  }
  const [source, value] = found;
  const raw = (value ?? "").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: `${source} is not a valid URL: ${raw}` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, problem: `${source} must be an http(s) URL: ${raw}` };
  }
  return { ok: true, url };
}

/**
 * Hosts that may load inside the window; everything else opens in the default
 * browser. Clerk's sign-in hops through its Frontend API, and an OAuth provider
 * needs its own page, so those are here alongside the app.
 *
 * The app's own host and its subdomains count as in-app. A Clerk production
 * instance configured on the app's domain serves its Frontend API and Account
 * Portal from subdomains of it (`clerk.<app host>`, `accounts.<app host>`). If
 * your Clerk instance lives on a different domain, its pages open in the browser.
 * The parent domain is deliberately not trusted: for a host like
 * `artsnack.co.uk` that would let every `.co.uk` site into the window.
 */
export function inAppHostSuffixes(appUrl: URL | null): string[] {
  const own: string[] = [];
  if (appUrl) {
    own.push(appUrl.hostname);
    const isAddress =
      appUrl.hostname === "localhost" ||
      /^[\d.]+$/.test(appUrl.hostname) ||
      appUrl.hostname.includes(":");
    if (!isAddress) own.push(`.${appUrl.hostname}`);
  }
  return [
    ...own,
    // Clerk development instances and Clerk itself.
    ".clerk.accounts.dev",
    "clerk.com",
    ".clerk.com",
    "accounts.google.com",
    "appleid.apple.com",
    "github.com",
  ];
}

/**
 * A host is in the list when it equals an entry, or when the entry starts with a
 * dot and the host ends with it. An entry without a leading dot matches only
 * itself, so `clerk.com` does not let in `evilclerk.com`.
 */
export function hostMatches(hostname: string, suffixes: readonly string[]): boolean {
  return suffixes.some(
    (suffix) => hostname === suffix || (suffix.startsWith(".") && hostname.endsWith(suffix)),
  );
}
