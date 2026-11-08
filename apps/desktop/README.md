# ArtSnack for macOS

An Electron shell around the web app. It loads your deployed web app — nothing
of the Next app is bundled — so it is always on the current deploy and needs
no secrets of its own. Sign-in is the ordinary Clerk flow; the session lives
in the app's own cookie jar, separate from the browser's.

What the shell adds over a browser tab:

- A frameless window. macOS's traffic lights sit inside the app's own
  header, which reserves room for them and is the drag region. In native
  full screen (green button, or `⌃⌘F`) the inset goes away with them.
- Browser-style zoom on `⌘+` / `⌘−` / `⌘0`, walking Chrome's presets, kept
  across launches, and announced with a toast in the page.
- Window size and position remembered between launches.
- Downloads saved straight to `~/Downloads` with the dock bounce.
- Links that leave the app open in the default browser; Clerk's OAuth popups
  stay in the app.
- An offline page with a retry, instead of Chromium's grey error.

## Configuration

The shell has no built-in address. It needs the URL of the web app it wraps:

| Setting                   | When           | What                                                                                                                                                                                 |
| ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--url=<url>`             | at launch      | The web app to load. Wins over everything else.                                                                                                                                      |
| `ARTSNACK_DESKTOP_URL`    | at launch      | The web app to load, e.g. `https://artsnack.example.com`.                                                                                                                            |
| `ARTSNACK_DESKTOP_URL`    | when packaging | Baked into the packaged app (as `artsnackDesktopUrl` in its `package.json`), so it works when started from the Dock or Finder, which pass no shell environment. Launch settings win. |
| `ARTSNACK_DESKTOP_APP_ID` | when packaging | The bundle id. Defaults to the placeholder `com.example.artsnack.desktop` in `electron-builder.yml`.                                                                                 |

Without a URL the window shows a setup page saying what to set, and loads
nothing else.

The window keeps the app's own host and its subdomains in the app — for
`https://artsnack.example.com` that is `artsnack.example.com` and anything under
it, such as `clerk.artsnack.example.com` and `accounts.artsnack.example.com`
where a Clerk production instance on that domain serves its Frontend API and
Account Portal — plus Clerk's own domains and the Google, Apple and GitHub
sign-in pages. Every other link opens in the default browser, including a Clerk
instance configured on a different domain.

## Build and install

```
export ARTSNACK_DESKTOP_URL=https://artsnack.example.com
bun run desktop:install        # from the repo root: compile, package, copy to /Applications, launch
bun run desktop:dist           # just the .dmg and .app under apps/desktop/release/
bun run desktop:dev            # run against $ARTSNACK_DESKTOP_URL without packaging
ARTSNACK_DESKTOP_URL=http://localhost:4000 bun run desktop:dev   # against a local `bun run dev`
```

`desktop:install` replaces an existing `/Applications/ArtSnack.app` only when
it has the same bundle id as the new build.

Signing uses the "Developer ID Application" identity in the login keychain
when there is one and an ad-hoc signature otherwise. Nothing is notarised:
a locally built app carries no quarantine flag, so Gatekeeper never asks.

**Electron's binary is a postinstall download.** Bun runs lifecycle scripts
only for packages in the root `trustedDependencies`, which is why `electron`
is listed there. If `apps/desktop/node_modules/electron/dist` is ever empty
(the symptom is "Electron failed to install correctly"), run
`bun pm trust electron` or `node apps/desktop/node_modules/electron/install.js`.

## How the web app knows

The preload script exposes `window.artsnackDesktop`, typed by
`packages/shared/desktop-bridge.ts`. `apps/web/hooks/use-desktop.ts` reads it
and `components/desktop-chrome.tsx` tags `<html data-desktop>` so the CSS in
`globals.css` can apply the drag region and the traffic-light inset. Should
the deployed web app predate that, `src/fallback-css.ts` injects an equivalent
from the shell side, so an old deploy is still draggable and correctly inset.

## Linux build

Install the desktop workspace with `bun install --frozen-lockfile --filter @artsnack/desktop`
from the repository root, then run `bun run --cwd apps/desktop pack:linux`
(with `ARTSNACK_DESKTOP_URL` set, as above). This produces `release/linux-unpacked`.
The Linux window uses the standard title bar; both cold-start and running-instance
`artsnack://` sign-in links are accepted. macOS packaging commands stay unchanged.

To install it, copy `release/linux-unpacked` somewhere permanent, add a launcher
that starts its `artsnack` executable without `ELECTRON_RUN_AS_NODE` in the
environment, and a desktop entry (`~/.local/share/applications/<app id>.desktop`)
whose `MimeType` includes `x-scheme-handler/artsnack` so sign-in links reach the
app. The installed copy does not change when the repository is rebuilt.
