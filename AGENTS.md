<!-- BEGIN:nextjs-agent-rules -->

# Next.js: ALWAYS read docs before coding

Before any Next.js work, find and read the relevant doc in `node_modules/next/dist/docs/`. Your training data is outdated — the docs are the source of truth.

<!-- END:nextjs-agent-rules -->

# Package manager: Bun, never npm

Use `bun` for installs, scripts and binaries (`bunx`). Never `npm` or `npx` — npm's
lifecycle-script policy silently skips postinstall steps some of our tooling needs.

# Layout: a Bun workspace, three packages

```
apps/web/            the Next app — app/ components/ hooks/ proxy.ts, and the
                     lib/ helpers that only it can run: b2, comfyui-url,
                     backends/, upload-to-backend, catalog-cache, fetch-image,
                     utils, copy-text, download-media
packages/backend/    convex/ — schema, functions, _generated
packages/shared/     everything portable: the model registry, pricing, form
                     normalisation, provider payloads, and all 16 test suites
infra/               provision.sh — what a RunPod pod runs at boot; and
                     facefix-smoke.ts, which runs Face Fix against a live pod
```

**`infra/provision.sh` is a copy, not the original.** The RunPod template's docker
command curls the script from a URL you host (a secret gist works well) at
container start, so editing the file here changes nothing until it is published
there, for example:

```
gh gist edit <your-gist-id> -f provision.sh infra/provision.sh
```

It is in the repo because `packages/shared/enhance-workflows.ts` names the Face
Fix detector files by path — dropping one from that manifest is a Face Fix that
fails on the next cold pod and passes every test here.

`packages/shared` is not new in spirit — `convex/` already imported fourteen
modules out of the old `lib/` before it had a name. Convex reaches it by relative
path (`../../shared/x`), the web app through `@/lib/*`, which resolves in **two**
places: `apps/web/lib/` first, then `packages/shared/`. That is why ~120 web
imports survived the move untouched. The same two-entry mapping is repeated in
three tsconfigs — root, `apps/web`, and `packages/backend/convex` — because each
tool reads a different one.

Nothing in `packages/shared` may import from `apps/web`. It is the one rule the
layout exists to enforce, and the iOS app is why.

Run everything from the repo root: `bun run typecheck`, `bun test`,
`bunx oxlint`, `bunx oxfmt --check` all still cover the whole workspace, and CI
is unchanged. `bun run dev` and `bun run build` delegate into `apps/web`;
`bun run convex:dev` and `convex:deploy` into `packages/backend`.

`.env.local` now lives per package: `apps/web/.env.local` for Next, and
`packages/backend/.env.local` with just `CONVEX_DEPLOYMENT` for the Convex CLI.

**Vercel's Root Directory must be `apps/web`.** It is a dashboard setting, not a
file, so a deploy from before it is changed will fail to find a Next app.

**Root Directory does not narrow the install.** It decides where the build
command runs; `bun install` is still workspace-wide, so a bare install drags
apps/native's Expo and React Native tree onto the web build machine. That is the
whole story of the build bill: the flat repo installed 606 packages in 142ms,
and the first workspace deploy installed 1211 in 155–275s, while `next build`
itself never moved off ~18s. Install was 82% of a three-minute build.

`apps/web/vercel.json` therefore carries two settings, and it is strict JSON —
Vercel rejects comments in it, which is why this reasoning lives here:

- `installCommand` filters to `@artsnack/web` plus `artsnack` (the root package).
  Both filters are needed: `@artsnack/web` alone drops the root devDependencies,
  and `next build` runs `tsc`, so it dies on "Failed to install required
  TypeScript dependencies". Together they install 884 packages instead of 2102,
  and no react-native at all.
- `ignoreCommand` skips the deploy when a commit touched nothing under
  `apps/web`, `packages/`, `bun.lock` or the root `package.json` — an iOS-only
  commit no longer redeploys the web app. Exit 0 skips, nonzero builds. The
  pathspecs are `:/`-prefixed because Vercel runs this from `apps/web`, and the
  `git rev-parse` guard makes a parentless commit build rather than skip.
  `bun.lock` is in the list on purpose: web and native share dependencies, so a
  native-only lockfile change can still move a version the web bundle resolves.
  `patches/` is there for the same reason: a patched dependency is part of the
  web bundle (see "Next is patched" below).

# Desktop: an Electron shell in apps/desktop

`apps/desktop` is a fourth workspace package: a frameless macOS window that loads
the deployed web app from `ARTSNACK_DESKTOP_URL` (there is no built-in default) —
nothing of the Next app is bundled, so it is always on the current deploy and
carries no secrets. `bun run desktop:install` builds, signs with the Developer ID
in the login keychain, copies to /Applications and launches;
`ARTSNACK_DESKTOP_URL=http://localhost:4000 bun run desktop:dev` runs it against a
local dev server. See `apps/desktop/README.md`.

Three things about it are not obvious from the code:

- **Google sign-in cannot happen inside the window.** Google refuses OAuth from any
  embedded browser and detects Electron even with the `Electron/` token stripped
  from the user agent. So on desktop the sign-in page offers "Continue in browser":
  the shell opens `/desktop/handoff` in the default browser, that page (behind the
  normal Clerk + allowlist gate in proxy.ts) mints a single-use, two-minute Clerk
  sign-in token and sends the browser to `artsnack://sign-in?ticket=…`, and the
  shell turns that into `/sign-in?__clerk_ticket=…`, which Clerk's `<SignIn>`
  completes. The contract for both sides is `packages/shared/desktop-bridge.ts`.
- **The web app is what makes the window draggable.** There is no title bar; the
  header is the drag region and reserves room for the traffic lights only when
  `window.artsnackDesktop` is present (`hooks/use-desktop.ts`,
  `components/desktop-chrome.tsx`, the `html[data-desktop]` rules in globals.css).
  The shell injects an equivalent from its side for a deploy that predates this,
  so an old web build is still draggable.
- **`ELECTRON_RUN_AS_NODE=1` in the environment makes the app exit silently.**
  Any terminal inside an Electron-based tool (Claude Code, Cursor, VS Code) has it
  set, `open -a` passes it on, and the app starts as bare Node with no window and
  no log line. The install script strips it; do the same before any manual `open`.

Electron's binary is a postinstall download, and Bun only runs those for packages in
the root `trustedDependencies`, which is why `electron` is listed there. CI sets
`ELECTRON_SKIP_BINARY_DOWNLOAD=1` because nothing there launches it.

# Native macOS app: apps/macos (Rust, GPUI)

A native client being built to replace the Electron shell; the crate map and its
configuration (`ARTSNACK_CONVEX_URL`, `ARTSNACK_CLERK_FRONTEND_API`,
`ARTSNACK_WEB_ORIGIN`, `ARTSNACK_MEDIA_ORIGIN`, or a `config.json`) are in
`apps/macos/README.md`. It is a Cargo workspace inside the Bun one —
Bun ignores it (no package.json), and the web's CI does not build it.

- **GPUI Kit is pinned exactly** (`gpui-kit = "=0.8.0"`, which pins `gpui-pre`).
  Upgrade them as one; read the installed `gpui-kit` skill's Coding Guides
  first, and grep the real source in `~/.cargo/registry` before using any
  GPUI or GPUI Kit method — the API moves every release.
- **No Next.js routes.** Everything goes through Convex (the iOS app's paths:
  `podCatalog.catalog`, `enhanceProcessor.enhance`, uploads via
  `grokGenerations.generateRefUploadUrl`), media straight from the media CDN.
  Each Convex function the app calls is declared, typed, in
  `crates/backend/src/api/`; there are no `returns:` validators, so result
  shapes are copied from the function source — change a return shape there and
  the native app's declaration must follow.
- **Shared TypeScript runs in QuickJS** (`crates/rules`): its build script
  bundles `crates/rules/js/entry.ts` and `js/composer.ts` with `bun build`, so
  building the app needs Bun and `bun install` at the repo root. Add a
  `packages/shared` module to an entry instead of porting its logic to Rust.
  `entry.ts` loads on the UI thread at startup, so it carries only small
  modules; `composer.ts` (the API composer's rules, which need the 30k-line
  Atlas catalogue) runs on its own thread and is called asynchronously. Pure
  logic a native screen needs from the web app belongs in `packages/shared` —
  moving a file there keeps every `@/lib/*` import working. One exception
  today: `js/api-results.ts` imports `apps/web/components/api/generation-meta.ts`
  directly (its `Doc` import is type-only), so a change there reaches the
  native API results grid too.
  The native app does no client-side search through QuickJS: `crates/search`
  is a Rust port of `packages/shared/search.ts` with its tests, because a scan of
  the whole history on every keystroke is too slow in an interpreter — change
  one, change both.
- **Sign-in uses its own URL scheme**, `artsnack-native://`, so it never
  collides with the Electron shell's `artsnack://`. The handoff page answers it
  for `?client=native&state=…` (`packages/shared/desktop-bridge.ts`); the web
  must be deployed with that change, and Clerk's "Native API" must be enabled,
  before native sign-in works.
- **Zoom has three kinds**: Cmd +/−/0 scales the window
  (theme base font = rem), the left pane's −/%/+ scales the form
  (`artsnack_ui::pane_zoom`), the right pane's −/%/+ sets tile size. Use rem
  helpers everywhere so all three keep working.
- **Video is AVFoundation, macOS only.** `crates/video` wraps `AVPlayer` →
  `AVPlayerItemVideoOutput` → `CVPixelBuffer` (420f, the one format GPUI's
  Metal renderer accepts) and has no GPUI dependency, so its Mac code can be
  checked anywhere: `rustup target add aarch64-apple-darwin`, then
  `cargo clippy -p artsnack-video --target aarch64-apple-darwin`. The GPUI side
  (`crates/ui/src/video.rs`: `surface()`, the grid's `ClipPlayers`, the
  viewer's `ClipViewer`) compiles its macOS branch only on a Mac. Elsewhere no
  player is made and posters stay up. Grid clips are muted; nothing starts
  sound by itself.
- **Agents build, lint and run unit tests** (`cargo check`, `cargo clippy`,
  `cargo fmt`, `cargo test` from `apps/macos`), but do not launch the app
  until told to.

# Architecture: where each layer lives

App on **Vercel**; media in **Backblaze B2**, served through a media CDN on your own
domain (`NEXT_PUBLIC_MEDIA_URL` / `MEDIA_BASE_URL`; a Cloudflare proxy with
`cdn-cgi/image` previews; `/api/images` and `/api/videos` re-serve the same objects
same-origin, gated by a prefix allowlist). Auth is **Clerk**; database and provider
actions are **Convex**. Self-hosted generation uses ComfyUI. A legacy RunPod URL
remains the fallback; the UI can also rent a disposable-disk Vast.ai instance, which
becomes active only after Convex verifies its `/system_stats` through Cloudflare
Access. Every variable is listed in `apps/web/.env.example` and
`packages/backend/.env.example`.

**Pushing to main deploys the frontend only.** Convex functions and schema need
`bunx convex deploy`; shipping a mutation's new arguments without it breaks
production.

**Convex has two deployments and the CLI defaults to dev.** `convex env list`,
`codegen` and `run` hit dev; `convex deploy` hits prod. Their env vars differ
(Clerk issuer, pod URLs) — pass `--prod` before drawing conclusions.

Settings are duplicated across Vercel and Convex under different names
(`NEXT_PUBLIC_MEDIA_URL` / `MEDIA_BASE_URL`). Which copy wins depends on where the
code runs: Next routes read Vercel's, Convex actions read Convex's. The Vercel
copies of pod URLs are stale — pods self-register into Convex.

`bun test` discovers `*.test.ts` recursively from the repo root, which is what
makes the workspace split invisible to it — all 16 suites moved into
`packages/shared/` and none of them had to be re-pointed. `bun run test` is just
an alias; it used to be a `node --import tsx --test lib/*.test.ts` shell glob
that silently skipped anything nested.

# Access is an allowlist, in two places

Clerk sign-up cannot be restricted on this plan (`app:allowlist` is paid), and Convex
trusts any valid token from the instance regardless — so the gate is `ALLOWED_USER_IDS`,
a comma-separated list of Clerk user ids, enforced in `proxy.ts` **and** in every public
Convex function via `packages/backend/convex/authz.ts`. It fails closed: unset means nobody gets in.

**The allowlist does not apply on a Clerk development instance.** There are two Clerk
instances — production on the app's own domain, and a development one at
`<name>.clerk.accounts.dev` that local dev signs into — and a Clerk user id
belongs to exactly one of them: the same human has a different id in each. So the list of
_production_ ids that `vercel env pull` writes into `apps/web/.env.local` matched nobody
locally and sent every local sign-in straight to `/no-access`.
`packages/shared/allowed-users.ts` therefore reads
`CLERK_JWT_ISSUER_DOMAIN` and skips the list entirely when the host ends in
`.clerk.accounts.dev`. Nothing has to be kept in sync and no env var has to change; an
unset or unparseable issuer is _not_ development, so the fail-closed behaviour is intact.

The consequence is that **anyone who can sign up on the dev Clerk instance can use the dev
Convex deployment**, which carries real `FAL_KEY` / `HIGGSFIELD_CREDENTIALS` / B2
credentials. That is the deliberate trade for local dev that just works; tighten the dev
Clerk instance, not this code, if it ever stops being acceptable.

`POD_URL_SECRET` gates `packages/backend/convex/config.ts:comfyuiUrl`, which returns the GPU pod URL to
an unauthenticated caller (`apps/web/lib/comfyui-url.ts` reaches it with no token, by design). Its
argument is `v.optional` so Vercel and Convex can deploy in either order; a wrong or
missing secret degrades to the stale build-time pod URL rather than failing loudly.

Both variables must be set in Vercel **and** in both Convex deployments.

`POD_URL_SECRET` has a third job: it also gates the `/artsnack/download` +
`/artsnack/status` routes that provision.sh's artsnack-downloader node registers on the
pod's public ComfyUI port (downloads are limited to huggingface.co), and the
`GET /pod-manifest` HTTP action
(`packages/backend/convex/http.ts`) a booting pod fetches its dynamic model list from. For
those to work the secret must ALSO be in the **RunPod template env** (the manifest fetch
additionally needs `CONVEX_DEPLOY_KEY`, which the template already carries for URL
registration — and since that key is a prod key, pods only ever read the **prod**
manifest; `podModels` rows written against dev never reach a pod). Everything fails
closed without either: the pod routes answer 503, the manifest fetch logs "static only",
and the pod provisions exactly as before.

Vast provisioning progress does **not** use the shared pod secret. Each launch
mints a random token, stores only its SHA-256 hash, and passes the raw token to
that one instance. The callback URL comes from Convex's system-provided
`CONVEX_SITE_URL`, so a production action necessarily reports to the same
production deployment that owns its backend row. Do not duplicate this URL in
a custom environment variable: `VAST_PRODUCTION_CONVEX_SITE_URL` once pointed a
production instance at dev and left an H100 running with a permanently stale
5% progress row.

The upstream `runpod/comfyui` image ships an empty `onstart.sh` in its WORKDIR.
Vast's SSH wrapper preserves and executes that empty file, ignoring the API
`onstart` contents stored on the contract. Vast also records `EXTRA_COMMANDS`
on the contract but strips that reserved variable from the live PID 1
environment, so neither path can start provisioning.

Production therefore uses the public, secret-free adapter image documented in
`infra/vast-image/README.md`, pinned by immutable digest in the Convex `VAST_IMAGE`
variable. Its image-owned `onstart.sh` reads the
single-line `ARTSNACK_STARTUP_SCRIPT_B64` environment variable, decodes a
dedicated Bash script, and backgrounds it before the wrapper continues. The
base64 transport is required because Vast silently removes multiline env
values. The model list, provisioning script, URLs, and credentials are supplied
only at instance runtime; they are not built into the public image. The
Worker in `infra/cloudflare-access-stripper` (route set in its `wrangler.jsonc`)
removes Cloudflare Access credentials before the request enters the Tunnel.

# Responsiveness: the rules that keep clicks instant

The 2026-10-14 performance pass found that most "the app is slow / a click did
nothing" reports came from a handful of patterns. Each has a fix in place; the
fix only holds while new code follows it.

- **In-page URL state never goes through the router.** `router.push/replace` is
  a navigation: once the prefetched copy is stale it waits on an RSC round trip
  through `proxy.ts` and Clerk, inside a transition, with the clicked control not
  updating until the server answers. Favorites filters use nuqs
  (`useQueryStates`, shallow); Generate, Search, Enhance and Prompts use
  `window.history.replaceState`. Build the next URL from the current one, not
  from a `useSearchParams` snapshot, or back-to-back clicks overwrite each other.
- **Controls never unmount while data loads.** A changed query shows the
  previous rows (narrowed client-side where possible, e.g.
  `packages/shared/favorite-filters.ts`, which the server uses too) instead of a
  page-wide skeleton. Skeletons go in the grid area only.
- **Revisits render from memory.** `apps/web/lib/convex-cache.ts` is a drop-in
  `useQuery`/`usePaginatedQuery` that returns the last result for the same user,
  query and arguments while a fresh subscription loads. Use it for lists and
  display data; never for anything that seeds a form or a mutation, where a
  stale snapshot would be written back.
- **Background writes must not re-render grids.** Convex hands every row of a
  changed page back as a new object. `useStableRows` keeps unchanged rows'
  identity (ignoring lease/progress bookkeeping fields), tiles are `memo` with
  key-taking callbacks (`itemKey` on `ImageGridItem`/`VideoGridItem`), and the
  backend skips writes that change nothing (`comfyLeaseDecision`,
  `progressChanged`, `providerStatePatchChanges`). A new "touch the row every
  poll" write undoes all of it.
- **The React Compiler silently skips** any component or hook containing
  `try…finally`, value blocks inside `try`, refs read during render, or a
  disabled `react-hooks` lint rule. Use promise chains or module-level helpers,
  `useEffectEvent`, and WeakMap-keyed caches. Check with a compiler pass over the
  touched files before shipping a hot component.
- **Polls pause when hidden and never overlap** (`usePolling` in
  `runpod-backend-panel.tsx`); every upstream `fetch` has a deadline.
- **Convex auth survives sleep.** `components/convex-client-provider.tsx`
  retries Clerk token fetches through transient errors and re-authenticates a
  session Convex gave up on; the stock adapter turned one failed refresh into an
  anonymous app until reload. `expectAuth` holds queries until the first token,
  so pages never render their signed-out empty states first.
- **Tabs stay prefetched for a day** (`experimental.staleTimes.static` in
  next.config.ts): every tab is a static shell whose data comes from Convex.
- **Next is patched** (`patches/next@16.2.12.patch`, applied by Bun through
  `patchedDependencies`). On a full page load of a static route with search
  params — `/favorites?folder=…&type=image` — Next learns the route under the
  search it was _rendered_ with (none, it is prerendered) but records the
  browser's URL, search included, as its canonical URL. Every later client
  navigation to that pathname, with any search or none, then landed back on the
  first-load search: return to Favorites from another tab and the folder and
  type you had since changed snapped back. The patch records the canonical URL
  without the unrendered search. 16.4.0 still has the bug; when upgrading Next,
  re-check `requestOptimisticRouteCacheEntry` / `createInitialRouterState` and
  drop or re-make the patch (`bun patch next@<version>`).

# Local media cache: a service worker in front of the media CDN

**Off since 0.16.3.1; opt-in with `NEXT_PUBLIC_MEDIA_CACHE=on`.** Its only way to
read media is the `/media/*` rewrite below, and Vercel's proxy streams from
the media CDN at roughly 70 KB/s (a 2 MB clip: 26–29 s, against 0.5 s from the CDN;
a 19 KB thumbnail: 0.5–2.7 s against 85 ms). With a grid of clips that was minutes
of spinners, and in 0.16.2.x the slow streams also queued the page's own requests
until the app itself stopped loading. Every page now unregisters the worker, and any
copy of the script not registered with `enabled=1` retires itself on its next update
check (stops intercepting, deletes the cache and the LRU index, unregisters). Turn it
back on only after the media CDN sends CORS headers and the worker fetches the CDN
directly instead of through `/media/*`. The design notes below describe the worker as
it runs when enabled.

`apps/web/public/media-cache-sw.js` keeps originals from the media CDN in Cache Storage
on the device (up to 20 GB, LRU in IndexedDB) and answers the page from it — in the
browser and in the desktop shell alike, since the shell is Chromium on the app's origin. It
exists because the media CDN answers `Cache-Control: max-age=14400` with no validator:
after four hours the HTTP cache re-downloads a clip in full.

- **It downloads through `/media/*`, never from the media CDN directly.** The CDN sends
  no CORS headers, so a response the worker fetched from there would be opaque —
  unstorable in any useful way and impossible to slice into ranges. `/media/:path*` is
  a `rewrites()` entry in `apps/web/next.config.ts` to `NEXT_PUBLIC_MEDIA_URL`, and
  `proxy.ts`'s matcher skips it so a fill never meets a Clerk handshake. Drop the
  rewrite and every miss costs a 404 before falling back to the network.
- **It never touches `cdn-cgi/` or anything off the media origin.** Thumbnails and
  posters are Cloudflare transformations served best by the viewer's nearest edge;
  through `/media/*` they would detour via Vercel's region to a colder cache. `install`
  registers static routes (`event.addRoutes`, Chromium's Static Routing API) that send
  those, and every request to the app's own origin, to the network without dispatching a
  fetch event — so a navigation never waits for an idle worker to boot. The fetch
  handler repeats the same checks for browsers without the API.
- **Once it answers a clip, every range of it is an answer it built.** Chromium refuses
  a media resource whose ranges come from different origins, and a `fetch(request)`
  handed on carries the CDN's origin while a `new Response(...)` carries none. So
  a range is answered from the cache, from a download in memory, or — on a miss —
  fetched as exactly that range through `/media/*` and re-wrapped, chunk for chunk.
  The rule cuts both ways, so the worker remembers which side answered each clip
  (`clipSources`, last 500): only a clip's first answer may fall back to
  `fetch(request)`, and that clip then stays on the network; a clip the worker has
  answered is retried once and then failed with a 504 the worker builds, and the
  bypass never takes it away. The side is pinned synchronously right before an answer
  goes out (first claim wins; a loser cancels its upstream and follows), and
  concurrent first ranges — a tile and the lightbox — wait for one leader. The map is
  in memory, so a worker the browser stopped while idle forgets it.
- **A clip is downloaded whole only when the page asks** — `prefetchMedia`: hovering a
  tile, or a result that just finished. v0.16.2.0 turned the first range of every
  `<video preload="metadata">` tile into a full download, held in worker memory, that
  outlived the tile and the page: scrolling a video grid ran dozens at once on the
  connection navigations and API calls share. A tile's range is now passed through,
  and the element letting go cancels the upstream fetch. Original images (requests
  without a Range) still download whole, and such a download is aborted 3 s after its
  last reader leaves; a prefetch runs to the end. A range more than 2 MiB ahead of a
  running download (index at the end, a seek) is passed through, not waited for.
- **Prefetches run two at a time, newest first, at `priority: "low"`**, from a queue
  of 16 that drops the oldest. `usePrefetchNewMedia` sends only a true insertion at
  the head of a list (`freshAtHead`); a list replaced by a filter or a folder change is
  a new baseline, not new results.
- **Nothing waits forever.** 15 s to response headers, 20 s between body chunks (for
  passed-through ranges too), 10 s for the size probe. A stall fails the download,
  drops it so the next request starts afresh, and counts toward the breaker: three
  path failures in a row and the worker stops intercepting for ten minutes. A 4xx is
  the object's answer, not a path failure, and prompt headers are not a success — a
  path that stalls every body still trips it.
- **A range answer needs the total size.** A 200 to `bytes=0-` would also play, but
  Chromium then treats the clip as unseekable. When the body is chunked (no
  Content-Length), the worker asks for `bytes=0-0` to learn the size.
- **Kill switch: `NEXT_PUBLIC_MEDIA_CACHE=off`.** It is inlined at build time, so set it
  in Vercel and redeploy; every page that then loads unregisters the worker instead of
  registering it (`apps/web/lib/media-cache.ts`), and is uncontrolled from its next
  load. The cache stays on disk, so turning it back on starts warm. Navigations never
  reach the worker's media path (the static routes, or the fetch handler's first
  check), so even a misbehaving worker cannot stop the page carrying the switch from
  loading.
- Keys are treated as immutable, which holds today: every writer puts a timestamp and
  random suffix, a content hash, or a provider request id in the key. A writer that
  overwrites a key in place would be served the stale copy until evicted.

Tested in Chromium only; Settings shows the size and can clear it. The pure helpers
are pinned by `apps/web/lib/media-cache-sw.test.ts`, and what counts as a new result
by `apps/web/lib/media-cache.test.ts`.

# Prompt Studio: "Write with AI" on the API tab

A chat that writes prompts (`apps/web/components/prompt-studio/`), rendered by
`ApiForm` through a portal into the results pane, which `ApiPanel` hides while it
is open. The rules — system prompt, JSON reply shape, variant labels (1, 2, 3;
a revision of 2 is 2.1), the word diff — are `packages/shared/prompt-studio.ts`,
so the native apps call the same Convex functions with the same semantics:
`promptStudioRun.send` (Node action), `promptStudio.list/get/remove`. Labels are
given out inside `promptStudio.appendRound`, never by the client.

- **Which models see images is `EnhanceModel.vision`**, copied from Atlas's own
  `GET /v1/models` (`input_modalities`, public, no key). Only the Grok family
  lists `image` today; recheck there before marking another model.
- **Images are not stored.** The client uses the "studio" profile, 1536 px and
  768 KiB per image, so four base64 images fit Node actions' 5 MiB argument limit.
  Every turn sends them again; sessions hold only text.
- Existing sessions take a lease in `promptStudio.forSend` before calling the
  model. Append or failure releases it; an expired lease can be replaced after
  the Node action's maximum lifetime. Sessions stop at 60 messages or 384 KB,
  reserving room for the next answer before spending on a model call. The byte
  cap also keeps the 30-session History query within Convex's read limit.
- An Enhance recipe can be the studio's "Format": it is embedded through
  `fillRecipePlaceholders`, without Enhance's house rules, which demand a bare
  prompt and would contradict the JSON answer.
- **The native app has it too** (`apps/macos/crates/api_tab/src/studio/`). It
  reads the same `StudioContext` from `crates/rules/js/composer.ts` (the
  view's `studio`, exactly the fields `studioContextValidator` takes — add a
  field there and to the validator together), runs `diffWords` through
  QuickJS, and binds Cmd+Enter in its own key context: without that, the
  tab's Cmd+Enter would start a paid generation from the chat box.

# Pod manifest: adding models without republishing provision.sh

A booting pod appends `GET /pod-manifest` (`packages/backend/convex/http.ts`) to the
static manifest in provision.sh, so models can be added per profile without
republishing the script: write a `podModels` row with
`bunx convex run podModels:upsert` (Hugging Face URLs; the downloader node refuses
any other host). The provision.sh machinery itself still has to be republished to
`PROVISION_SCRIPT_URL` before a change to the downloader node or the manifest fetch
reaches a pod (see the rule at the top of this file). `podDownloads.status` reports
what the downloader node on a live pod is doing. The filename and manifest-line rules
shared by Convex and the node live in `packages/shared/pod-model-downloads.ts`, and the
node's Python re-states them by hand — change one, change both.

# Launch dialog: choosing which models a new pod downloads

"Rent" (RunPod image and video pods, Vast.ai) opens `components/pod-launch-dialog.tsx`,
which lists the optional lines of the provisioning manifest — read by
`convex/podLaunchModels.ts` from the **published script** at `PROVISION_SCRIPT_URL`
(falling back to the `provisionScript` cache), not from the repo copy, because that is
what the pod will run — plus
the profile's `podModels` rows. What the user unchecks travels as `skipModels` →
`ARTSNACK_SKIP_MODELS_B64` (base64 of `dir|filename` lines) → provision.sh's
`without_skipped`, which drops only lines in the directories it names as optional:
checkpoints/LoRAs on the image pod, the community add-ons and `podModels` rows on the
video pod. The Face Fix detectors, upscaler and H3 base set cannot be skipped
whatever the variable says. A skip list rather than a pick list, so anything added
after the dialog opened still downloads. The parser and the bash filter are pinned
together by `packages/shared/pod-model-selection.test.ts`.

The env var is ignored by any provision.sh published before this feature, so the
dialog does nothing on a pod until the published script is updated — it fails toward "download
everything", never toward a missing model.

# Self-hosted video: MiniMax H3 on its own RunPod pod

The Generate page's "Self-hosted video" tab runs MiniMax H3 (open weights,
ComfyUI-native) with custom checkpoints and LoRAs on a **separate**
managed RunPod pod — `runpodBackends.purpose = "video"`; a row without a purpose
is the image pod, so one of each can run at once.

- **Same template, different profile.** The launch action passes
  `ARTSNACK_PROFILE=video` and forces the CUDA 13.0 template. provision.sh then
  updates ComfyUI to `VIDEO_COMFYUI_REF` (the image ships 0.18.2, which has no H3
  nodes), downloads only the H3 base set from Hugging Face (~4 min to ready),
  and queues the video manifest's custom models on the downloader node _after_
  ready. Updating ComfyUI with `git checkout` resurrects real `models/<dir>`
  directories over the NVMe symlinks — the script re-links afterwards; skip that
  and ComfyUI lists none of the base set.
- **Hugging Face throttles anonymous downloads per IP**, and a pod shares its
  datacenter's IP: on 2026-10-11 one 20 GB base file came back as a 10 KB error
  page and another took 9 minutes instead of 90 s. The video profile retries
  failed files once, sequentially; an optional `HF_TOKEN` in the prod Convex env
  is passed to the pod and lifts the limit (provision.sh and the downloader node
  both send it to huggingface.co only).
- **Jobs live in `grokGenerations` as provider `comfy`.** That table's grid,
  lightbox, favourites and search already handle video, and its Atlas poll-lease
  fields carry jobs past the 10-minute action ceiling: `comfyVideoProcessor.run`
  polls ~7 min then hands off, `comfyVideo.rescue` (cron, 1 min) re-arms a job
  whose action died. `falRequestId` holds the ComfyUI prompt id. Deleting an
  unfinished clip also removes it from the pod's queue.
- **The graph is `packages/shared/h3-video.ts`**, flattened from Comfy-Org's
  official templates; the base filenames there are a contract with provision.sh.
- The retired Wan 2.2 pipeline's clips were migrated into the same table;
  `convex/videos.ts` is now no-op stubs because shipped iOS builds still call it.
- **LTX 2.3 runs on the same pod** (`packages/shared/ltx-video.ts`, the two-pass
  pipeline: half size, 2× latent upscale, 3-step refine). A row carries
  `ltxSettings` instead of `h3Settings`; the processor builds whichever graph.
  provision.sh fetches the LTX base set (`LTX_MODELS`, ~45 GB) in the background
  after ready, so H3 is never held up. Checkpoints of both families live in
  `diffusion_models/`; `videoModelFamilies` plus a filename guess
  (`guessVideoFamily`) split them between the two forms.
- **LTX "Reference sheet" is Lightricks' Ingredients IC-LoRA on core nodes.**
  Its `reference_downscale_factor` is 1, so core `LTXVAddGuide` at frame 0 with
  the sheet repeated to the clip length does what ComfyUI-LTXVideo's IC-LoRA
  guide node does — that pack is not installed. The LoRA is gated on Hugging
  Face: provision.sh drops it from `LTX_MODELS` unless `HF_TOKEN` is set, and
  the token's account must have accepted the LTX-2 Community License.
- **Several video pods can run at once** (up to `MAX_VIDEO_PODS`). A clip is
  pinned to the pod picked in the form, or on "Auto" assigned to the least busy
  GPU across all ready pods that list its checkpoint, LoRAs and (LTX) encoder —
  each pod has its own disk.
- **B300 (Blackwell Ultra) has almost no INT8 throughput.** The int8 H3 builds
  and Comfy Kitchen's INT8 attention ran 4× slower there than on an RTX PRO
  6000; fp8 checkpoints with default attention only matched it (2026-10-12).
  provision.sh fetches the fp8 H3 builds on a B300, and the form warns.

# Provisioning fetch has a fallback: GET /provision-script

Hosts like GitHub rate-limit anonymous fetches per source IP, and a pod shares its
datacenter's egress IP with every other tenant — one pod got a 429 on the template's
single boot-time curl and came up bare: no models, no downloader node, no Convex
registration, and no log saying why. `GET /provision-script`
(`packages/backend/convex/http.ts`, gated by POD_URL_SECRET like `/pod-manifest`)
proxies `PROVISION_SCRIPT_URL` from Convex's egress and caches the last good copy in
the `provisionScript` table, so the RunPod template's docker command can fall back to it
— and keeps retrying in the background so ComfyUI still starts while the fetch loops.
The published script stays the single source of truth; the cache refreshes on every
successful fetch and is never written by hand. The template's docker command lives only
in the RunPod console (not in this repo), so changing the fetch logic means editing it
there.

# Higgsfield worker: services/higgsfield-worker

Higgsfield publishes no REST API — only an official CLI. `services/higgsfield-worker`
wraps that CLI binary behind HTTP and runs as its own Vercel container deployment
(Root Directory `services/higgsfield-worker`; it is not a Bun workspace package).

- Convex calls it with a shared secret: `/generate`, `/status`, `/cost`, `/balance`,
  `/model`, `/health`
- Convex env vars: `HIGGSFIELD_WORKER_URL`, `HIGGSFIELD_WORKER_SECRET`,
  `HIGGSFIELD_CREDENTIALS`, `HIGGSFIELD_WORKSPACE_ID`

**Auth is a manual, human-only step.** The Higgsfield CLI has to be logged in on a
machine you control (`higgsfield auth login`), and the resulting
`~/.config/higgsfield/credentials.json` is what seeds `HIGGSFIELD_CREDENTIALS`. The
worker stores nothing: credentials travel with each request and are rotated back in
the response. An agent cannot perform or repair this — when Higgsfield returns an
auth error, say so and stop.

It deploys as its own Vercel project: a push that deploys the web app does not update it.
