/**
 * The contract between the Electron shell (apps/desktop) and the web app.
 *
 * The shell's preload script exposes an object of this shape on
 * `window.artsnackDesktop`; the web app reads it through `useDesktop()` in
 * apps/web/hooks/use-desktop.ts. Nothing else crosses the bridge, and every
 * member is data or a subscription — the renderer never gets a Node handle.
 *
 * Kept here rather than in either app so the two sides type-check against one
 * definition. It is types only; nothing in it runs.
 */

export type DesktopPlatform = "darwin" | "win32" | "linux";

export interface DesktopState {
  platform: DesktopPlatform;
  /** The shell's own version, from apps/desktop/package.json. */
  appVersion: string;
  /**
   * True while the window is in native full screen. On macOS the traffic
   * lights disappear in that mode, so the header's left inset goes with them.
   */
  fullScreen: boolean;
  /** Chromium zoom factor, 1 is 100%. Driven by the View menu in the shell. */
  zoomFactor: number;
}

export type DesktopEvent =
  | { type: "zoom"; zoomFactor: number }
  | {
      type: "download";
      filename: string;
      state: "completed" | "cancelled" | "interrupted";
    };

export interface DesktopBridge {
  getState(): DesktopState;
  /** Fires with the full state after any field changes. Returns unsubscribe. */
  subscribe(listener: (state: DesktopState) => void): () => void;
  /** One-shot notifications the web app may surface as toasts. */
  onEvent(listener: (event: DesktopEvent) => void): () => void;
  /** Navigate the window back to the app. Used by the shell's offline page. */
  openApp(): void;
  /**
   * Start sign-in in the system browser. Google refuses OAuth inside any
   * embedded browser, so the shell opens `/desktop/handoff` in the default
   * browser; that page mints a single-use Clerk sign-in token and hands it
   * back through the `artsnack://` URL scheme the shell registers.
   */
  signInWithBrowser(): void;
}

/** The custom URL scheme the shell owns. */
export const DESKTOP_URL_SCHEME = "artsnack";

/** Path, under the app origin, that the shell opens in the system browser. */
export const DESKTOP_HANDOFF_PATH = "/desktop/handoff";

/**
 * Builds the deep link the handoff page sends the browser to. The shell
 * turns it into `/sign-in?__clerk_ticket=<token>`, which Clerk's <SignIn>
 * completes on its own.
 */
export function desktopSignInDeepLink(ticket: string): string {
  return `${DESKTOP_URL_SCHEME}://sign-in?ticket=${encodeURIComponent(ticket)}`;
}

/** Inverse of desktopSignInDeepLink; null for anything else. */
export function parseDesktopSignInDeepLink(raw: string): { ticket: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${DESKTOP_URL_SCHEME}:`) return null;
  // `artsnack://sign-in` parses with "sign-in" as host; a `artsnack:///sign-in`
  // variant would put it in the path. Accept both.
  const route = url.host || url.pathname.replace(/^\/+/, "");
  if (route !== "sign-in") return null;
  const ticket = url.searchParams.get("ticket")?.trim();
  return ticket ? { ticket } : null;
}

/**
 * The native macOS app (apps/macos) signs in through the same handoff page, but
 * it is a separate client with a separate URL scheme: `artsnack://` belongs to
 * the Electron shell, and a link meant for one must never be opened by the
 * other while both are installed.
 *
 * The native app opens `/desktop/handoff?client=native&state=<random>` and
 * accepts the returning link only if `state` is the value it sent, so a page
 * that tricks the browser into opening `artsnack-native://` cannot plant its
 * own ticket. The app then redeems the ticket through Clerk's Frontend API
 * itself; there is no clerk-js on the native side.
 */
export const NATIVE_URL_SCHEME = "artsnack-native";

/** What `state` may look like: URL-safe, long enough to be unguessable. */
const NATIVE_STATE = /^[A-Za-z0-9_-]{16,128}$/;

/** The handoff path the native app opens in the system browser. */
export function nativeHandoffPath(state: string): string {
  return `${DESKTOP_HANDOFF_PATH}?client=native&state=${encodeURIComponent(state)}`;
}

/**
 * Reads a native-app request from the handoff page's search params; null for
 * the Electron shell's plain request or for anything malformed.
 */
export function parseNativeHandoffRequest(
  searchParams: Record<string, string | string[] | undefined>,
): { state: string } | null {
  if (searchParams.client !== "native") return null;
  const state = searchParams.state;
  return typeof state === "string" && NATIVE_STATE.test(state) ? { state } : null;
}

/** The deep link the handoff page sends the browser to for the native app. */
export function nativeSignInDeepLink(ticket: string, state: string): string {
  return `${NATIVE_URL_SCHEME}://sign-in?ticket=${encodeURIComponent(ticket)}&state=${encodeURIComponent(state)}`;
}
