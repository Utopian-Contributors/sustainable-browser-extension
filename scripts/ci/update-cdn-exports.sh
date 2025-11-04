#!/usr/bin/env bash
set -euo pipefail

# Maintenance helper for GitHub Actions
# - Run dependency analysis
# - Snapshot current cdn-exports.json
# - Run export:deps to regenerate cdn-exports.json
# - If changed, leave changes in the working tree for the workflow to open a PR

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[update-deps] Running dependency analysis..."
yarn analyze:deps

SRC="cdn-exports.json"
TMP="${SRC}.tmp.$(date +%s)"

if [ ! -f "$SRC" ]; then
  echo "[update-deps] ERROR: ${SRC} does not exist"
  exit 2
fi

echo "[update-deps] Backing up ${SRC} -> ${TMP}"
cp "$SRC" "$TMP"

echo "[update-deps] Regenerating exports..."
yarn export:deps

if cmp -s "$TMP" "$SRC"; then
  echo "[update-deps] No changes to ${SRC}. Cleaning up and exiting."
  rm -f "$TMP"
  exit 0
fi

echo "[update-deps] ${SRC} changed. Leaving updated file in working tree for PR creation."

# Remove the temp snapshot (we don't need it in the commit)
rm -f "$TMP"

echo "[update-deps] Done."
