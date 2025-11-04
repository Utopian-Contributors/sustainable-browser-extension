#!/usr/bin/env bash
set -euo pipefail

# Maintenance helper for GitHub Actions
# - Run dependency analysis
# - Run export:deps to regenerate cdn-exports.json

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[update-deps] Running dependency analysis..."
yarn analyze:deps

echo "[update-deps] Regenerating exports..."
yarn export:deps

echo "[update-deps] Done."
