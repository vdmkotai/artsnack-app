# ArtSnack

A self-hosted, single-user AI art platform. One person generates images and video,
either on their own GPU or through hosted vendors, and browses the results.
The vocabulary below exists because the two generation routes look similar in
the UI and share almost nothing underneath.

## Language

### The two routes

**Self-hosted**:
Generation that runs on your own ComfyUI instance. Reachable in the UI
as the default tab of the generate page.
_Avoid_: local, ComfyUI mode, models tab

**Hosted API**:
Generation performed by an outside vendor that bills per output. Reachable as
the API tab of the same page.
_Avoid_: cloud, remote, Grok tab

**Provider**:
One vendor behind Hosted API — Grok Imagine, Higgsfield, fal.ai, or Atlas Cloud. Chosen
before the model, because the same model can cost different amounts and accept
different inputs depending on who runs it.
_Avoid_: backend, service, vendor

**Backend**:
Reserved for a Self-hosted target: a ComfyUI or RunPod instance. Never used for
a Provider.
_Avoid_: pod (a pod is one particular RunPod backend), server

**Pod**:
A single RunPod GPU machine acting as a Backend. Ephemeral — a new one gets a
new host, and registers its own URL into Convex rather than being redeployed to.

### What gets made

**Generation**:
One request and its outputs. Self-hosted ones live in `generations`, Hosted API
ones in `grokGenerations` regardless of provider or media type.
_Avoid_: job, render, creation

**Enhancement**:
A second pass over an existing image on a Backend — img2img, upscale, refine, or
facefix. Never produced by a Provider; no Provider offers these.
_Avoid_: edit, post-process, upscale (upscale is one mode of four)

**Reference**:
An input image attached to a Hosted API prompt to steer the output, tagged in the
prompt text as `@image1`, `@image2` and translated per Provider at the API
boundary. Distinct from a fixed Frame input and from an Enhancement source, neither
of which is tagged.
_Avoid_: source image, input image, attachment

**Frame input**:
An image assigned to a fixed video position such as Start or End. Atlas video
families that also accept References expose a Frames/References switch so the
same attachments are never reinterpreted silently.
_Avoid_: reference, attachment

**Handoff**:
Carrying an existing output into a new form as a Reference, or into a different
Provider or model. The user-facing promise is "use this again elsewhere".
_Avoid_: reuse, send to, remix

### Access

**Allowlist**:
The set of Clerk user ids permitted to use the instance, held in
`ALLOWED_USER_IDS` and enforced independently in `proxy.ts` and
`convex/authz.ts`. It guards spend — the fal balance and Higgsfield credits are
account-wide — not privacy. Fails closed.
_Avoid_: auth, permissions, access control

### Status

**Legacy**:
Self-hosted video (the WAN 2.2 image-to-video pipeline) only. Already hidden from
the navigation and slated for deletion. Self-hosted images and Enhancement are
current and actively used; do not describe them as legacy.
