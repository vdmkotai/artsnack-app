# syntax=docker/dockerfile:1

ARG ARTSNACK_TARGETPLATFORM=linux/amd64
FROM --platform=$ARTSNACK_TARGETPLATFORM runpod/comfyui:1.4.1-cuda12.8@sha256:1f9de5f6c1183211b7fb43c626c48a11c5ff9bda6acde77781fa1f104aac3469

# Vast replaces the image entrypoint with its SSH launcher. That launcher does
# execute an existing onstart.sh from the image working directory, so this tiny
# adapter is the reliable bridge from Vast's container environment to the
# ArtSnack bootstrap supplied by Convex.
COPY onstart.sh /workspace/runpod-slim/onstart.sh
RUN chmod 755 /workspace/runpod-slim/onstart.sh
