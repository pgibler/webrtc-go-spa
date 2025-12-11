#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${CONFIG:-turnserver.conf}"
IMAGE="${IMAGE:-instrumentisto/coturn}"
NAME="${NAME:-webrtc-coturn}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run this script" >&2
  exit 1
fi

if [ ! -f "$DIR/$CONFIG" ]; then
  echo "Config file $DIR/$CONFIG not found. Copy turnserver.conf.example to turnserver.conf and edit it." >&2
  exit 1
fi

docker run --rm -d --name "$NAME" \
  -p 3478:3478/udp -p 3478:3478/tcp \
  -v "$DIR/$CONFIG":/etc/turnserver.conf \
  "$IMAGE" -c /etc/turnserver.conf

echo "coturn started in container $NAME using $CONFIG"
