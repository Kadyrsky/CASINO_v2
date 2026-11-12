#!/usr/bin/env bash
# Runs on the server (called by the deploy job over SSH). Usage:
#   echo <ghcr token> | server-deploy.sh <image tag> <github user>
# Without a token on stdin it skips the registry login (e.g. a manual rollback to images already pulled):
#   bash /opt/naebka/server-deploy.sh <older sha> < /dev/null
set -euo pipefail
cd /opt/naebka

TAG="${1:?image tag (git sha) required}"
GH_USER="${2:-}"
COMPOSE=(docker compose -f docker-compose.prod.yml)

[ -f .env ] || { echo ".env is missing in /opt/naebka (see deploy/README.md)"; exit 1; }

# Remember the running tag so a failed health check can roll back.
PREV_TAG="$(grep -E '^IMAGE_TAG=' .env | cut -d= -f2- || true)"
if grep -qE '^IMAGE_TAG=' .env; then sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${TAG}/" .env; else echo "IMAGE_TAG=${TAG}" >> .env; fi

# The GitHub token only lives for the job, so log in, pull, and log out again.
TOKEN="$(cat || true)"
if [ -n "$TOKEN" ] && [ -n "$GH_USER" ]; then
  echo "$TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin >/dev/null
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
fi

# The music folder the core mounts (deploy/README.md, "Music"). Created here, as this user, so the music can be
# uploaded with scp; if Docker created it for the mount, it would belong to root.
mkdir -p music
[ -f music/manifest.json ] || echo "Note: /opt/naebka/music is empty, so the site has no music (deploy/README.md, Music)."

"${COMPOSE[@]}" pull --quiet
"${COMPOSE[@]}" up -d --remove-orphans

# Spring Boot needs a while to start on one CPU; wait for it to answer through Caddy.
echo "Waiting for core to become healthy..."
for i in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T caddy wget -qO- http://core:8081/actuator/health 2>/dev/null | grep -q '"UP"'; then
    echo "Core is UP (tag ${TAG})."
    docker image prune -af --filter "until=168h" >/dev/null || true
    exit 0
  fi
  sleep 5
done

echo "Core did not become healthy in 5 minutes. Recent logs:"
"${COMPOSE[@]}" logs --tail=80 core || true
if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$TAG" ]; then
  echo "Rolling back to ${PREV_TAG}"
  sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${PREV_TAG}/" .env
  "${COMPOSE[@]}" up -d --remove-orphans || true
fi
exit 1
