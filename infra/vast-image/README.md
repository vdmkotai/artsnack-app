# Vast ComfyUI image

Vast's SSH launcher replaces the Docker entrypoint, but it executes an existing
`onstart.sh` from the image working directory. The upstream RunPod image ships
that file empty. This derivative changes only that adapter and keeps the same
pinned ComfyUI/CUDA base.

The image is published without unpacking the multi-gigabyte CUDA base on the
GitHub runner: Crane streams the pinned base layers between registries and
appends a deterministic tar layer containing only `onstart.sh`.

The workflow (`.github/workflows/vast-image.yml`) publishes the result as
`ghcr.io/<repository owner>/artsnack-comfyui-vast:1.4.1-cuda12.8-v2`. Vast pulls
it without registry credentials, so the GHCR package must be public. After the
very first publish, change the package visibility to public in GitHub Packages
and rerun the failed workflow. The workflow logs out of GHCR and verifies an
anonymous pull on every publication; the production Convex deployment must not
be pointed at a new image until that check passes.

Vast silently drops multiline environment values. Convex therefore base64
encodes the generic startup script into `ARTSNACK_STARTUP_SCRIPT_B64`, and the
adapter decodes it before execution. The compatibility path for the old plain
variable remains for platforms that preserve multiline values.

Production does not use the mutable tag. Set the `VAST_IMAGE` environment
variable on the Convex deployment to the verified manifest digest that the
workflow's "Verify anonymous pulls work" step prints, for example:

```plaintext
ghcr.io/<repository owner>/artsnack-comfyui-vast@sha256:<digest>
```

`packages/backend/convex/vastBackendActions.ts` refuses to launch a Vast
machine while `VAST_IMAGE` is unset.

The package layer contains only `onstart.sh`. The provisioning script, model
manifest, service URLs, and credentials are injected at instance runtime and
are not part of the published image.
