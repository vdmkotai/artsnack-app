# artsnack-higgsfield-worker

Stateless HTTP wrapper around the [Higgsfield CLI](https://github.com/higgsfield-ai/cli),
driven by the ArtSnack Convex backend.

## Why this exists

Higgsfield publishes a CLI and an MCP server, not a documented REST API. Their private API
can be read out of the CLI binary, but every field name would be a guess with nothing to
verify it against — so generations go through the official CLI instead, and the CLI needs a
process to run in. Convex actions cannot spawn processes, hence this container.

It lives in `services/higgsfield-worker` and deploys as its own Vercel project rather than
inside the app's: a `Dockerfile.vercel` at a project root captures **all** traffic for that
project, which would shadow the Next.js app.

## How it works

Deployed on Vercel as a container function. Container functions are stateless — they "keep
nothing between calls" — so the Higgsfield credentials travel with every request, are
written to a throwaway `HOME` for the CLI to read, and any token the CLI rotates is handed
back in the response for Convex to persist.

```
Convex action ──POST──► this worker ──exec──► higgsfield CLI ──► Higgsfield
              ◄─────────  job id / status / cost / balance + rotated credentials
```

## Endpoints

All POST, all JSON, all requiring `x-worker-secret`.

| Route       | Purpose                                                         |
| ----------- | --------------------------------------------------------------- |
| `/generate` | Submit a job. Returns immediately; polling is the caller's job. |
| `/status`   | Poll a job by id.                                               |
| `/cost`     | Credits for a configuration, without creating anything.         |
| `/balance`  | Plan balance and account details.                               |
| `/model`    | Parameter schema for a job type.                                |
| `/health`   | Unauthenticated liveness check.                                 |

## Environment

| Variable             | Required    | Purpose                                                                                                                                                                 |
| -------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKER_SECRET`      | yes         | Shared secret. Anyone who can reach this worker can spend Higgsfield credits.                                                                                           |
| `ALLOWED_MEDIA_HOST` | recommended | Only this host may be fetched for reference images (your media CDN's hostname, e.g. `media.example.com`), so a leaked secret cannot turn the worker into a fetch proxy. |
| `COMMAND_TIMEOUT_MS` | no          | Per-CLI-invocation timeout. Defaults to 180000.                                                                                                                         |

## Local run

```bash
npm i -g @higgsfield/cli
WORKER_SECRET=dev node server.js
curl localhost:3000/health
```

## Notes

- Credentials are never stored here. They arrive per request and the temp directory is
  removed in a `finally`.
- CLI output is redacted before it leaves the process: it can echo the token file it just
  rewrote, and errors end up in a database and on a screen.
- The secret is compared in constant time, and CLI parameters are whitelisted.
