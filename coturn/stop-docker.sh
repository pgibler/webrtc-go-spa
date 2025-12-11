#!/usr/bin/env bash
set -euo pipefail

NAME="${NAME:-webrtc-coturn}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run this script" >&2
  exit 1
fi

docker stop "$NAME"

echo "coturn container $NAME stopped"
