import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  session,
  shell,
  type BrowserWindowConstructorOptions,
  type DownloadItem,
  type WebContents,
} from "electron";
import { existsSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
  DESKTOP_HANDOFF_PATH,
  DESKTOP_URL_SCHEME,
  parseDesktopSignInDeepLink,
  type DesktopEvent,
  type DesktopState,
} from "../../../packages/shared/desktop-bridge";
import {
  APP_CONFIG,
  APP_URL,
  isAppOrigin,
  isInAppUrl,
  PRODUCT_NAME,
  trafficLightPosition,
  WINDOW_BACKGROUND,
} from "./config";
import { FALLBACK_CSS, fallbackInsetCss, FOREIGN_PAGE_CSS } from "./fallback-css";
import { installMenu } from "./menu";
import { flush, initialBounds, loadState, saveState } from "./state";
import { clampZoom, zoomIn, zoomOut } from "./zoom";

// Not __dirname: Bun's bundler inlines it as the *source* directory at build
// time, so a packaged app would look for these files in the checkout that
// built it. app.getAppPath() is the app.asar (or, in `bun run dev`, this
// package) at run time.
const APP_ROOT = app.getAppPath();
const PRELOAD = join(APP_ROOT, "dist", "preload.js");
const OFFLINE_PAGE = join(APP_ROOT, "static", "offline.html");

app.name = PRODUCT_NAME;
nativeTheme.themeSource = "dark";

// ---------------------------------------------------------------------------
// State the renderer can see.
// ---------------------------------------------------------------------------

/** Per-window bookkeeping that is not worth a class. */
const insetCss = new WeakMap<WebContents, { key: string; zoomFactor: number }>();

function desktopPlatform(): DesktopState["platform"] {
  return process.platform === "win32" || process.platform === "linux" ? process.platform : "darwin";
}

function stateFor(win: BrowserWindow): DesktopState {
  return {
    platform: desktopPlatform(),
    appVersion: app.getVersion(),
    fullScreen: win.isFullScreen(),
    zoomFactor: win.webContents.getZoomFactor(),
  };
}

function pushState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.webContents.send("desktop:state", stateFor(win));
}

function pushEvent(win: BrowserWindow, event: DesktopEvent): void {
  if (win.isDestroyed()) return;
  win.webContents.send("desktop:event", event);
}

// ---------------------------------------------------------------------------
// Zoom. Chromium remembers zoom per origin on its own, but that store is
// opaque and per-session; keeping the factor in our state file means a fresh
// window and a fresh launch both come up at the level the user last chose.
// ---------------------------------------------------------------------------

function applyZoom(win: BrowserWindow, factor: number): void {
  const clamped = clampZoom(factor);
  win.webContents.setZoomFactor(clamped);
  saveState({ zoomFactor: clamped });
  syncTrafficLights(win);
  void syncInsetCss(win);
  pushState(win);
  pushEvent(win, { type: "zoom", zoomFactor: clamped });
}

/** The buttons are native and ignore zoom; re-centre them on the zoomed header. */
function syncTrafficLights(win: BrowserWindow): void {
  if (process.platform !== "darwin" || win.isDestroyed()) return;
  win.setWindowButtonPosition(trafficLightPosition(win.webContents.getZoomFactor()));
}

// ---------------------------------------------------------------------------
// Windows.
// ---------------------------------------------------------------------------

function windowOptions(): BrowserWindowConstructorOptions {
  return {
    title: PRODUCT_NAME,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: WINDOW_BACKGROUND,
    // No title bar; the traffic lights float over the web app's own header,
    // which reserves room for them (see apps/web/components/tab-nav.tsx).
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: trafficLightPosition(loadState().zoomFactor ?? 1) }
      : {}),
    fullscreenable: true,
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  };
}

/**
 * Loads the web app's home page, or, when no web app is configured, the
 * offline page in its setup form explaining what to set.
 */
function loadHome(webContents: WebContents): void {
  if (APP_URL) {
    void webContents.loadURL(APP_URL.toString());
  } else if (!APP_CONFIG.ok && existsSync(OFFLINE_PAGE)) {
    void webContents.loadFile(OFFLINE_PAGE, { query: { setup: APP_CONFIG.problem } });
  }
}

function createWindow(url?: string): BrowserWindow {
  const persisted = loadState();
  const win = new BrowserWindow({ ...windowOptions(), ...initialBounds(persisted.bounds) });
  if (persisted.fullScreen) win.setFullScreen(true);

  wireWindow(win, persisted.zoomFactor ?? 1);
  if (url) void win.loadURL(url);
  else loadHome(win.webContents);
  return win;
}

function wireWindow(win: BrowserWindow, zoomFactor: number): void {
  const { webContents } = win;

  const rememberBounds = () => {
    if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    saveState({ bounds: win.getNormalBounds() });
  };
  win.on("resize", rememberBounds);
  win.on("move", rememberBounds);
  win.on("close", () => {
    rememberBounds();
    saveState({ fullScreen: win.isFullScreen() });
    flush();
  });

  const onFullScreen = () => {
    saveState({ fullScreen: win.isFullScreen() });
    pushState(win);
    void syncInsetCss(win);
  };
  win.on("enter-full-screen", onFullScreen);
  win.on("leave-full-screen", onFullScreen);

  // The zoom factor is per WebContents and resets on some navigations, so it
  // is re-applied whenever a document is ready rather than set once.
  webContents.on("dom-ready", () => {
    const wanted = clampZoom(loadState().zoomFactor ?? zoomFactor);
    if (Math.abs(webContents.getZoomFactor() - wanted) > 1e-3) {
      webContents.setZoomFactor(wanted);
    }
    syncTrafficLights(win);
    void webContents.insertCSS(isAppOrigin(webContents.getURL()) ? FALLBACK_CSS : FOREIGN_PAGE_CSS);
    // A new document starts without the inset sheet whatever we remember.
    insetCss.delete(webContents);
    void syncInsetCss(win);
    pushState(win);
  });

  // ⌘-scroll and pinch land here; the menu path goes through applyZoom.
  webContents.on("zoom-changed", (_event, direction) => {
    applyZoom(
      win,
      direction === "in"
        ? zoomIn(webContents.getZoomFactor())
        : zoomOut(webContents.getZoomFactor()),
    );
  });

  // Anything outside the app and its auth hops goes to the real browser.
  webContents.on("will-navigate", (event, url) => {
    if (isInAppUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  webContents.setWindowOpenHandler(({ url }) => {
    if (isAppOrigin(url)) {
      // A target=_blank link to one of our own pages: another real window,
      // with the same chrome, rather than a bare popup.
      createWindow(url);
      return { action: "deny" };
    }
    if (isInAppUrl(url)) {
      // Clerk's OAuth popups need a real window they can postMessage back from.
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          ...windowOptions(),
          titleBarStyle: "default",
          width: 520,
          height: 720,
          minWidth: 400,
          minHeight: 500,
        },
      };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Network gone, DNS failed, Vercel down: show our own page instead of
  // Chromium's grey error. -3 is ERR_ABORTED, which is just a navigation
  // superseded by another one and not an error at all.
  webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !url.startsWith("http")) return;
    if (!existsSync(OFFLINE_PAGE)) return;
    void win.loadFile(OFFLINE_PAGE, {
      query: { url, code: String(code), description },
    });
  });

  webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    loadHome(webContents);
  });

  webContents.on("page-title-updated", (event) => {
    // The page's <title> is "ArtSnack — AI Art Generator"; the window is
    // simply ArtSnack, like every other Mac app.
    event.preventDefault();
  });
}

/**
 * The fallback inset is a separate stylesheet so it can be added and removed
 * as the window enters and leaves full screen, where the traffic lights hide,
 * and replaced when the zoom changes, since its width depends on it.
 */
async function syncInsetCss(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  const { webContents } = win;
  const existing = insetCss.get(webContents);
  const zoomFactor = webContents.getZoomFactor();
  const wanted =
    process.platform === "darwin" && !win.isFullScreen() && isAppOrigin(webContents.getURL());
  if (existing && (!wanted || Math.abs(existing.zoomFactor - zoomFactor) > 1e-3)) {
    insetCss.delete(webContents);
    try {
      await webContents.removeInsertedCSS(existing.key);
    } catch {
      // The document went away mid-call; nothing to remove.
    }
  }
  if (wanted && !insetCss.has(webContents)) {
    try {
      const key = await webContents.insertCSS(fallbackInsetCss(zoomFactor));
      insetCss.set(webContents, { key, zoomFactor });
    } catch {
      // Same: the next dom-ready tries again.
    }
  }
}

// ---------------------------------------------------------------------------
// Downloads go straight to ~/Downloads like a browser would, with the dock
// bounce macOS gives every finished download, and a toast in the page.
// ---------------------------------------------------------------------------

function uniqueDownloadPath(dir: string, filename: string): string {
  const ext = extname(filename);
  const stem = basename(filename, ext);
  let candidate = join(dir, filename);
  for (let n = 2; existsSync(candidate); n += 1) {
    candidate = join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

function wireDownloads(): void {
  session.defaultSession.on("will-download", (_event, item: DownloadItem, contents) => {
    const savePath = uniqueDownloadPath(app.getPath("downloads"), item.getFilename());
    item.setSavePath(savePath);
    item.once("done", (_doneEvent, state) => {
      if (state === "completed" && process.platform === "darwin") {
        app.dock?.downloadFinished(savePath);
      }
      const win = BrowserWindow.fromWebContents(contents);
      if (win) {
        pushEvent(win, { type: "download", filename: basename(savePath), state });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// User agent. Google refuses OAuth sign-in from anything that announces itself
// as an embedded browser, and "Electron/44" counts. Chromium's own UA with the
// two extra tokens removed is what every Electron app that signs in with
// Google ships.
// ---------------------------------------------------------------------------

function wireUserAgent(): void {
  const ua = session.defaultSession
    .getUserAgent()
    .replace(/ ?Electron\/\S+/, "")
    .replace(new RegExp(` ?${PRODUCT_NAME}\\/\\S+`, "i"), "")
    .replace(/ ?artsnack-desktop\/\S+/i, "");
  session.defaultSession.setUserAgent(ua);
}

// ---------------------------------------------------------------------------
// IPC.
// ---------------------------------------------------------------------------

function wireIpc(): void {
  ipcMain.on("desktop:state", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    event.returnValue = win
      ? stateFor(win)
      : ({
          platform: desktopPlatform(),
          appVersion: app.getVersion(),
          fullScreen: false,
          zoomFactor: 1,
        } satisfies DesktopState);
  });
  ipcMain.on("desktop:open-app", (event) => {
    // Only the offline page asks for this, and only ever back to the app.
    loadHome(event.sender);
  });
  ipcMain.on("desktop:sign-in-with-browser", () => {
    // A fixed URL, never one the page supplies.
    if (APP_URL) void shell.openExternal(new URL(DESKTOP_HANDOFF_PATH, APP_URL).toString());
  });
}

// ---------------------------------------------------------------------------
// Deep links. The browser finishes Google sign-in and lands on
// /desktop/handoff, which sends it to artsnack://sign-in?ticket=…; macOS
// routes that here. The ticket is single-use and expires in minutes, and
// it only ever becomes a query parameter on our own sign-in page.
// ---------------------------------------------------------------------------

let pendingDeepLink: string | null =
  process.argv.find((arg) => arg.startsWith(`${DESKTOP_URL_SCHEME}://`)) ?? null;

function handleDeepLink(raw: string): void {
  const parsed = parseDesktopSignInDeepLink(raw);
  if (!parsed || !APP_URL) return;
  const target = new URL("/sign-in", APP_URL);
  target.searchParams.set("__clerk_ticket", parsed.ticket);

  const win =
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? createWindow(target.toString());
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
  if (win.webContents.getURL() !== target.toString()) {
    void win.webContents.loadURL(target.toString());
  }
}

function wireDeepLinks(): void {
  // In development the scheme points at the Electron binary plus this script,
  // so the registration needs the script path as an argument.
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(DESKTOP_URL_SCHEME);
  } else if (process.argv[1]) {
    app.setAsDefaultProtocolClient(DESKTOP_URL_SCHEME, process.execPath, [
      resolve(process.argv[1]),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // macOS delivers URL opens here, possibly before `ready` on a cold launch.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (app.isReady() && BrowserWindow.getAllWindows().length > 0) handleDeepLink(url);
    else pendingDeepLink = url;
  });

  app.on("second-instance", (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith(`${DESKTOP_URL_SCHEME}://`));
    if (link) {
      handleDeepLink(link);
      return;
    }
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    app.setAboutPanelOptions({
      applicationName: PRODUCT_NAME,
      applicationVersion: app.getVersion(),
      ...(APP_URL
        ? { website: APP_URL.toString(), credits: `A desktop shell for ${APP_URL.hostname}.` }
        : {}),
    });
    wireUserAgent();
    wireDownloads();
    wireIpc();
    wireDeepLinks();
    installMenu({
      newWindow: () => createWindow(),
      zoomIn: (win) => applyZoom(win, zoomIn(win.webContents.getZoomFactor())),
      zoomOut: (win) => applyZoom(win, zoomOut(win.webContents.getZoomFactor())),
      zoomReset: (win) => applyZoom(win, 1),
      goHome: (win) => loadHome(win.webContents),
    });
    createWindow();
    if (pendingDeepLink) {
      const link = pendingDeepLink;
      pendingDeepLink = null;
      handleDeepLink(link);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    // macOS convention: the app stays in the dock until ⌘Q.
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", flush);
}
