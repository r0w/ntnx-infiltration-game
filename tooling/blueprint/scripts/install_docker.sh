#!/bin/bash
set -euo pipefail

# Install Docker Engine on Ubuntu 24.04 if missing. Idempotent — re-runs
# of the action skip the install when docker is already present.

if command -v docker >/dev/null 2>&1; then
    echo "[install_docker] already installed: $(docker --version)"
    exit 0
fi

curl -fsSL https://get.docker.com | sudo sh

# Let the nutanix user run docker without sudo on follow-up day-2 actions.
sudo usermod -aG docker nutanix || true

# Make sure the daemon is up + comes back on reboot.
sudo systemctl enable --now docker

# Smoke test
sudo docker --version
sudo docker info --format 'Server: {{.ServerVersion}}'
