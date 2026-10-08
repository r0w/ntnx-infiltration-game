#!/bin/bash
set -euo pipefail

# Install Docker Engine on Ubuntu if missing. Idempotent — re-runs
# of the action skip the install when docker is already present.

# Grant Docker access to the account used by Calm, including on retries.
sudo groupadd -f docker
sudo usermod -aG docker "$(id -un)"

if command -v docker >/dev/null 2>&1; then
    echo "[install_docker] already installed: $(docker --version)"
    exit 0
fi

curl -fsSL https://get.docker.com | sudo sh

# Make sure the daemon is up + comes back on reboot.
sudo systemctl enable --now docker

# Smoke test
sudo docker --version
sudo docker info --format 'Server: {{.ServerVersion}}'
