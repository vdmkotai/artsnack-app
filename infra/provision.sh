#!/usr/bin/env bash
# ARTSNACK_PROVISION_VERSION=artsnack-dual-provider-2026-08-19-v1
# ---------------------------------------------------------------------------
# provision.sh — auto-download models + Enhance nodes into ComfyUI on RunPod
#
# THIS FILE IS NOT WHAT RUNS. The RunPod template's docker command fetches the
# script from wherever you publish it (a gist's raw URL, a release asset, an
# object in your bucket) at container start:
#
#   curl -fsSL "$PROVISION_SCRIPT_URL" -o /provision.sh
#
# and Convex proxies the same URL at /provision-script for Vast machines and as
# a fallback (set PROVISION_SCRIPT_URL on the Convex deployment — see
# packages/backend/convex/provisionScript.ts). So a change here reaches no pod
# until it is published. If you publish to a gist, PULL BEFORE YOU PUSH:
# `gh gist edit` replaces the file wholesale with no merge and no warning, so a
# copy read off a running pod can silently revert a fix that landed meanwhile.
# A pod is not a source of truth either — it holds whatever the published copy
# said at ITS boot time.
#
# The copy lives in the repo because the published file has no review and no
# relationship to the code that depends on it — and it does depend on it:
# `packages/shared/enhance-workflows.ts` names the detector files by path, so a
# model dropped from the manifest below is a Face Fix that fails on the next
# cold pod and nowhere else.
#
# Designed for the runpod/comfyui image. Runs at container start (via the
# template's dockerEntrypoint wrapper), downloads every model below onto the
# LOCAL container disk (/comfy-models, NVMe ~8 GB/s) and points ComfyUI's model
# dirs at it via symlink — so generation never stalls on the network volume's
# FUSE layer. SKIPS anything already present.
# Restart same pod -> nothing re-downloads (container disk survives a reboot).
# Stop+Start, or a brand-new pod -> container disk is wiped -> fetched fresh.
#
# Also installs ComfyUI custom nodes required by ArtSnack Enhance (Face Fix):
# ComfyUI-Impact-Pack + ComfyUI-Impact-Subpack, and the small upscale / face
# detector and segmentation weights (4x-UltraSharp, face_yolov8m, face_yolov9c,
# Anzhc eye seg) — see the manifest for which of them does what.
#
# Speed: every file is pulled with aria2c in 4 parallel chunks. More
# connections per file mostly trip per-IP rate limits, and a pod shares its
# datacenter's egress IP with every other tenant. Falls back to plain curl if
# aria2c can't be installed.
#
# Hugging Face token: an optional $HF_TOKEN (set in the template env) lifts the
# anonymous per-IP rate limit and unlocks gated repos.
#
# Two profiles, chosen by ARTSNACK_PROFILE (set by the app's launch action):
#   image (default, and what every pod launched before profiles exists gets) —
#         the SDXL manifest + Face Fix nodes, as always.
#   video — a MiniMax H3 pod: updates ComfyUI to a pinned release (the image
#         ships 0.18.2; H3 needs >= 0.36), downloads only the H3 base files
#         from Hugging Face, reports ready, and THEN queues the user's own
#         checkpoints/LoRAs on the downloader node so the app can watch each
#         one arrive. No Impact Pack, no SDXL manifest. See
#         docs/research/minimax-h3-custom-models.md.
#
# The template env also carries POD_URL_SECRET (same value as in Vercel and the
# Convex deployments). It gates two things: the /artsnack/* routes the
# downloader node below registers on ComfyUI's public proxy port, and the
# dynamic-manifest fetch from Convex. Without it both fail closed and the pod
# provisions from the static manifest alone.
# ---------------------------------------------------------------------------
set -uo pipefail

# ── Adopt the container's env when run from a shell that lacks it ───────────
# The RunPod template env (POD_URL_SECRET, CONVEX_DEPLOY_KEY, HF_TOKEN…)
# reaches PID 1, but an SSH login shell does NOT inherit it — so a manual
# `bash /provision.sh` (or the "To restart after fixing" instructions the boot
# log prints) used to relaunch ComfyUI with no token and no secret, and the
# downloader answered 503 until the next cold boot. Not hypothetical: a pod
# shipped exactly that way on 2026-08-12. Fill in only what is missing, so an
# explicitly exported override still wins.
if [[ -r /proc/1/environ ]]; then
  while IFS= read -r -d '' _kv; do
    [[ "$_kv" == *=* ]] || continue
    _k="${_kv%%=*}"
    [[ "$_k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ -z "${!_k+x}" ]] && export "$_kv"
  done < /proc/1/environ
  unset _kv _k
fi

# ── Config (overridable via template env vars) ─────────────────────────────
COMFYUI_DIR="${COMFYUI_DIR:-/workspace/runpod-slim/ComfyUI}"
# Models live on the LOCAL container disk (fast NVMe), NOT the network volume
# (/workspace = MooseFS/FUSE, which intermittently stalls model loads). ComfyUI
# is pointed here via symlinks (link_local_models). Trade-off: the container disk
# is wiped on Stop, so models re-download on a cold start (~15-20 min).
MODELS_DIR="${MODELS_DIR:-/comfy-models}"
COMFYUI_PORT="${COMFYUI_PORT:-8188}"
LOCAL_COMFYUI_URL="http://127.0.0.1:${COMFYUI_PORT}"
MAX_JOBS="${PROVISION_MAX_JOBS:-2}"        # files downloaded in parallel (each saturates the NIC via aria2c)
ARIA_CONNS="${PROVISION_ARIA_CONNS:-4}"    # 2 jobs x 4 conns stays below per-IP rate limits
MIN_BYTES="${PROVISION_MIN_BYTES:-4096}"   # <4KB result = error/empty
ENHANCE_ONLY=0
[[ "${1:-}" == "enhance" ]] && ENHANCE_ONLY=1
PROFILE="${ARTSNACK_PROFILE:-image}"
# GPUs this pod has; a video pod runs one ComfyUI per GPU (start_gpu_instances).
GPU_COUNT=$(nvidia-smi -L 2>/dev/null | grep -c '^GPU ' || true)
[[ "$GPU_COUNT" =~ ^[0-9]+$ ]] && (( GPU_COUNT > 0 )) || GPU_COUNT=1
[[ "$PROFILE" == "video" ]] || PROFILE="image"
# The ComfyUI release a video pod runs. Pinned, not "latest": H3 support moved
# fast (sparse attention in 0.35, FastH3 templates in 0.36) and an unpinned
# pull would change node inputs under the app's workflow builder.
VIDEO_COMFYUI_REF="${VIDEO_COMFYUI_REF:-v0.39.2}"
PROVISION_WARNINGS=()

log() { echo "[provision $(printf '%(%H:%M:%S)T' -1)] $*"; }
hsize() { local b="${1:-0}"; if (( b >= 1048576 )); then echo "$((b/1048576))MB"; else echo "$((b/1024))KB"; fi; }

# Best-effort progress for the app's launch dialog. Provider and backend id are
# explicit so a Vast and managed RunPod instance can provision simultaneously
# without one callback ever mutating the other's row.
report_progress() {
  local stage="$1" progress="$2" message="$3"
  (( ENHANCE_ONLY )) && return 0
  [[ -z "${ARTSNACK_BACKEND_ID:-}" || -z "${CONVEX_SITE_URL:-}" || -z "${ARTSNACK_PROGRESS_TOKEN:-}" ]] && return 0
  curl -fsS --max-time 10 -X POST "${CONVEX_SITE_URL%/}/backend-progress" \
    -H "x-artsnack-progress-token: ${ARTSNACK_PROGRESS_TOKEN}" \
    --data-urlencode "backendId=${ARTSNACK_BACKEND_ID}" \
    --data-urlencode "provider=${ARTSNACK_PROVIDER:-vast}" \
    --data-urlencode "stage=$stage" \
    --data-urlencode "progress=$progress" \
    --data-urlencode "message=$message" >/dev/null 2>&1 || true
}

report_progress "booting" 8 "Container started. Preparing ComfyUI…"

# True if $1 is a COMPLETE, valid model file ($2 = filename, used for type).
# For .safetensors: verifies the on-disk size matches the size declared in the
# header (catches truncated/half-downloaded files that a size-only check misses).
complete() {
  local f="$1" nm="$2" sz
  sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
  (( sz < MIN_BYTES )) && return 1
  if [[ "$nm" == *.safetensors ]] && command -v python3 >/dev/null 2>&1; then
    python3 - "$f" <<'PY' 2>/dev/null
import struct, sys, os, json
p = sys.argv[1]
try:
    total = os.path.getsize(p)
    with open(p, "rb") as fh:
        n = struct.unpack("<Q", fh.read(8))[0]
        if not (0 < n < 100_000_000):
            sys.exit(1)
        hdr = json.loads(fh.read(n))
    end = max((v["data_offsets"][1] for k, v in hdr.items()
               if isinstance(v, dict) and "data_offsets" in v), default=0)
    sys.exit(0 if total >= 8 + n + end else 1)
except Exception:
    sys.exit(1)
PY
    return $?
  fi
  [[ "$(head -c1 "$f" 2>/dev/null)" == "<" ]] && return 1   # non-safetensors: reject HTML
  return 0
}

# ── Point ComfyUI's default model dirs at the LOCAL disk via symlink ────────
# ComfyUI always scans $COMFYUI_DIR/models/<type>; making each of those a symlink
# to $MODELS_DIR/<type> (local NVMe) means model DATA reads hit local disk while
# the symlink itself is a trivial stat. Race-free (the registered path string is
# unchanged, so ComfyUI just rescans and sees the files) and idempotent — runs
# every boot. Covers exactly the model types referenced by the active manifest.
link_local_models() {
  local def sub f subs
  # Top-level model type only when path is nested (ultralytics/bbox → ultralytics),
  # so ComfyUI still sees models/ultralytics as a real tree with bbox/ under it.
  # For flat types (checkpoints, upscale_models) the whole dir is the symlink.
  # LINK_EXTRA_MODELS: dirs of files fetched later (the video add-ons) must be
  # linked now, or ComfyUI never looks where they land.
  subs=$(awk -F'|' '!/^[[:space:]]*#/ && NF>=2 {gsub(/[[:space:]]/,"",$1); if($1!="") print $1}' <<<"$MODELS"$'\n'"${LINK_EXTRA_MODELS:-}" | sort -u)
  mkdir -p "$COMFYUI_DIR/models"
  for sub in $subs; do
    mkdir -p "$MODELS_DIR/$sub"
    def="$COMFYUI_DIR/models/$sub"
    mkdir -p "$(dirname "$def")"   # nested: models/ultralytics before .../bbox
    if [[ -L "$def" && "$(readlink -f "$def" 2>/dev/null)" == "$(readlink -f "$MODELS_DIR/$sub" 2>/dev/null)" ]]; then
      log "link  models/$sub -> $MODELS_DIR/$sub (ok)"; continue
    fi
    if [[ -d "$def" && ! -L "$def" ]]; then   # default real dir from the image — migrate stray files, then replace
      shopt -s nullglob dotglob
      for f in "$def"/*; do mv -f "$f" "$MODELS_DIR/$sub/" 2>/dev/null || true; done
      shopt -u nullglob dotglob
    fi
    rm -rf "$def"
    ln -s "$MODELS_DIR/$sub" "$def"
    log "link  models/$sub -> $MODELS_DIR/$sub"
  done
}

# ── Custom nodes for ArtSnack Enhance (Face Fix uses Impact Pack) ──────────
# Idempotent: clone if missing, soft-update if present, install requirements once.
# Nodes land on the network volume under ComfyUI (survive Stop if /workspace does).

# ComfyUI runs out of its own venv — /start.sh builds .venv-cu128 with
# --system-site-packages. A bare `python3` here is /usr/bin/python3, whose
# site-packages sit on the EPHEMERAL container disk: an install there appears to
# work, then vanishes the next time the pod is stopped. Resolve the venv instead,
# so node deps land on /workspace next to the nodes themselves.
comfy_python() {
  local p
  for p in "$COMFYUI_DIR"/.venv*/bin/python; do
    [[ -x "$p" ]] && { printf '%s\n' "$p"; return 0; }
  done
  printf 'python3\n'
}

# An executable .venv/bin/python is NOT a usable one.
#
# This script and /start.sh run concurrently, and /start.sh creates the venv
# binary long before it finishes filling it. Waiting only for main.py to exist
# is not enough: on one pod the node install ran at 21:35:54 against a
# venv that had neither pip nor torch yet, `pip install` died with "No module
# named pip", install.py died with "No module named torchvision", and ultralytics
# was never installed — so ComfyUI came up at 21:42 with no FaceDetailer and no
# UltralyticsDetectorProvider, and every Face Fix answered "Enhancement failed".
# Nothing in the log said the pod was broken; both failures are logged as
# warnings and provisioning reported "Done".
#
# So wait for the interpreter to be able to do the job before handing it the job.
# Returns non-zero if it never becomes usable, and the caller skips rather than
# installing into a half-built environment.
wait_for_comfy_python() {
  local py deadline=$(( SECONDS + ${PROVISION_VENV_TIMEOUT:-900} ))
  while (( SECONDS < deadline )); do
    py="$(comfy_python)"
    if [[ "$py" != "python3" ]] \
       && "$py" -c 'import pip, torch, torchvision' >/dev/null 2>&1; then
      log "venv  ready: $py"
      return 0
    fi
    sleep 5
  done
  log "venv  WARNING: no usable ComfyUI venv after ${PROVISION_VENV_TIMEOUT:-900}s — skipping node deps"
  return 1
}

# ultralytics and sam2 declare a loose `torch>=x`, and pip is free to satisfy it
# by REPLACING the image's torch 2.11.0+cu128 with a stock PyPI wheel — which
# does not fail here, it fails at the next boot with CUDA gone. Pinning the
# torch family to whatever is already installed makes pip leave it alone.
torch_constraints() {
  local py="$1" out="/tmp/provision-torch-constraints.txt"
  "$py" -m pip freeze 2>/dev/null \
    | grep -iE '^(torch|torchvision|torchaudio|torchsde|triton|numpy)==' > "$out" 2>/dev/null
  printf '%s\n' "$out"
}

# ── ArtSnack downloader — pulls the app's own models onto THIS pod ─────────
# A ~150-line custom node whose only job is two HTTP routes on ComfyUI's own
# server (so no extra port and no template change): POST /artsnack/download
# takes a validated {dir,url,filename} order (on a video pod, provision.sh
# queues the app's manifest rows through it after ready) and fetches it with
# the same aria2c strategy fetch() uses below; GET /artsnack/status reports job
# progress and disk space, which the app polls. Secret-gated with POD_URL_SECRET because
# the RunPod proxy makes every ComfyUI route public. Written wholesale at every
# boot, so the published script stays the single source of truth for its code; needs no pip
# deps, so it does not wait for the venv.
# Must equal NODE_VERSION inside the heredoc below — bump both together.
# maybe_restart_comfyui compares this against what the RUNNING node reports,
# because this file is rewritten every run but ComfyUI only imports at startup.
ARTSNACK_NODE_VERSION=7

install_artsnack_downloader() {
  local dest="$COMFYUI_DIR/custom_nodes/artsnack-downloader"
  mkdir -p "$dest"
  cat > "$dest/__init__.py" <<'ARTSNACK_NODE_PY'
"""ArtSnack downloader -- HTTP routes on ComfyUI's own aiohttp server.

Written by provision.sh at every pod boot; do not edit on the pod. A caller
holding POD_URL_SECRET POSTs a download order here, and the node re-validates
everything because this port is public through the RunPod proxy: directory
allowlist, filename shape, https + host allowlist. HF_TOKEN never travels --
it is read from the pod's own env.
"""

import hmac
import json
import os
import re
import shutil
import struct
import subprocess
import threading
import time
import urllib.parse
import urllib.request

from aiohttp import web

import folder_paths
from server import PromptServer

# Bumped on every behavioural change, and reported by /artsnack/status:
# provision.sh compares it against ARTSNACK_NODE_VERSION to know whether the
# RUNNING node matches the file it just wrote (ComfyUI only imports at start).
NODE_VERSION = 7

SECRET = os.environ.get("POD_URL_SECRET", "")
HF_TOKEN = os.environ.get("HF_TOKEN", "")
BACKEND_ID = os.environ.get("ARTSNACK_BACKEND_ID", "")
# "image" or "video" -- reported by /status so the app can refuse to send an H3
# checkpoint to an SDXL pod or the other way round.
PROFILE = "video" if os.environ.get("ARTSNACK_PROFILE") == "video" else "image"
# Some CDNs answer 403 to urllib's default "Python-urllib/3.x" user agent
# (curl passes, which is why the boot-time bash downloads never hit this).
# Anything honest but non-python works.
USER_AGENT = "artsnack-downloader/%d" % NODE_VERSION
# diffusion_models holds UNet-only checkpoints (MiniMax H3 and other DiTs):
# their text encoder and VAE are separate files, so they are not loadable by
# CheckpointLoaderSimple and must not land in checkpoints/.
ALLOWED_DIRS = ("checkpoints", "loras", "diffusion_models")
ALLOWED_HOSTS = ("huggingface.co",)
# Same grammar as sanitizePodFilename in packages/shared/pod-model-downloads.ts.
# Used with fullmatch, not match: Python's $ would accept a trailing newline
# that the JS pattern rejects, and the two must agree.
FILENAME_RE = re.compile(r"[A-Za-z0-9_][][A-Za-z0-9 ._()-]{0,190}\.(safetensors|ckpt|pt)")
# Headroom beyond the file itself, so a download can never run the disk to zero.
DISK_HEADROOM_BYTES = 2_000_000_000
# One user, one NIC: more parallel multi-connection downloads only slow each
# other down, and the disk precheck cannot see unbounded in-flight jobs.
MAX_CONCURRENT_JOBS = 3

_jobs = {}
_lock = threading.Lock()


def _denied(request):
    """None if the request may proceed, else the error response to return."""
    if not SECRET:
        return web.json_response(
            {"error": "downloader disabled: POD_URL_SECRET is not set on this pod"}, status=503
        )
    supplied = request.headers.get("x-artsnack-secret", "")
    if not hmac.compare_digest(supplied, SECRET):
        return web.json_response({"error": "unauthorized"}, status=401)
    return None


def _dest_dir(dir_key):
    # First registered path == the models/<dir> symlink onto the local NVMe.
    return folder_paths.get_folder_paths(dir_key)[0]


def _size(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _complete(path, name):
    """True for a whole, valid model file -- the same checks as complete() above:
    a .safetensors must be at least as long as its own header declares, anything
    else must merely be >4KB and not an HTML error page."""
    size = _size(path)
    if size < 4096:
        return False
    if name.endswith(".safetensors"):
        try:
            with open(path, "rb") as fh:
                header_len = struct.unpack("<Q", fh.read(8))[0]
                if not 0 < header_len < 100_000_000:
                    return False
                header = json.loads(fh.read(header_len))
            end = max(
                (v["data_offsets"][1] for v in header.values()
                 if isinstance(v, dict) and "data_offsets" in v),
                default=0,
            )
            return size >= 8 + header_len + end
        except Exception:
            return False
    try:
        with open(path, "rb") as fh:
            return fh.read(1) != b"<"
    except OSError:
        return False


def _forget_cached_listings(dir_key):
    """Make the new file visible to /object_info without a ComfyUI restart.
    Newer ComfyUI invalidates by directory mtime on its own; dropping the one
    changed folder from the cache covers older builds at the cost of a single
    rescan of that folder (a blanket clear() would re-walk every model dir
    inside ComfyUI's event loop)."""
    try:
        cache = getattr(folder_paths, "filename_list_cache", None)
        if hasattr(cache, "pop"):
            cache.pop(dir_key, None)
        elif hasattr(cache, "clear"):
            cache.clear()
    except Exception:
        pass


def _discard(part):
    for stale in (part, part + ".aria2"):
        try:
            os.remove(stale)
        except OSError:
            pass


def _allocated(path):
    """Bytes actually on disk, not the file's apparent length — a
    multi-connection download writes at offsets near the end almost
    immediately, so getsize() would pin the progress at ~100% from the first
    second. st_blocks counts real blocks."""
    try:
        return os.stat(path).st_blocks * 512
    except OSError:
        return 0


def _remote_size(url):
    """Length of the file behind url from a one-byte ranged GET (signed CDN
    URLs may refuse HEAD), or None when the server will not say."""
    headers = {"User-Agent": USER_AGENT, "Range": "bytes=0-0"}
    if HF_TOKEN and (urllib.parse.urlparse(url).hostname or "") == "huggingface.co":
        headers["Authorization"] = "Bearer " + HF_TOKEN
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
            total = (response.headers.get("Content-Range") or "").rpartition("/")[2]
            if total.isdigit():
                return int(total)
            length = response.headers.get("Content-Length")
            return int(length) if response.status == 200 and length and length.isdigit() else None
    except Exception:
        return None


def _reserve_disk(job, dest_dir):
    """Orders without a size (the boot-time manifest sends none) learn it here
    and pass the same disk check /artsnack/download applies to sized orders —
    otherwise two 20 GB checkpoints both pass a 2 GB-headroom precheck."""
    with _lock:
        others = 0
        for other in _jobs.values():
            if other is job or other["status"] != "downloading" or not other["expected_bytes"]:
                continue
            others += max(0, other["expected_bytes"] - other["bytes"])
        try:
            free = shutil.disk_usage(dest_dir).free
        except OSError:
            return
        if free < job["expected_bytes"] + others + DISK_HEADROOM_BYTES:
            raise RuntimeError("not enough disk: %.1f GB free" % (free / 1e9))


def _download(job):
    # Everything, including path resolution, inside the try: an exception
    # before it would kill the thread and leave the job "downloading" forever,
    # which also blocks any retry for this filename.
    part = None
    try:
        dest_dir = _dest_dir(job["dir"])
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, job["filename"])
        part = dest + ".part"
        cdn = job["url"]
        if not job["expected_bytes"]:
            size = _remote_size(cdn)
            if size:
                job["expected_bytes"] = size
                _reserve_disk(job, dest_dir)
        ok = False
        if shutil.which("aria2c"):
            hf_header = []
            if HF_TOKEN and (urllib.parse.urlparse(cdn).hostname or "") == "huggingface.co":
                hf_header = ["--header=Authorization: Bearer " + HF_TOKEN]
            process = subprocess.Popen(
                ["aria2c", *hf_header, "-x16", "-s16", "-k1M", "--continue=true",
                 "--user-agent=" + USER_AGENT,
                 "--file-allocation=none",
                 "--auto-file-renaming=false", "--allow-overwrite=true",
                 "--max-tries=5", "--retry-wait=5", "--console-log-level=error",
                 "--summary-interval=0", "--dir", dest_dir,
                 "--out", job["filename"] + ".part", cdn],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            while process.poll() is None:
                job["bytes"] = _allocated(part)
                time.sleep(1)
            ok = process.returncode == 0
        if not ok:
            _discard(part)
            with urllib.request.urlopen(
                    urllib.request.Request(cdn, headers={"User-Agent": USER_AGENT}),
                    timeout=300) as response, \
                    open(part, "wb") as out:
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
                    job["bytes"] = out.tell()
        job["bytes"] = _size(part)
        if not _complete(part, job["filename"]):
            raise RuntimeError("download truncated, gated, or not a model file")
        os.replace(part, dest)
        _forget_cached_listings(job["dir"])
        job["status"] = "done"
    except Exception as err:  # every failure lands in the job for /status to report
        job["status"] = "error"
        job["error"] = str(err)
        if part is not None:
            _discard(part)


def _public(job):
    keys = ("filename", "dir", "status", "bytes", "expected_bytes", "error", "started_at")
    return {key: job[key] for key in keys}


routes = PromptServer.instance.routes


@routes.post("/artsnack/download")
async def artsnack_download(request):
    denied = _denied(request)
    if denied is not None:
        return denied
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    dir_key = body.get("dir")
    url = str(body.get("url", ""))
    filename = str(body.get("filename", ""))
    expected = body.get("expected_bytes")
    if not isinstance(expected, int) or expected <= 0:
        expected = None

    if dir_key not in ALLOWED_DIRS:
        return web.json_response({"error": "dir must be one of %s" % (ALLOWED_DIRS,)}, status=400)
    if not FILENAME_RE.fullmatch(filename) or ".." in filename:
        return web.json_response({"error": "unacceptable filename"}, status=400)
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or (parsed.hostname or "") not in ALLOWED_HOSTS:
        return web.json_response({"error": "url host not allowed"}, status=400)

    dest_dir = _dest_dir(dir_key)
    dest = os.path.join(dest_dir, filename)
    if os.path.exists(dest) and _complete(dest, filename):
        return web.json_response({"status": "exists", "filename": filename})

    key = dir_key + "/" + filename
    with _lock:
        running = _jobs.get(key)
        if running is not None and running["status"] == "downloading":
            return web.json_response({"status": "already_downloading", "job": _public(running)})
        active = [j for j in _jobs.values() if j["status"] == "downloading"]
        if len(active) >= MAX_CONCURRENT_JOBS:
            return web.json_response(
                {"error": "too many downloads in flight — try again in a minute"}, status=429
            )
        # Count what the running jobs still intend to write, or the precheck
        # passes N orders that collectively fill the disk.
        inflight = sum((j["expected_bytes"] or 0) for j in active)
        try:
            free = shutil.disk_usage(dest_dir).free
            if free < (expected or 0) + inflight + DISK_HEADROOM_BYTES:
                return web.json_response(
                    {"error": "not enough disk: %.1f GB free" % (free / 1e9)}, status=507
                )
        except OSError:
            pass
        job = {
            "filename": filename, "dir": dir_key, "url": url, "status": "downloading",
            "bytes": 0, "expected_bytes": expected, "error": None, "started_at": time.time(),
        }
        _jobs[key] = job
        settled = sorted(
            (k for k, v in _jobs.items() if v["status"] != "downloading"),
            key=lambda k: _jobs[k]["started_at"],
        )
        while len(_jobs) > 20 and settled:
            del _jobs[settled.pop(0)]
    threading.Thread(target=_download, args=(job,), daemon=True).start()
    return web.json_response({"status": "started", "job": _public(job)})


@routes.get("/artsnack/status")
async def artsnack_status(request):
    denied = _denied(request)
    if denied is not None:
        return denied
    with _lock:
        jobs = [_public(job) for job in
                sorted(_jobs.values(), key=lambda j: -j["started_at"])]
    disk = None
    try:
        usage = shutil.disk_usage(_dest_dir("loras"))
        disk = {"free_gb": round(usage.free / 1e9, 1), "total_gb": round(usage.total / 1e9, 1)}
    except Exception:
        pass
    return web.json_response({"jobs": jobs, "disk": disk, "version": NODE_VERSION,
                              "backendId": BACKEND_ID, "profile": PROFILE})


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
ARTSNACK_NODE_PY
  log "node  artsnack-downloader — written"
}

install_custom_nodes() {
  local nodes_dir="$COMFYUI_DIR/custom_nodes"
  mkdir -p "$nodes_dir"

  # Clone regardless — that needs no interpreter — but do not touch pip until
  # /start.sh has finished building the venv.
  local venv_ready=0
  wait_for_comfy_python && venv_ready=1

  install_one_node() {
    local repo="$1" name="$2"
    local dest="$nodes_dir/$name"
    if [[ -d "$dest/.git" ]]; then
      log "node  $name — present, pulling"
      git -C "$dest" pull --ff-only --depth 1 2>/dev/null || log "node  $name — pull skipped (ok if offline)"
    elif [[ -d "$dest" ]]; then
      log "node  $name — directory exists without .git, leaving as-is"
    else
      log "node  $name — cloning $repo"
      if ! git clone --depth 1 "$repo" "$dest" 2>/dev/null; then
        log "node  $name — CLONE FAILED"
        return 1
      fi
    fi
    if (( ! venv_ready )); then
      log "node  $name — cloned, but deps SKIPPED (no usable venv); Face Fix will be missing"
      return 0
    fi

    local py cons
    py="$(comfy_python)"
    cons="$(torch_constraints "$py")"

    # install.py and requirements.txt are NOT alternatives — treating them as
    # either/or is what silently broke Face Fix on every pod. Impact-Subpack
    # ships both, its install.py only downloads YOLO weights, and `ultralytics`
    # lives in requirements.txt; Impact-Pack is the same story with `scikit-image`.
    # With the old `elif`, neither requirements file was ever installed, so both
    # nodes hit IMPORT FAILED and FaceDetailer never reached the node registry.
    # Requirements go first, because install.py imports them.
    if [[ -f "$dest/requirements.txt" ]]; then
      log "node  $name — pip requirements ($py)"
      # sam2 is pulled from git, builds slowly, and is not needed for FaceDetailer
      # (its SAM input is optional) — skip it rather than let it fail the file.
      grep -v '^git+' "$dest/requirements.txt" > /tmp/provision-req-"$name".txt
      "$py" -m pip install -q -r /tmp/provision-req-"$name".txt -c "$cons" \
        >/tmp/provision-node-"$name"-pip.log 2>&1 \
        || log "node  $name — pip warned (see /tmp/provision-node-$name-pip.log)"
    fi
    if [[ -f "$dest/install.py" ]]; then
      log "node  $name — install.py"
      (cd "$dest" && "$py" install.py) >/tmp/provision-node-"$name".log 2>&1 \
        || log "node  $name — install.py warned (see /tmp/provision-node-$name.log)"
    fi
    return 0
  }

  if [[ "$PROFILE" == "video" ]]; then
    # H3 runs on core nodes; Face Fix belongs to the image pod. The one custom
    # node is the latent upscaler, pinned to a reviewed commit, not a branch.
    log "node  Impact Pack — skipped (video profile)"
    local lbh="$nodes_dir/Comfyui_Minimax_h3_latent_Upscaler"
    if [[ "$(git -C "$lbh" rev-parse HEAD 2>/dev/null)" != "$LBH_UPSCALER_SHA" ]]; then
      rm -rf "$lbh"
      if git init -q "$lbh" && git -C "$lbh" remote add origin "$LBH_UPSCALER_REPO" \
        && git -C "$lbh" fetch -q --depth 1 origin "$LBH_UPSCALER_SHA" \
        && git -C "$lbh" checkout -q FETCH_HEAD; then
        log "node  H3 latent upscaler — $LBH_UPSCALER_SHA"
      else
        log "node  H3 latent upscaler — CLONE FAILED (the Upscale option stays off)"
        rm -rf "$lbh"
      fi
    else
      log "node  H3 latent upscaler — present"
    fi
  else
    install_one_node "https://github.com/ltdrdata/ComfyUI-Impact-Pack.git" "ComfyUI-Impact-Pack"
    install_one_node "https://github.com/ltdrdata/ComfyUI-Impact-Subpack.git" "ComfyUI-Impact-Subpack"
  fi
  install_artsnack_downloader
  log "node  custom nodes done"
}

# ── Video profile: move ComfyUI to the pinned release ───────────────────────
# runpod/comfyui:1.4.1 ships ComfyUI 0.18.2, which has no MiniMax H3 nodes at
# all. Measured on 2026-10-11: checkout + `pip install -r requirements.txt`
# takes about a minute and keeps the image's torch 2.11+cu130 (the constraints
# file stops pip from swapping it). The running process keeps the old code
# until restart_comfyui, which the video flow does once the base set is in.
update_comfyui() {
  local py cons current
  current="$(git -C "$COMFYUI_DIR" describe --tags --exact-match 2>/dev/null || echo unknown)"
  if [[ "$current" == "$VIDEO_COMFYUI_REF" ]]; then
    log "comfy already at $VIDEO_COMFYUI_REF"
    return 0
  fi
  log "comfy updating $current -> $VIDEO_COMFYUI_REF"
  local fetched=0
  for _ in 1 2 3 4 5; do
    git -C "$COMFYUI_DIR" fetch --tags --force -q origin 2>/dev/null && { fetched=1; break; }
    sleep 5   # pod DNS is flaky in the first minute (seen on the 2026-10-11 spike)
  done
  if (( ! fetched )) || ! git -C "$COMFYUI_DIR" -c advice.detachedHead=false checkout -q "$VIDEO_COMFYUI_REF"; then
    log "comfy UPDATE FAILED — H3 nodes will be missing"
    return 1
  fi
  wait_for_comfy_python || return 1
  py="$(comfy_python)"
  cons="$(torch_constraints "$py")"
  "$py" -m pip install -q -r "$COMFYUI_DIR/requirements.txt" -c "$cons" \
    >/tmp/provision-comfy-requirements.log 2>&1 \
    || log "comfy pip warned (see /tmp/provision-comfy-requirements.log)"
  log "comfy now at $(git -C "$COMFYUI_DIR" describe --tags 2>/dev/null)"
}

# ── Restart ComfyUI so freshly installed nodes actually register ───────────
# This script runs in the background while /start.sh brings ComfyUI up, so on a
# cold pod ComfyUI is already serving by the time the nodes finish installing —
# and ComfyUI only scans custom_nodes at startup. Without a restart the pod comes
# up with Face Fix missing every single time.
#
# /start.sh launches ComfyUI once and then `wait`s on it; it does NOT respawn.
# So a bare kill leaves the container alive with no ComfyUI at all — this has to
# relaunch it, detached, with the same args /start.sh assembles.
restart_comfyui() {
  local py args args_file custom
  py="$(comfy_python)"
  args_file="$(dirname "$COMFYUI_DIR")/comfyui_args.txt"
  args="--listen 0.0.0.0 --port $COMFYUI_PORT --enable-cors-header"
  # A multi-GPU video pod runs one ComfyUI per GPU (start_gpu_instances); this
  # one is GPU 0's and must not reach for the others' memory.
  (( GPU_COUNT > 1 )) && [[ "$PROFILE" == "video" ]] && args="$args --cuda-device 0"
  if [[ -s "$args_file" ]]; then
    custom="$(grep -v '^#' "$args_file" | tr '\n' ' ')"
    [[ -n "${custom// /}" ]] && args="$args $custom"
  fi

  log "restart ComfyUI ($args)"
  pkill -f "main.py --listen" 2>/dev/null
  for _ in $(seq 1 30); do pgrep -f "main.py --listen" >/dev/null || break; sleep 1; done
  pkill -9 -f "main.py --listen" 2>/dev/null

  # setsid+nohup so it outlives this script; log to the volume so a failed start
  # is diagnosable after the fact instead of only in the docker pipe.
  (cd "$COMFYUI_DIR" && setsid nohup "$py" main.py $args >/workspace/comfyui.log 2>&1 </dev/null &)

  for _ in $(seq 1 90); do
    curl -sf -o /dev/null --max-time 5 "$LOCAL_COMFYUI_URL/system_stats" 2>/dev/null \
      && { log "restart ComfyUI — up"; return 0; }
    sleep 2
  done
  log "restart ComfyUI — WARNING: no response after 180s, see /workspace/comfyui.log"
}

# Video pods with several GPUs: ComfyUI runs one prompt at a time, so each
# extra GPU gets its own ComfyUI on 8200+i (the app's launch exposes those
# ports and sends every new clip to the least busy one). They share the models,
# custom nodes, input and output folders; temp and user dirs are their own, as
# ComfyUI empties temp at startup and keeps a SQLite file in the user dir.
EXTRA_GPU_PORT_BASE=8200
start_gpu_instances() {
  [[ "$PROFILE" == "video" ]] && (( GPU_COUNT > 1 )) || return 0
  local py args_file custom i port dir up
  py="$(comfy_python)"
  args_file="$(dirname "$COMFYUI_DIR")/comfyui_args.txt"
  custom=""
  [[ -s "$args_file" ]] && custom="$(grep -v '^#' "$args_file" | tr '\n' ' ')"
  for (( i = 1; i < GPU_COUNT; i++ )); do
    port=$((EXTRA_GPU_PORT_BASE + i))
    dir="/workspace/comfyui-gpu$i"
    mkdir -p "$dir/user"
    log "start ComfyUI for GPU $i on :$port"
    (cd "$COMFYUI_DIR" && setsid nohup "$py" main.py --listen 0.0.0.0 --port "$port" \
      --enable-cors-header --cuda-device "$i" --temp-directory "$dir" --user-directory "$dir/user" \
      $custom >"/workspace/comfyui-gpu$i.log" 2>&1 </dev/null &)
  done
  for (( i = 1; i < GPU_COUNT; i++ )); do
    port=$((EXTRA_GPU_PORT_BASE + i))
    up=0
    for _ in $(seq 1 90); do
      curl -sf -o /dev/null --max-time 5 "http://127.0.0.1:$port/system_stats" 2>/dev/null && { up=1; break; }
      sleep 2
    done
    if (( up )); then
      log "ComfyUI GPU $i — up"
    else
      log "ComfyUI GPU $i — WARNING: no response, see /workspace/comfyui-gpu$i.log"
      PROVISION_WARNINGS+=("GPU $i ComfyUI did not start")
    fi
  done
}

# Restart only when the Impact nodes are genuinely absent from the running
# ComfyUI, so re-running this script against a live pod is a no-op rather than
# an outage. If ComfyUI is unreachable it is still starting — it will pick the
# nodes up on its own, and killing it here would race /start.sh.
maybe_restart_comfyui() {
  local body="/tmp/provision-object-info.json"
  if [[ "${FORCE_COMFYUI_RESTART:-0}" == "1" ]]; then
    log "restart ComfyUI — forced by provider configuration"
    restart_comfyui
    return $?
  fi
  if ! curl -sf --max-time 20 "$LOCAL_COMFYUI_URL/object_info" -o "$body" 2>/dev/null; then
    log "restart ComfyUI — skipped (not reachable yet; its own startup will load the nodes)"
    return 0
  fi
  if grep -q '"FaceDetailer"' "$body" && grep -q '"UltralyticsDetectorProvider"' "$body"; then
    # Impact nodes are in — but the /artsnack routes only exist if ComfyUI
    # started after install_artsnack_downloader wrote the node. 404 means it
    # did not; 200/401/503 mean the routes are live; 000 means curl itself
    # failed (busy event loop, timeout) and proves nothing either way — same
    # deliberate fail-direction as the /object_info probe above.
    #
    # In enhance mode the downloader is not worth an outage: `provision.sh
    # enhance` is the documented live-pod repair path and must stay a no-op
    # for a healthy pod, so a missing downloader is logged, not restarted into.
    local code reason=""
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$LOCAL_COMFYUI_URL/artsnack/status" 2>/dev/null)
    [[ "$code" == "404" ]] && reason="downloader routes not registered"
    # 503 = routes live but the node holds no secret: ComfyUI was started from
    # an env-less shell. If WE have the secret (adopted from PID 1 at the top
    # of this script), a restart repairs it; if the template genuinely lacks
    # it, a restart cannot help and would repeat every run — so don't.
    [[ "$code" == "503" && -n "${POD_URL_SECRET:-}" ]] && reason="downloader disabled — ComfyUI runs without POD_URL_SECRET"
    # Routes live and healthy (401 = unauthenticated probe rejected, as it
    # should be): ask, authenticated, WHICH version is running. The file on
    # disk is always current — the process may not be, and a stale node keeps
    # serving old bugs while everything looks registered.
    if [[ -z "$reason" && "$code" == "401" && -n "${POD_URL_SECRET:-}" ]]; then
      local ver
      ver=$(curl -s --max-time 10 -H "x-artsnack-secret: ${POD_URL_SECRET}" "$LOCAL_COMFYUI_URL/artsnack/status" 2>/dev/null \
            | grep -o '"version": *[0-9]*' | grep -o '[0-9]*$' || true)
      [[ "$ver" != "$ARTSNACK_NODE_VERSION" ]] && reason="downloader is v${ver:-1}, current is v$ARTSNACK_NODE_VERSION"
    fi
    if [[ -n "$reason" ]]; then
      if (( ENHANCE_ONLY )); then
        log "restart ComfyUI — $reason, but enhance mode never restarts a live pod; run 'bash /provision.sh' for that"
        return 0
      fi
      log "restart ComfyUI — needed ($reason)"
      restart_comfyui
      return $?
    fi
    if [[ "$code" == "000" || -z "$code" ]]; then
      log "restart ComfyUI — downloader state unknown (no answer in 20s); leaving ComfyUI alone"
      return 0
    fi
    log "restart ComfyUI — not needed (Impact nodes + downloader registered)"
    return 0
  fi
  restart_comfyui
}

# ── Point the Artsnack app at THIS pod by setting the Convex env var ───────
# The app reads NEXT_PUBLIC_COMFYUI_URL from Convex at RUNTIME (generation + the
# /api/{models,loras,unets} routes via a Convex action), so setting it here is
# enough — NO Vercel rebuild needed. Best-effort, backgrounded. Needs
# CONVEX_DEPLOY_KEY in the env. Idempotent via a marker. On failure, fall back
# to `bun run pod:url <url>` locally.
URL_VAR="${URL_VAR:-NEXT_PUBLIC_COMFYUI_URL}"
register_app_url() {
  local pod_url="${COMFYUI_PUBLIC_URL:-}"
  [[ -z "$pod_url" && -n "${RUNPOD_POD_ID:-}" ]] && pod_url="https://${RUNPOD_POD_ID}-8188.proxy.runpod.net"
  pod_url="${pod_url%/}"   # strip trailing slash -> never build `${url}//object_info`
  [[ -z "$pod_url" ]] && { log "wire: no pod URL (RUNPOD_POD_ID unset) — skip"; return 0; }

  if [[ -z "${CONVEX_DEPLOY_KEY:-}" ]]; then
    log "wire: no CONVEX_DEPLOY_KEY — skip app wiring"; return 0
  fi
  local marker="/workspace/.comfyui-url-registered"
  if [[ -f "$marker" && "$(cat "$marker" 2>/dev/null)" == "$pod_url" ]]; then
    log "wire: $pod_url already registered — skip"; return 0
  fi

  log "wire: pointing app at $pod_url"
  local ok=1

  # Convex prod — runtime env, takes effect immediately (no deploy)
  if [[ -n "${CONVEX_DEPLOY_KEY:-}" ]]; then
    local cvx="${CONVEX_DEPLOY_KEY#*:}"; cvx="${cvx%%|*}"   # prod:NAME|secret -> NAME
    if curl -fsS --max-time 30 -X POST "https://${cvx}.convex.cloud/api/update_environment_variables" \
         -H "Authorization: Convex ${CONVEX_DEPLOY_KEY}" -H "Content-Type: application/json" \
         -H "Convex-Client: pod-provision" \
         -d "{\"changes\":[{\"name\":\"${URL_VAR}\",\"value\":\"${pod_url}\"}]}" >/dev/null 2>&1; then
      log "wire: Convex prod ✓"
    else log "wire: Convex prod FAILED"; ok=0; fi
  fi

  if (( ok )); then
    echo "$pod_url" > "$marker" 2>/dev/null || true
    log "wire: done ✓ — app now points at this pod"
  else
    log "wire: finished WITH ERRORS — app may still point at the old pod. Fallback: 'bun run pod:url $pod_url'"
  fi
}

# Subcommands (optional first arg):
#   register — only (re)point the app at this pod
#   enhance  — only Impact Pack + 4x-UltraSharp + face_yolov8m (live pod, no full re-download)
#   (none)   — full provision: nodes + whole model manifest + register
if [[ "${1:-}" == "register" ]]; then register_app_url; exit $?; fi

# Enhance-only subset (duplicated in the full MANIFEST for cold starts).
read -r -d '' ENHANCE_MODELS <<'ENHANCE_MANIFEST' || true
upscale_models|https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.pth|4x-UltraSharp.pth
ultralytics/bbox|https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov8m.pt|face_yolov8m.pt
ultralytics/bbox|https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov9c.pt|face_yolov9c.pt
ultralytics/segm|https://huggingface.co/Anzhc/Anzhcs_YOLOs/resolve/main/Anzhc%20Eyes%20-seg-hd.pt|Anzhc_Eyes_seg_hd.pt
ENHANCE_MANIFEST

# ── Video profile base set — the files every H3 workflow needs ─────────────
# Filenames are a contract with packages/shared/h3-video.ts, which names them in
# the graph. The text encoder is saved under a neutral name because which
# quantisation we fetch depends on the GPU (see pick_h3_text_encoder below).
# Hugging Face serves these at ~250 MB/s, so the whole set is about two minutes.
H3_HF="https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main"
read -r -d '' VIDEO_MODELS <<VIDEO_MANIFEST || true
diffusion_models|${H3_HF}/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors|minimax_h3_fl2va_pruned_int8_convrot.safetensors
diffusion_models|${H3_HF}/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors|minimax_h3_ref2va_pruned_int8_convrot.safetensors
vae|${H3_HF}/vae/minimax_h3_video_vae_fp16.safetensors|minimax_h3_video_vae_fp16.safetensors
vae|${H3_HF}/vae/minimax_h3_audio_vae_fp32.safetensors|minimax_h3_audio_vae_fp32.safetensors
loras|${H3_HF}/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors|minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
loras|${H3_HF}/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors|minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors
frame_interpolation|https://huggingface.co/Comfy-Org/frame_interpolation/resolve/main/frame_interpolation/rife_v4.26.safetensors|rife_v4.26.safetensors
latent_upscale_models|https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler/resolve/main/minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors|minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors
VIDEO_MANIFEST

# The last two lines above back the app's "Community" options (H3_EXTRA_FILES in
# packages/shared/h3-video.ts): Comfy-Org's RIFE 4.26 for ComfyUI's built-in
# FrameInterpolate (48 fps), and LBH-123's 3D latent upscaler (MIT) for the
# custom node pinned below. Small, so they ride with the boot set — and they
# must: that node lists its models once, when ComfyUI starts.
#
# ── Video profile sets fetched AFTER ready, in this order ────────────────────
# Big and optional, so the pod reports ready on the H3 base set alone and the
# app greys each option out until its files are listed (core loaders rescan).
#  1. LTX 2.3 base — a contract with LTX_BASE_FILES in packages/shared/ltx-video.ts:
#     Gemma 3 12B fp8 + LTX 2.3 text projection, Kijai's split VAEs, Lightricks'
#     2× spatial upscaler, the official distilled transformer in fp8 (not int8:
#     B300-class GPUs run int8 several times slower) and Lightricks' gated
#     Ingredients IC-LoRA. ~45 GB. Any other LTX checkpoints and LoRAs come
#     from the app's manifest (podModels rows).
#  2. H3_EXTRA_MODELS — on B300-class GPUs only, the fp8 H3 builds (below).
read -r -d '' LTX_MODELS <<'LTX_MANIFEST' || true
text_encoders|https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp8_scaled.safetensors|gemma_3_12B_it_fp8_scaled.safetensors
text_encoders|https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/text_encoders/ltx-2.3_text_projection_bf16.safetensors|ltx-2.3_text_projection_bf16.safetensors
vae|https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/vae/LTX23_video_vae_bf16.safetensors|LTX23_video_vae_bf16.safetensors
vae|https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/vae/LTX23_audio_vae_bf16.safetensors|LTX23_audio_vae_bf16.safetensors
latent_upscale_models|https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors|ltx-2.3-spatial-upscaler-x2-1.1.safetensors
loras|https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients/resolve/main/ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors|ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors
diffusion_models|https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/diffusion_models/ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors|ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors
LTX_MANIFEST
# Lightricks' Ingredients IC-LoRA (Reference sheet mode) is gated: anonymous
# downloads get a 401, so without HF_TOKEN — from an account that accepted the
# LTX-2 Community License — skip it rather than log a failure every boot.
[[ -z "${HF_TOKEN:-}" ]] && LTX_MODELS=$(grep -v 'IC-LoRA-Ingredients' <<<"$LTX_MODELS")
H3_EXTRA_MODELS=""
# B300 (Blackwell Ultra) has almost no INT8 throughput: the official int8 H3
# builds ran 207 s where fp8 ran 54 s (2026-10-12). On such a GPU also fetch
# the fp8 builds, first, so the form can offer them.
if nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | grep -qi "B300"; then
  H3_EXTRA_MODELS="diffusion_models|${H3_HF}/diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors|minimax_h3_fl2va_pruned_fp8_scaled.safetensors
diffusion_models|${H3_HF}/diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors|minimax_h3_ref2va_pruned_fp8_scaled.safetensors
$H3_EXTRA_MODELS"
fi
LBH_UPSCALER_REPO="https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git"
LBH_UPSCALER_SHA="40316cf008b2fd8663263270669eb4da23f89d2c"   # reviewed 2026-10-12: no network, no subprocess

# nvfp4 (15.7 GB) runs natively only on Blackwell (compute capability >= 10);
# everything older gets the int8 build (27 GB). Either way the file is saved as
# minimax_h3_text_encoder.safetensors so the workflow never has to know.
pick_h3_text_encoder() {
  local cc
  cc=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | cut -d. -f1)
  if [[ "${cc:-0}" =~ ^[0-9]+$ ]] && (( cc >= 10 )); then
    printf 'text_encoders|%s/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors|minimax_h3_text_encoder.safetensors\n' "$H3_HF"
  else
    printf 'text_encoders|%s/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors|minimax_h3_text_encoder.safetensors\n' "$H3_HF"
  fi
}

# ── Model manifest:  dir | download url | output filename ──────────────────
read -r -d '' MODELS <<'MANIFEST'
# ── Checkpoints — ACTIVE (add a line per checkpoint you want on every pod) ──
# Stability AI's official SDXL 1.0 base (CreativeML Open RAIL++-M). It is also
# the Enhance / Face Fix fallback (FACE_FIX_FALLBACK_CHECKPOINT in
# packages/shared/enhance-workflows.ts) — rename both together.
checkpoints|https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors|sd_xl_base_1.0.safetensors
# ── LoRA + embeddings — ACTIVE (add a line per LoRA you want on every pod) ──
# Latent Consistency's official LCM-LoRA for SDXL: 4–8 step generations.
loras|https://huggingface.co/latent-consistency/lcm-lora-sdxl/resolve/main/pytorch_lora_weights.safetensors|lcm-lora-sdxl.safetensors
# ── Enhance (ArtSnack) — HuggingFace direct ──
# Upscale mode hardcodes 4x-UltraSharp.pth (built-in UpscaleModelLoader).
upscale_models|https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.pth|4x-UltraSharp.pth
#
# ── Face Fix detectors ─────────────────────────────────────────────────────
# Every one of these is named by path in packages/shared/enhance-workflows.ts,
# reached as UltralyticsDetectorProvider's model_name — the directory here is the
# first path segment, so `ultralytics/bbox` + `face_yolov9c.pt` is the string
# "bbox/face_yolov9c.pt" in the graph. Dropping one does not degrade Face Fix; it
# fails the whole job on the next cold pod.
#
# face_yolov8m — YOLOv8-M face detection. The original default: finds the
#   rectangle each face sits in. Still selectable in the UI as "Fast".
ultralytics/bbox|https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov8m.pt|face_yolov8m.pt
# face_yolov9c — YOLOv9-C face detection, the current default ("Accurate").
#   Same job, better recall on small, profile and partly-occluded faces, which
#   are exactly the ones that most need repairing.
ultralytics/bbox|https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov9c.pt|face_yolov9c.pt
# Anzhc Eyes seg — eye segmentation, for the optional second pass that
#   re-renders the eyes alone at high resolution. Off by default.
ultralytics/segm|https://huggingface.co/Anzhc/Anzhcs_YOLOs/resolve/main/Anzhc%20Eyes%20-seg-hd.pt|Anzhc_Eyes_seg_hd.pt
# person_yolov8m-seg — nothing in the app selects it. It ships in the base image
#   under models/ultralytics/segm, and listing it here is what keeps it after
#   that directory became a symlink onto the container disk for the two above.
ultralytics/segm|https://huggingface.co/Bingsu/adetailer/resolve/main/person_yolov8m-seg.pt|person_yolov8m-seg.pt
MANIFEST

[[ -n "${EXTRA_MODELS:-}" ]] && MODELS+=$'\n'"$EXTRA_MODELS"

# ── Models unchecked in the app's launch dialog ────────────────────────────
# ARTSNACK_SKIP_MODELS_B64, set by the launch actions, is base64 of one
# "dir|filename" line per model the user left unchecked. Unset — the iOS app,
# a pod started from the RunPod console, every launch from before the dialog —
# means the whole manifest, as always. It is a skip list, not a pick list, so a
# model added to the published script after the dialog opened still downloads. Each caller
# names the directories that are optional for its list, which is what keeps the
# Face Fix detectors and the H3 base set out of reach of any skip list.
# packages/shared/pod-model-selection.ts offers the same lines; change both.
SKIP_MODELS=""
if [[ -n "${ARTSNACK_SKIP_MODELS_B64:-}" ]]; then
  if ! SKIP_MODELS=$(base64 -d <<<"$ARTSNACK_SKIP_MODELS_B64" 2>/dev/null); then
    log "skip: ARTSNACK_SKIP_MODELS_B64 does not decode — downloading everything"
    SKIP_MODELS=""
  fi
fi
# without_skipped DIR_REGEX — stdin, minus each line whose dir matches DIR_REGEX
# and whose dir|filename was unchecked. Logs every omission to stderr (stdout is
# the result), in the same shape as the GET/SKIP/FAIL lines.
without_skipped() {
  if [[ -z "$SKIP_MODELS" ]]; then cat; return 0; fi
  awk -F'|' -v optional="$1" -v ts="$(printf '%(%H:%M:%S)T' -1)" '
    NR == FNR { skip[$0] = 1; next }
    /^[[:space:]]*#/ || NF < 3 { print; next }
    { dir = $1; gsub(/[[:space:]]/, "", dir) }
    dir ~ optional && ((dir "|" $3) in skip) {
      print "[provision " ts "] OMIT  " dir "/" $3 " (unchecked at launch)" > "/dev/stderr"
      next
    }
    { print }
  ' <(printf '%s\n' "$SKIP_MODELS") -
}

# ── Dynamic manifest: models added to the app's own manifest ───────────────
# Rows in Convex's podModels table (written by the internal mutation
# podModels.upsert, e.g. with `npx convex run`) are served by convex/http.ts at
# /pod-manifest in this exact dir|url|filename format. Best-effort and fail-soft: no key, no secret, or a dead endpoint just
# means the static manifest above is all there is — same behaviour as before
# the feature existed. Lines are re-validated here because this string is fed
# to a shell loop that runs downloads; the endpoint is trusted, the transport
# is not the only thing that can go wrong.
fetch_dynamic_manifest() {
  [[ -z "${POD_URL_SECRET:-}" ]] && { log "manifest: no POD_URL_SECRET — static only"; return 0; }
  local site="${CONVEX_SITE_URL:-}"
  if [[ -z "$site" && -n "${CONVEX_DEPLOY_KEY:-}" ]]; then
    local cvx="${CONVEX_DEPLOY_KEY#*:}"; cvx="${cvx%%|*}"   # prod:NAME|secret -> NAME
    site="https://${cvx}.convex.site"
  fi
  [[ -z "$site" ]] && { log "manifest: no CONVEX_SITE_URL or deploy key — static only"; return 0; }
  local body
  if ! body=$(curl -fsS --max-time 30 -H "x-artsnack-pod-secret: ${POD_URL_SECRET}" \
        "${site%/}/pod-manifest?profile=${PROFILE}" 2>/dev/null); then
    log "manifest: dynamic fetch FAILED — static only"
    return 0
  fi
  [[ -z "$body" ]] && { log "manifest: no dynamic entries"; return 0; }
  # Same grammar as the downloader node and sanitizePodFilename: known dir,
  # https URL on an allowed host, single-segment filename with a model-weights
  # extension.
  local clean
  clean=$(grep -E '^(checkpoints|loras|diffusion_models)\|https://huggingface\.co/[^|[:space:]]+\|[A-Za-z0-9_][][A-Za-z0-9 ._()-]{0,190}\.(safetensors|ckpt|pt)$' <<<"$body" | grep -v '\.\.' || true)
  local total kept
  total=$(grep -c . <<<"$body" || true)
  kept=$(grep -c . <<<"$clean" || true)
  if (( kept > 0 )) && [[ "$PROFILE" == "video" ]]; then
    # Not part of the boot download: the pod reports ready on the base set and
    # queue_dynamic_downloads hands these to the downloader node afterwards.
    # The user's own rows, so every one of them may have been unchecked.
    DYNAMIC_MODELS=$(without_skipped '.' <<<"$clean")
    log "manifest: +$kept model(s) from the app, queued for after ready"
  elif (( kept > 0 )); then
    MODELS+=$'\n'"$clean"
    log "manifest: +$kept model(s) from the app"
  else
    log "manifest: no dynamic entries"
  fi
  (( total > kept )) && log "manifest: WARNING — $((total-kept)) dynamic line(s) failed validation, skipped"
  return 0
}

# Point the Artsnack app at this pod (sets Convex env, read at runtime) — backgrounded.
# enhance-only does not re-register (pod is already live). Deliberately BEFORE
# the dynamic-manifest fetch: that curl can block for up to 30s, and every
# second of it is a second the app still points at the previous, dead pod.
if (( ! ENHANCE_ONLY )) && [[ "${ARTSNACK_PROVIDER:-runpod}" == "runpod" ]]; then
  register_app_url &
fi

DYNAMIC_MODELS=""
if (( ENHANCE_ONLY )); then
  MODELS="$ENHANCE_MODELS"
  log "mode: enhance-only (skipping the full manifest)"
else
  if [[ "$PROFILE" == "video" ]]; then
    MODELS="$VIDEO_MODELS"$'\n'"$(pick_h3_text_encoder)"
    log "mode: video profile (MiniMax H3 base set only)"
  fi
  fetch_dynamic_manifest
fi

# One line per dir/filename, first occurrence wins. A dynamic row that repeats
# a static one (the same model re-added from the UI) would otherwise run a
# second concurrent fetch() into the same .part file. Comments and blanks pass
# through untouched — some comments contain "|", hence the leading-# guard.
MODELS=$(awk -F'|' '/^[[:space:]]*#/ || NF < 3 { print; next } !seen[$1 "|" $3]++' <<<"$MODELS")

# Image: checkpoints and LoRAs are optional, the upscaler and detectors are not.
# Video: the base set is required by every graph; the two community add-ons in
# it, the LTX set and the B300 fp8 builds are optional (the app keeps each
# option off until the pod lists its file). The app's own video rows are
# filtered at fetch time.
if [[ "$PROFILE" == "video" ]]; then
  MODELS=$(without_skipped '^(frame_interpolation|latent_upscale_models)$' <<<"$MODELS")
  H3_EXTRA_MODELS=$(without_skipped '.' <<<"$H3_EXTRA_MODELS")
  LTX_MODELS=$(without_skipped '.' <<<"$LTX_MODELS")
else
  MODELS=$(without_skipped '^(checkpoints|loras|diffusion_models)$' <<<"$MODELS")
fi

# ── Wait for the image's /start.sh to lay down ComfyUI first ───────────────
log "Waiting for ComfyUI at $COMFYUI_DIR ..."
report_progress "preparing" 12 "Waiting for the ComfyUI image to initialize…"
for _ in $(seq 1 600); do [[ -f "$COMFYUI_DIR/main.py" ]] && break; sleep 2; done
if [[ ! -f "$COMFYUI_DIR/main.py" ]]; then
  log "ERROR: ComfyUI not found after waiting. Set COMFYUI_DIR correctly. Aborting."
  report_progress "error" 12 "ComfyUI did not initialize before the startup deadline."
  exit 1
fi
log "ComfyUI ready."
[[ "$PROFILE" == "video" ]] && LINK_EXTRA_MODELS="$LTX_MODELS"$'\n'"$H3_EXTRA_MODELS"
link_local_models   # symlink default model dirs onto the local container disk
report_progress "installing" 16 "Installing ComfyUI custom nodes…"
install_custom_nodes  # Impact Pack for Face Fix (idempotent)
if [[ "$PROFILE" == "video" ]]; then
  report_progress "installing" 20 "Updating ComfyUI to $VIDEO_COMFYUI_REF for MiniMax H3…"
  update_comfyui || PROVISION_WARNINGS+=("ComfyUI update failed")
  # `git checkout` restores the tracked models/<dir>/put_*_here placeholders and
  # with them real directories over our symlinks — after which ComfyUI lists
  # only what the downloader writes, and none of the base set (seen on the
  # 2026-10-11 test pod). Re-link; it migrates anything that landed meanwhile.
  link_local_models
fi

# ── Make sure aria2c is available (best effort; falls back to curl) ────────
if ! command -v aria2c >/dev/null 2>&1; then
  log "Installing aria2c..."
  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq aria2 >/dev/null 2>&1
fi
if command -v aria2c >/dev/null 2>&1; then log "aria2c ready (fast multi-connection downloads)"; else log "aria2c unavailable — using curl (slower)"; fi

# ── One download (idempotent + atomic) ─────────────────────────────────────
fetch() {
  local dir="$1" url="$2" name="$3"
  local destdir="$MODELS_DIR/$dir" dest part
  local base out_name
  dest="$MODELS_DIR/$dir/$name"; part="$dest.part"
  mkdir -p "$(dirname "$dest")"   # nested names e.g. bbox/foo.pt under ultralytics

  if [[ -f "$dest" ]]; then
    if complete "$dest" "$name"; then log "SKIP  $dir/$name (exists, $(hsize "$(stat -c%s "$dest")"))"; model_finished "$dir/$name"; return 0; fi
    log "REDO  $dir/$name (incomplete/corrupt — re-downloading)"; rm -f "$dest"
  fi

  log "GET   $dir/$name"
  # Hugging Face throttles anonymous downloads per IP, and a pod shares its
  # datacenter's IP: on 2026-10-11 a 20 GB base file came back as a 10 KB
  # error page. An optional HF_TOKEN lifts that limit.
  local hf_auth=()
  [[ "$url" == https://huggingface.co/* && -n "${HF_TOKEN:-}" ]] && hf_auth=(--header="Authorization: Bearer ${HF_TOKEN}")
  local cdn="$url"

  # aria2 out path: write into destdir; if name has slashes, put relative path under destdir
  base=$(dirname "$name")
  out_name=$(basename "$name").part
  if [[ "$base" != "." ]]; then
    mkdir -p "$destdir/$base"
    # part file next to final dest
    part="$destdir/$base/$(basename "$name").part"
  fi

  local ok=0
  if [[ -n "$cdn" ]] && command -v aria2c >/dev/null 2>&1; then
    # Multi-connection; only a Hugging Face URL gets an auth header (HF_TOKEN).
    local aria_dir="$destdir"
    [[ "$base" != "." ]] && aria_dir="$destdir/$base"
    if aria2c "${hf_auth[@]}" -x"$ARIA_CONNS" -s"$ARIA_CONNS" -k1M --continue=true --auto-file-renaming=false \
         --connect-timeout=15 --timeout=60 --lowest-speed-limit=1K \
         --max-tries=8 --retry-wait=15 --console-log-level=error --summary-interval=0 \
         --dir="$aria_dir" --out="$(basename "$name").part" "$cdn" >/dev/null 2>&1; then ok=1; fi
  fi
  if (( ! ok )); then
    rm -f "$part" "${part}.aria2"   # clear any partial before clean curl retry
    # Bound both a dead connect and a connected socket that stops delivering
    # bytes. Keep curl's exponential backoff (and Retry-After handling) for 429.
    local curl_hf=()
    [[ ${#hf_auth[@]} -gt 0 ]] && curl_hf=(-H "Authorization: Bearer ${HF_TOKEN}")
    if curl -fL --connect-timeout 15 --max-time 1800 --speed-time 90 --speed-limit 1024 \
         --retry 8 --retry-max-time 600 --retry-connrefused \
         "${curl_hf[@]}" "$url" -o "$part" >/dev/null 2>&1; then ok=1; fi
  fi
  rm -f "${part}.aria2"

  if (( ! ok )) || ! complete "$part" "$name"; then
    local sz; sz=$(stat -c%s "$part" 2>/dev/null || echo 0)
    log "FAIL  $dir/$name (ok=$ok size=${sz}B — token/gated/network/truncated?)"; rm -f "$part"; model_finished "$dir/$name" "failed"; return 1
  fi
  mv -f "$part" "$dest"
  log "OK    $dir/$name ($(hsize "$(stat -c%s "$dest")"))"
  model_finished "$dir/$name"
}

# ── Run the manifest with bounded parallelism ──────────────────────────────
log "Downloading into $MODELS_DIR (max $MAX_JOBS files x $ARIA_CONNS conns)"
DOWNLOAD_TOTAL=$(awk -F'|' '!/^[[:space:]]*#/ && NF>=3 {count++} END {print count+0}' <<< "$MODELS")
PROGRESS_DIR="/tmp/artsnack-provision-progress"
rm -rf "$PROGRESS_DIR"; mkdir -p "$PROGRESS_DIR"
model_finished() {
  # The video add-ons download after ready: reporting "downloading" then would
  # knock a ready pod back into provisioning.
  [[ "${QUIET_PROGRESS:-0}" == "1" ]] && return 0
  local label="$1" outcome="${2:-done}" key done percent
  key=$(printf '%s' "$label" | sha256sum | cut -d' ' -f1)
  : > "$PROGRESS_DIR/done-$key"
  if [[ "$outcome" == "failed" ]]; then : > "$PROGRESS_DIR/failed-$key"; else rm -f "$PROGRESS_DIR/failed-$key"; fi
  done=$(find "$PROGRESS_DIR" -type f -name 'done-*' | wc -l)
  if (( DOWNLOAD_TOTAL > 0 )); then percent=$((25 + (done * 55 / DOWNLOAD_TOTAL))); else percent=80; fi
  report_progress "downloading" "$percent" "Downloaded $done of $DOWNLOAD_TOTAL model files: $label"
}
export DOWNLOAD_TOTAL PROGRESS_DIR
report_progress "downloading" 25 "Downloading $DOWNLOAD_TOTAL model files to the local NVMe disk…"
total=0
while IFS='|' read -r dir url name; do
  dir="${dir//[[:space:]]/}"
  [[ -z "$dir" || "$dir" == \#* ]] && continue
  total=$((total+1))
  fetch "$dir" "$url" "$name" &
  while (( $(jobs -rp | wc -l) >= MAX_JOBS )); do wait -n; done
done <<< "$MODELS"
wait

# Video only: one more, slower pass over whatever failed — sequential, after a
# pause — so a Hugging Face rate limit gets a second chance before the pod
# reports a degraded start. Every base file is required, and there are seven.
# Not for the image manifest, where a removed or gated model would spend its
# full curl retry budget a second time before the pod could be used.
# fetch() skips every file that is already complete.
if [[ "$PROFILE" == "video" ]] && (( $(find "$PROGRESS_DIR" -type f -name 'failed-*' | wc -l) > 0 )); then
  log "Retrying failed downloads once, one at a time…"
  sleep 20
  while IFS='|' read -r dir url name; do
    dir="${dir//[[:space:]]/}"
    [[ -z "$dir" || "$dir" == \#* ]] && continue
    [[ -f "$MODELS_DIR/$dir/$name" ]] && continue
    fetch "$dir" "$url" "$name"
  done <<< "$MODELS"
fi

failed=$(find "$PROGRESS_DIR" -type f -name 'failed-*' | wc -l)
if (( failed > 0 )); then
  log "ERROR: $failed of $DOWNLOAD_TOTAL model downloads failed"
  PROVISION_WARNINGS+=("$failed model download(s) failed")
  report_progress "degraded" 82 "$failed of $DOWNLOAD_TOTAL model downloads failed; starting ComfyUI with the models that succeeded."
fi

# Models are on disk and the nodes are installed — now make ComfyUI see both.
# Deliberately last: restarting before the manifest finishes would leave ComfyUI
# with a half-populated checkpoints/loras listing.
if [[ "$PROFILE" == "video" ]]; then
  # Always: the code on disk is the new release, the process is still the old one.
  restart_comfyui
  start_gpu_instances
else
  maybe_restart_comfyui
fi
report_progress "verifying" 88 "Models are ready. Restarting and verifying ComfyUI…"

# Say plainly whether Face Fix works, because every way it breaks is a warning.
#
# A failed `pip install`, a failed install.py and a node that never reached the
# registry are all logged as warnings and the run still ends with "Done" — which
# is how a pod shipped with no FaceDetailer at all and the only symptom anyone
# saw was "Enhancement failed" in the app, hours later. This is the one line
# worth reading in the whole log.
verify_enhance() {
  local body="/tmp/provision-verify.json" missing=()
  if ! curl -sf --max-time 30 "$LOCAL_COMFYUI_URL/object_info" -o "$body" 2>/dev/null; then
    log "VERIFY: ComfyUI unreachable — cannot confirm Face Fix"; return 1
  fi
  grep -q '"FaceDetailer"' "$body" || missing+=("FaceDetailer")
  grep -q '"UltralyticsDetectorProvider"' "$body" || missing+=("UltralyticsDetectorProvider")
  [[ -f "$MODELS_DIR/ultralytics/bbox/face_yolov9c.pt" ]] || missing+=("face_yolov9c.pt")
  [[ -f "$MODELS_DIR/ultralytics/segm/Anzhc_Eyes_seg_hd.pt" ]] || missing+=("Anzhc_Eyes_seg_hd.pt")
  [[ -f "$MODELS_DIR/upscale_models/4x-UltraSharp.pth" ]] || missing+=("4x-UltraSharp.pth")

  # The downloader is not part of Face Fix, so it gets its own line rather
  # than a slot in `missing` — a broken downloader must not read as "Enhance
  # is broken". 404 = routes not registered; anything else is fine or unknowable.
  local dl
  dl=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$LOCAL_COMFYUI_URL/artsnack/status" 2>/dev/null)
  [[ "$dl" == "404" ]] && log "VERIFY: downloader routes NOT registered — the app's download status will fail on this pod"

  if (( ${#missing[@]} )); then
    log "VERIFY: *** ENHANCE IS BROKEN *** missing: ${missing[*]}"
    log "VERIFY: fix with — bash /provision.sh enhance   (then re-run this script)"
    return 1
  fi
  log "VERIFY: Enhance OK — Impact nodes registered, detectors and upscaler on disk"
}
# Video: the H3 nodes exist only on the pinned release, and every base file is
# named by packages/shared/h3-video.ts — a missing one fails every generation.
verify_video() {
  local body="/tmp/provision-verify.json" missing=() f
  if ! curl -sf --max-time 30 "$LOCAL_COMFYUI_URL/object_info" -o "$body" 2>/dev/null; then
    log "VERIFY: ComfyUI unreachable — cannot confirm MiniMax H3"; return 1
  fi
  grep -q '"MiniMaxH3ImageToVideo"' "$body" || missing+=("MiniMaxH3ImageToVideo node")
  grep -q '"MiniMaxH3ReferenceToVideo"' "$body" || missing+=("MiniMaxH3ReferenceToVideo node")
  # On disk is not enough: ComfyUI must LIST it (a real directory over the
  # symlink once hid the whole base set while every file sat on disk).
  grep -q '"minimax_h3_fl2va_pruned_int8_convrot.safetensors"' "$body" || missing+=("base model not listed by ComfyUI")
  for f in diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors \
           diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors \
           text_encoders/minimax_h3_text_encoder.safetensors \
           vae/minimax_h3_video_vae_fp16.safetensors vae/minimax_h3_audio_vae_fp32.safetensors; do
    [[ -f "$MODELS_DIR/$f" ]] || missing+=("$f")
  done
  local dl
  dl=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$LOCAL_COMFYUI_URL/artsnack/status" 2>/dev/null)
  [[ "$dl" == "404" ]] && missing+=("downloader routes")
  if (( ${#missing[@]} )); then
    log "VERIFY: *** MINIMAX H3 IS BROKEN *** missing: ${missing[*]}"
    return 1
  fi
  log "VERIFY: MiniMax H3 OK — nodes registered, base files on disk"
}

if [[ "$PROFILE" == "video" ]]; then
  if ! verify_video; then
    PROVISION_WARNINGS+=("MiniMax H3 verification failed")
    report_progress "degraded" 90 "ComfyUI is running, but MiniMax H3 nodes or base files failed verification."
  fi
elif ! verify_enhance; then
  PROVISION_WARNINGS+=("Face Fix verification failed")
  report_progress "degraded" 90 "ComfyUI is running, but required Face Fix nodes or models failed verification."
fi

start_cloudflare_tunnel() {
  [[ -z "${CF_TUNNEL_TOKEN:-}" ]] && return 0
  report_progress "tunnel" 94 "Starting the private Cloudflare tunnel…"
  local cloudflared_version="2026.8.2"
  if ! command -v cloudflared >/dev/null 2>&1 || ! cloudflared --version 2>/dev/null | grep -q "${cloudflared_version}"; then
    local arch sha
    case "$(uname -m)" in
      x86_64|amd64) arch="amd64"; sha="fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2" ;;
      aarch64|arm64) arch="arm64"; sha="7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790" ;;
      *) log "tunnel: unsupported architecture $(uname -m)"; return 1 ;;
    esac
    curl -fsSL --retry 3 "https://github.com/cloudflare/cloudflared/releases/download/${cloudflared_version}/cloudflared-linux-${arch}" \
      -o /usr/local/bin/cloudflared || return 1
    echo "${sha}  /usr/local/bin/cloudflared" | sha256sum -c - >/dev/null || {
      rm -f /usr/local/bin/cloudflared
      log "tunnel: cloudflared checksum mismatch"
      return 1
    }
    chmod +x /usr/local/bin/cloudflared
  fi
  pkill -f "cloudflared.*tunnel.*run" 2>/dev/null || true
  TUNNEL_TOKEN="$CF_TUNNEL_TOKEN" setsid nohup cloudflared tunnel --no-autoupdate run \
    >/workspace/cloudflared.log 2>&1 </dev/null &
  sleep 3
  pgrep -f "cloudflared.*tunnel.*run" >/dev/null || { log "tunnel: failed to start"; return 1; }
  log "tunnel: running"
}

if (( ! ENHANCE_ONLY )); then
  if start_cloudflare_tunnel; then
    if (( ${#PROVISION_WARNINGS[@]} )); then
      report_progress "ready" 100 "Backend is online with warnings: ${PROVISION_WARNINGS[*]}."
    else
      report_progress "ready" 100 "Backend is online and ready for generations."
    fi
  else
    report_progress "error" 95 "ComfyUI is ready, but the Cloudflare tunnel failed to start."
  fi
fi

# ── Video profile: the user's own models, after ready ──────────────────────
# Each line goes to the downloader node on this pod rather than through fetch():
# the node is what the app already polls (/artsnack/status), so every custom
# checkpoint shows up there as "downloading" with bytes, and the dropdowns list
# it the moment it lands. The node caps concurrent jobs and answers 429 above
# it, so wait and resubmit until it takes the order.
queue_dynamic_downloads() {
  [[ -z "$DYNAMIC_MODELS" || -z "${POD_URL_SECRET:-}" ]] && return 0
  local dir url name payload code tries
  while IFS='|' read -r dir url name; do
    [[ -z "$dir" ]] && continue
    payload=$(python3 -c 'import json,sys; print(json.dumps({"dir":sys.argv[1],"url":sys.argv[2],"filename":sys.argv[3]}))' "$dir" "$url" "$name")
    for tries in $(seq 1 360); do
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST \
        -H "x-artsnack-secret: ${POD_URL_SECRET}" -H "Content-Type: application/json" \
        -d "$payload" "$LOCAL_COMFYUI_URL/artsnack/download" 2>/dev/null)
      [[ "$code" == "429" || "$code" == "000" ]] || break
      sleep 10
    done
    log "queue $dir/$name -> HTTP $code"
  done <<< "$DYNAMIC_MODELS"
}
if [[ "$PROFILE" == "video" ]] && (( ! ENHANCE_ONLY )); then
  # Re-read the manifest: rows added to it while this pod was booting would
  # otherwise wait for the next pod. A second pass a little later covers the
  # minute before Convex marks the pod ready; the downloader answers
  # "exists"/"already_downloading" for repeats.
  fetch_dynamic_manifest
  queue_dynamic_downloads
  ( sleep 120; fetch_dynamic_manifest; queue_dynamic_downloads ) &
  # Community add-ons, one at a time so they never compete with the user's
  # own manifest downloads for the NIC.
  (
    QUIET_PROGRESS=1
    while IFS='|' read -r dir url name; do
      [[ -z "$dir" ]] && continue
      fetch "$dir" "$url" "$name" || log "extra $dir/$name — failed; its option stays off"
    done <<< "$(printf '%s\n%s\n' "$LTX_MODELS" "$H3_EXTRA_MODELS")"
    log "extras done"
  ) &
fi

if (( ENHANCE_ONLY )); then
  log "Enhance-only done. Processed $total entries."
elif [[ "$PROFILE" == "video" ]]; then
  log "Done. Processed $total entries. MiniMax H3 base set in $MODELS_DIR"
else
  log "Done. Processed $total entries. Models in $MODELS_DIR (incl. Enhance: upscale_models + ultralytics/bbox + Impact nodes)"
fi
