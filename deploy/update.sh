#!/usr/bin/env sh
# Pull the latest code and rebuild/restart the container.
set -e
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose up -d --build
docker image prune -f >/dev/null
docker compose ps
