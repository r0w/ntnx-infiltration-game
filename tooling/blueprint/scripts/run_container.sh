#!/bin/bash
set -euo pipefail

# Pull the released image from ghcr.io and run it as a long-lived container.
# Idempotent: stops + removes any prior container before re-running, so the
# day-2 UpdateGame action can re-fire this same script to roll a new tag.

IMAGE="@@{IMAGE_REPO}@@:@@{IMAGE_TAG}@@"
CONTAINER="ntnx-infiltration-game"

# docker login when the image is in a private repo (default while ours is
# private). Public repo → leave GHCR_TOKEN blank, login is skipped.
TOKEN="@@{GHCR_TOKEN}@@"
USERNAME="@@{GHCR_USERNAME}@@"
if [[ -n "$TOKEN" ]]; then
    echo "$TOKEN" | sudo docker login ghcr.io -u "${USERNAME:-x-access-token}" --password-stdin
fi

# Source IP the player whitelists for SSH in stage 19. Operator can pin it via
# the GAME_FRONTEND_HOST runtime var; left blank, derive this host's primary
# egress IPv4 — the address the game's SSH probe actually originates from
# (NAT'd to the host, so we must read it here on the VM, not inside the container).
FRONTEND_HOST="@@{GAME_FRONTEND_HOST}@@"
if [[ -z "$FRONTEND_HOST" ]]; then
    FRONTEND_HOST="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)"
fi

sudo docker pull "$IMAGE"

# Stop + remove any prior incarnation so a re-run rolls cleanly.
sudo docker rm -f "$CONTAINER" 2>/dev/null || true

# Persist the sqlite DB on the host so a container roll keeps session history.
sudo mkdir -p /var/lib/ntnx-infiltration-game/data

sudo docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    -p 3000:3000 \
    -v /var/lib/ntnx-infiltration-game/data:/data \
    -e PUBLIC_DIR=/app/public \
    -e MODE="@@{MODE}@@" \
    -e LOG_LEVEL="@@{LOG_LEVEL}@@" \
    -e CLUSTER_PROFILE="@@{CLUSTER_PROFILE}@@" \
    -e PC_ENDPOINT="https://@@{PC_IP}@@:9440" \
    -e PC_USER="@@{PC_USERNAME}@@" \
    -e PC_PASSWORD="@@{PC_PASSWORD}@@" \
    -e NUTANIX_VERIFY_SSL=false \
    -e ADMIN_PASSWORD="@@{ADMIN_PASSWORD}@@" \
    -e GAME_VLAN_ID="@@{GAME_VLAN_ID}@@" \
    -e GAME_PROD_USERNAME="@@{GAME_PROD_USERNAME}@@" \
    -e GAME_PROD_PASSWORD="@@{GAME_PROD_PASSWORD}@@" \
    -e GAME_OLD_PC="@@{GAME_OLD_PC}@@" \
    -e GAME_OLD_PC_USERNAME="@@{GAME_OLD_PC_USERNAME}@@" \
    -e GAME_OLD_PC_PASSWORD="@@{GAME_OLD_PC_PASSWORD}@@" \
    -e GAME_EMAIL_REPORT="@@{GAME_EMAIL_REPORT}@@" \
    -e GAME_FRONTEND_HOST="$FRONTEND_HOST" \
    -e TZ="@@{TIMEZONE}@@" \
    "$IMAGE"

# Give the server a few seconds to bind, then surface the boot log so the
# Calm task output is useful for diagnosis.
sleep 5
sudo docker ps --filter "name=$CONTAINER" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo "--- boot log ---"
sudo docker logs --tail 30 "$CONTAINER"
