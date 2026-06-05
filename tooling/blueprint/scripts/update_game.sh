#!/bin/bash
set -euo pipefail

# Day-2 UpdateGame: roll the game container to the BP's current IMAGE_TAG.
# The operator can change IMAGE_TAG (or IMAGE_REPO) when firing this action;
# we sync just those two lines into the existing .env, then re-pull + recreate
# via compose. Everything else in .env (secrets, mode, etc.) is left exactly
# as run_container.sh wrote it at install — no env duplication.
#
# Note: a roll only fetches something new for a MOVING tag (latest / develop);
# a pinned tag re-pulls to a no-op.

APPDIR=/opt/ntnx-infiltration-game
cd "$APPDIR"

# Sync the image ref from the BP vars (the rest of .env is untouched).
sudo sed -i "s|^IMAGE_REPO=.*|IMAGE_REPO=@@{IMAGE_REPO}@@|" .env
sudo sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=@@{IMAGE_TAG}@@|" .env

sudo docker compose pull
sudo docker compose up -d --remove-orphans

sleep 3
sudo docker compose ps
sudo docker compose logs --tail 15
