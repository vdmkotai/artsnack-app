# ArtSnack

A self-hosted, single-user studio for AI images and video. One person generates on
their own GPUs (ComfyUI on RunPod or Vast.ai) or through hosted providers (Higgsfield,
fal.ai, Atlas Cloud, Grok Imagine), and browses, searches and reuses the results from a
web app, an iPhone app and two macOS clients that share one Convex backend.

## What it does

- **Self-hosted generation.** Image and video workflows on your own ComfyUI: checkpoints,
  samplers, schedulers, LoRA stacking, batches. The app rents and manages RunPod and
  Vast.ai GPUs itself, picks which models a new pod downloads, and tracks provisioning
  progress. Video runs MiniMax H3 and LTX 2.3 on dedicated pods, several at once.
- **Hosted providers behind one form.** The API tab puts four providers behind a switcher
  and shows each one's models. The same model can be reachable through more than one
  provider, but price, billing unit and accepted inputs differ, so the provider is the
  first choice rather than a detail.
  - **Higgsfield**: Seedream 4.5 / 5.0 Lite and Seedance 2.0 through their official CLI,
    wrapped by [`services/higgsfield-worker`](services/higgsfield-worker). Billed in plan
    credits.
  - **fal.ai**: Seedream 4.5 / 5.0 Lite / 5.0 Pro and Seedance 2.0 (text-, image- and
    reference-to-video, 4–15 s, 480p–4K, with audio).
  - **Atlas Cloud**: a broad image and video catalogue (`packages/shared/atlas-catalog.generated.ts`,
    refreshed with `bun run atlas:sync`).
  - **Grok Imagine**: images and video on a SuperGrok subscription, via xAI's
    device-authorization flow.
  - Reference images are tagged in the prompt as @image1, @image2… and translated per
    provider at the API boundary.
- **Every price is visible before you click**: on the Generate button, on each option
  that changes the cost, on queued tiles and on finished results.
- **Enhance**: img2img, upscaling, refinement and Face Fix on the self-hosted pod.
- **Prompt Studio**: a chat that writes and revises prompts, with word diffs between
  variants.
- **Library**: gallery, history with parameter replay, favourites with folders, and a
  small search language (`dog|fox, beach, -scarf`, `"red dress"`) that runs the same in
  TypeScript and in a Rust port for the native app.

## Repository layout

```
apps/web/                  Next.js 16 app (App Router, React 19, Tailwind v4, shadcn/ui)
apps/native/               iPhone app (Expo / React Native)
apps/macos/                native macOS client (Rust, GPUI); shared TS runs in QuickJS
apps/desktop/              Electron shell around the deployed web app
packages/backend/          Convex: schema, queries, mutations, actions, crons, HTTP routes
packages/shared/           portable logic: model registry, pricing, payloads, workflows
services/higgsfield-worker/  stateless HTTP wrapper around the Higgsfield CLI
infra/                     RunPod provisioning script, Vast.ai image, Cloudflare Worker
scripts/                   catalogue sync, pod URL and Higgsfield helpers
```

`AGENTS.md` is the working guide for coding agents and humans alike: the layout rules,
the non-obvious decisions and the traps. `CONTEXT.md` defines the domain vocabulary.

## Architecture

- **Web** on Vercel; **auth** is Clerk; **database, jobs and provider calls** are Convex.
- **Media** lives in Backblaze B2 behind a CDN on your own domain. `/api/images` and
  `/api/videos` re-serve the same objects same-origin, gated by a prefix allowlist.
- **Self-hosted pods** register their own URL into Convex when they boot. Long jobs are
  driven by Convex actions with poll leases, so they survive the 10-minute action limit.
- **Access** is an allowlist of Clerk user ids, enforced in `apps/web/proxy.ts` and in
  every public Convex function. It fails closed.

## Getting started

### Prerequisites

- [Bun](https://bun.sh)
- A [Convex](https://convex.dev) project and a [Clerk](https://clerk.com) application
- A Backblaze B2 bucket and a CDN in front of it
- Optional: RunPod / Vast.ai accounts for self-hosted generation, and keys for the hosted
  providers you want

### Configuration

Nothing about a deployment is hard-coded. Every value comes from the environment:

| File                                                             | Who reads it                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| [`apps/web/.env.example`](apps/web/.env.example)                 | Next.js (`apps/web/.env.local`, or Vercel)            |
| [`packages/backend/.env.example`](packages/backend/.env.example) | Convex (`bunx convex env set …`, for each deployment) |
| [`apps/native/.env.example`](apps/native/.env.example)           | the iPhone app (`EXPO_PUBLIC_*`, bundle id)           |
| [`apps/macos/README.md`](apps/macos/README.md)                   | the macOS client (`ARTSNACK_*` or a `config.json`)    |
| [`apps/desktop/README.md`](apps/desktop/README.md)               | the Electron shell (`ARTSNACK_DESKTOP_URL`)           |

Two values have to exist in three places, because Vercel and the two Convex deployments
do not share variables:

```bash
IDS="user_xxx,user_yyy"                      # Clerk user ids allowed in
bunx convex env set ALLOWED_USER_IDS "$IDS"
bunx convex env set --prod ALLOWED_USER_IDS "$IDS"
vercel env add ALLOWED_USER_IDS production   # and preview, and development

SECRET=$(openssl rand -hex 32)               # gates pod URL lookup and pod routes
bunx convex env set POD_URL_SECRET "$SECRET"
bunx convex env set --prod POD_URL_SECRET "$SECRET"
vercel env add POD_URL_SECRET production
```

The allowlist does not apply on a Clerk development instance (`*.clerk.accounts.dev`),
so local sign-in works without a second list of ids; see `AGENTS.md`.

### Providers

- **fal.ai**: `FAL_KEY` and `MEDIA_BASE_URL` (the same CDN origin as
  `NEXT_PUBLIC_MEDIA_URL`) on Convex. fal fetches reference images itself, so it needs a
  reachable URL.
- **Atlas Cloud**: `ATLASCLOUD_API_KEY` on Convex.
- **Grok Imagine**: connect from the app (device authorization); tokens live in Convex
  and refresh automatically.
- **Higgsfield**: deploy `services/higgsfield-worker` as its own Vercel project (see its
  README), set `HIGGSFIELD_WORKER_URL` / `HIGGSFIELD_WORKER_SECRET` on Convex, then sign
  in once with `higgsfield auth login` and run `bun run higgsfield:auth` to hand the
  credentials to Convex.
- **Self-hosted ComfyUI**: publish `infra/provision.sh` somewhere a pod can fetch it and
  set `PROVISION_SCRIPT_URL`; for Vast.ai also build the image in `infra/vast-image` and
  set `VAST_IMAGE`.

### Development

```bash
bun install
bun run convex:dev     # terminal 1: Convex dev deployment
bun run dev            # terminal 2: Next.js on http://localhost:4000
```

### Checks

```bash
bun run typecheck      # root, apps/native and apps/desktop
bun test               # every *.test.ts in the workspace
bunx oxlint
bunx oxfmt --check
(cd apps/macos && cargo check --workspace && cargo test --workspace)
```

The TypeScript checks run in GitHub Actions on every push and pull request.

## fal costs

Charged per output image, or per second of video, against fal's prepaid balance.

| Images                          | Per image |
| ------------------------------- | --------- |
| Seedream 4.5                    | $0.04     |
| Seedream 5.0 Lite               | $0.035    |
| Seedream 5.0 Pro — 1K           | $0.0675   |
| Seedream 5.0 Pro — 2K (default) | $0.135    |

| Video (per clip)             | 6s    | 10s   | 15s    |
| ---------------------------- | ----- | ----- | ------ |
| Seedance Mini 720p (default) | $0.93 | $1.55 | $2.32  |
| Seedance Fast 720p           | $1.45 | $2.42 | $3.63  |
| Seedance Standard 720p       | $1.81 | $3.02 | $4.54  |
| Seedance Standard 1080p      | $4.08 | $6.80 | $10.21 |

`duration: "auto"` and fal's `auto_*` size presets are deliberately not exposed: both leave
the output size or length to the model, which would make the price unknowable before the
request.

## License

[MIT](LICENSE).
