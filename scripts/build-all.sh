#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Building backend"
(cd "$ROOT_DIR/backend" && go build ./...)

echo "==> Building frontend"
(cd "$ROOT_DIR/frontend" && npm run build)

echo "Build complete"
