#!/bin/bash
set -euo pipefail

# Day-2 SwitchMode: flip the deployed game between mock / test / live without a
# re-launch. Rewrites just the MODE line in the existing .env, then recreates
# the container via compose. Everything else (secrets, image, etc.) is left as
# run_container.sh wrote it. The sqlite DB is shared across modes by design
# (manage state from /admin if needed).

APPDIR=/opt/ntnx-infiltration-game
cd "$APPDIR"

TARGET_MODE="@@{TARGET_MODE}@@"
case "$TARGET_MODE" in
    mock|test|live) ;;
    *) echo "[FAIL] invalid TARGET_MODE='$TARGET_MODE' (expected mock|test|live)"; exit 1 ;;
esac

sudo sed -i "s|^MODE=.*|MODE=${TARGET_MODE}|" .env
# --force-recreate: the image is unchanged, only the env changed, so force the
# container to be rebuilt with the new MODE.
sudo docker compose up -d --force-recreate

sleep 3
echo "MODE is now: $(grep '^MODE=' .env)"
sudo docker compose ps
sudo docker compose logs --tail 15
