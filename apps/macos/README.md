# ArtSnack Native (macOS)

A native client for ArtSnack in Rust on [GPUI](https://gpui.rs) and
[GPUI Kit](https://gpui-kit.com). It talks to the same Convex backend as the web
and iOS apps and reads media straight from the media CDN; there is no web view.

## Configuration

Nothing is built in: the app needs four endpoints of your own deployment. Each
is read from the first place that has it:

1. an environment variable when the app starts;
2. `config.json` in the app's Application Support folder
   (`~/Library/Application Support/ArtSnack Native/config.json`);
3. the same environment variable at compile time (`cargo build`,
   `script/install.sh`), baked in as the build's default.

| Variable                      | `config.json` key  | What                                                                  | Example                                |
| ----------------------------- | ------------------ | --------------------------------------------------------------------- | -------------------------------------- |
| `ARTSNACK_CONVEX_URL`         | `convexUrl`        | The Convex deployment                                                 | `https://your-deployment.convex.cloud` |
| `ARTSNACK_CLERK_FRONTEND_API` | `clerkFrontendApi` | The Clerk instance's Frontend API                                     | `https://clerk.example.com`            |
| `ARTSNACK_WEB_ORIGIN`         | `webOrigin`        | The web app: hosts the sign-in handoff, "Open in Browser", "Copy URL" | `https://artsnack.example.com`         |
| `ARTSNACK_MEDIA_ORIGIN`       | `mediaOrigin`      | The media CDN (Cloudflare image and media transformations under it)   | `https://media.example.com`            |

```json
{
  "convexUrl": "https://your-deployment.convex.cloud",
  "clerkFrontendApi": "https://clerk.example.com",
  "webOrigin": "https://artsnack.example.com",
  "mediaOrigin": "https://media.example.com"
}
```

`ARTSNACK_ENV=dev` switches to the development profile: the same variables
with a `_DEV` suffix (`ARTSNACK_CONVEX_URL_DEV`, …) and the keys under a
`"dev"` object in `config.json`. Development never falls back to the
production Convex deployment or Clerk instance; its web app defaults to a
local `bun run dev` (`http://localhost:4000`) and its media CDN to the
production one.

When an endpoint is missing or is not an http(s) URL, or `config.json` does
not parse, the app opens a setup window listing what to set and starts nothing
else: no backend is called.

Other knobs:

| Variable             | When          | What                                                                                                            |
| -------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| `ARTSNACK_ENV`       | at launch     | `dev` (or `development`) selects the development profile                                                        |
| `ARTSNACK_LOG`       | at launch     | A `tracing` filter, e.g. `debug`; default `warn,artsnack=info`                                                  |
| `ARTSNACK_BUNDLE_ID` | at build time | The bundle id `script/install.sh` writes into Info.plist and the binary reports; default `com.example.artsnack` |
| `BUN`                | at build time | The Bun binary the `rules` crate bundles the shared TypeScript with; default `bun` on `PATH`                    |

## Build and install

On the Mac, with Bun installed and `bun install` run at the repo root (the
`rules` crate bundles `packages/shared` with it during the build):

```sh
apps/macos/script/install.sh     # release build, signed .app, /Applications, launch
cargo run -p artsnack            # debug run from apps/macos (no URL scheme: sign-in links need the .app)
```

An app started from the Finder or the Dock gets no shell environment, so give
an installed app its endpoints through `config.json`, or bake them in by
exporting the variables before running `script/install.sh`.

Before the first sign-in works:

- the web app must include the native handoff (`/desktop/handoff?client=native`),
  i.e. be deployed from a commit that has it;
- "Native API" must be enabled for the Clerk instance (Clerk dashboard →
  Native applications), or sign-in fails with `native_api_disabled`.

## Layout

| Crate             | What                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`             | The shell: configuration and the setup window, windows (with saved place and size), menus, key bindings, the title bar and tabs, window zoom, routing between screens |
| `session`         | Clerk Frontend API in native mode, the browser handoff, Keychain, the Convex token                                                                                    |
| `backend`         | The Convex client: live and paginated queries, mutations, actions; `api/` declares every function used, typed                                                         |
| `rules`           | The web's shared TypeScript in QuickJS: small rules on the UI thread (`js/entry.ts`), the API composer and the Atlas catalogue on a worker thread (`js/composer.ts`)  |
| `media`           | CDN URLs, the disk cache, visible-first image loading with a memory budget, uploads, downloads to ~/Downloads                                                         |
| `ui`              | App components: pane zoom, the justified and masonry grids, tiles, the lightbox, the split pane, clip playback in grids and the viewer                                |
| `video`           | The AVFoundation player (macOS): decodes a clip into frames GPUI draws; no GPUI dependency, so it checks on Linux with `--target aarch64-apple-darwin`                |
| `generate`        | The Generate screen (Self-hosted image composer and its results) and Enhance                                                                                          |
| `api_tab`         | Generate's API tab: the composer (Grok, fal, Higgsfield, Atlas), its results, Image → Prompt, Prompt Studio                                                           |
| `video_tab`       | Generate's Self-hosted video tab: MiniMax H3 and LTX 2.3 on the video pods                                                                                            |
| `library`         | Favorites, Gallery, History, the reference picker                                                                                                                     |
| `search`          | Search: the whole history searched on the device (`search.ts` ported to Rust)                                                                                         |
| `prompts`         | Prompts and Enhance recipes, plus the Save/Saved and Enhance buttons beside every prompt                                                                              |
| `pods`            | RunPod and Vast: the backend manager, the launch dialog                                                                                                               |
| `settings_screen` | Settings                                                                                                                                                              |
| `settings`        | Device-local preferences (the native `localStorage`)                                                                                                                  |
| `runtime`         | The Tokio runtime network clients use, bridged into GPUI tasks                                                                                                        |

Pinned to `gpui-kit =0.8.0` on its default `gpui-pre` core; upgrade them together.
