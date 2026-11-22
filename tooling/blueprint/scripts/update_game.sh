#!/bin/bash
set -euo pipefail

# Day-2 UpdateGame: roll the game container to the BP's current IMAGE_TAG.
# The operator can change IMAGE_TAG (or IMAGE_REPO) when firing this action;
# we sync the image reference and telemetry VM address into .env, then re-pull
# and recreate via compose. Everything else (secrets, mode, etc.) is left exactly
# as run_container.sh wrote it at install — no env duplication.
#
# Note: a roll only fetches something new for a MOVING tag (latest / develop);
# a pinned tag still recreates the container so in-memory credentials reload.

APPDIR=/opt/ntnx-infiltration-game
cd "$APPDIR"

# Sync the image ref from the BP vars.
sudo sed -i "s|^IMAGE_REPO=.*|IMAGE_REPO=@@{IMAGE_REPO}@@|" .env
sudo sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=@@{IMAGE_TAG}@@|" .env

# Older installations did not pass the VM address to telemetry.
sudo sed -i '/^NIG_DEPLOYMENT_IP=/d' .env
echo 'NIG_DEPLOYMENT_IP=@@{VM.address}@@' | sudo tee -a .env >/dev/null

sudo docker compose pull
sudo docker compose up -d --remove-orphans --force-recreate

sleep 3
sudo docker compose ps
sudo docker compose logs --tail 15
