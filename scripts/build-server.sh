#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY_PATH="${BINARY_PATH:-/usr/local/bin/videochat}"

echo "==> Building frontend assets"
(cd "$ROOT_DIR/frontend" && npm run build)

echo "==> Building backend binary -> $BINARY_PATH"
(cd "$ROOT_DIR/backend" && go build -o "$BINARY_PATH" .)

echo "Build complete"
