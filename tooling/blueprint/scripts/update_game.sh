#!/bin/bash
set -euo pipefail

# Day-2 UpdateGame action: pull the image at @@{IMAGE_TAG}@@ and replace
# the running container. The operator can override IMAGE_TAG when firing
# this action to roll a freshly-pushed release without re-launching the
# whole blueprint.

CONTAINER="ntnx-infiltration-game"
IMAGE="@@{IMAGE_REPO}@@:@@{IMAGE_TAG}@@"

# Source IP the player whitelists for SSH in stage 19 — pinned via the
# GAME_FRONTEND_HOST runtime var, else derived from this host's primary egress
# IPv4 (read on the VM, not in the container, since traffic is NAT'd to the host).
FRONTEND_HOST="@@{GAME_FRONTEND_HOST}@@"
if [[ -z "$FRONTEND_HOST" ]]; then
    FRONTEND_HOST="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)"
    # Fallback for hosts with no default route (isolated / host-only networks).
    [[ -z "$FRONTEND_HOST" ]] && FRONTEND_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

sudo docker pull "$IMAGE"
sudo docker rm -f "$CONTAINER" 2>/dev/null || true

sudo docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    -p 3000:3000 \
    -v /var/lib/ntnx-infiltration-game/data:/data \
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

sleep 3
sudo docker ps --filter "name=$CONTAINER" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
sudo docker logs --tail 15 "$CONTAINER"
