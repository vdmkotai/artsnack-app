#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_DIR="${ARTSNACK_WORKSPACE_DIR:-/workspace}"
BOOTSTRAP_PATH="$WORKSPACE_DIR/artsnack-bootstrap.sh"
BOOTSTRAP_LOG="$WORKSPACE_DIR/bootstrap.log"

mkdir -p "$WORKSPACE_DIR"
if [[ -n "${ARTSNACK_STARTUP_SCRIPT_B64:-}" ]]; then
  if ! printf '%s' "$ARTSNACK_STARTUP_SCRIPT_B64" | base64 -d > "$BOOTSTRAP_PATH"; then
    echo "ARTSNACK_STARTUP_SCRIPT_B64 is invalid; provisioning cannot start." >&2
    exit 1
  fi
elif [[ -n "${ARTSNACK_STARTUP_SCRIPT:-}" ]]; then
  # Backwards-compatible for runtimes that preserve multiline environment
  # values. Vast currently drops those values, so production uses base64.
  printf '%s\n' "$ARTSNACK_STARTUP_SCRIPT" > "$BOOTSTRAP_PATH"
else
  echo "ARTSNACK_STARTUP_SCRIPT_B64 is missing; provisioning cannot start." >&2
  exit 1
fi
chmod 700 "$BOOTSTRAP_PATH"
nohup /bin/bash "$BOOTSTRAP_PATH" >"$BOOTSTRAP_LOG" 2>&1 &

echo "ArtSnack provisioning started in the background (log: $BOOTSTRAP_LOG)."
