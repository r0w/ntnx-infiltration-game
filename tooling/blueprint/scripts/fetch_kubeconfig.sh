#!/bin/bash
set -euo pipefail

# NKP profile install task: copy the management kubeconfig off the NKP
# bootstrap VM so the game server can read the cluster.
#
# One credential unlocks the whole fleet: the workload kubeconfigs live in CAPI
# secrets on the management cluster, and the transport reads them at boot. So
# this only needs the bootstrap VM's SSH login, which on an HPoC is the same
# password the operator already typed for Prism Central.
#
# The file lands under $APPDIR/data, which is already bind-mounted into the
# container at /data by docker-compose.yml. No compose change, no extra mount.

APPDIR=/opt/ntnx-infiltration-game
BOOT_IP="@@{NKP_BOOT_IP}@@"
BOOT_USER="@@{NKP_BOOT_USERNAME}@@"
DEST="$APPDIR/data/nkp-kubeconfig"

sudo mkdir -p "$APPDIR/data"

if [[ -z "$BOOT_IP" ]]; then
    echo "[fetch_kubeconfig] NKP_BOOT_IP is empty — nothing to fetch."
    echo "[fetch_kubeconfig] The game will start, but every cluster check will fail."
    exit 1
fi

# sshpass is not on the stock image and we cannot assume an SSH key exists
# between this VM and the bootstrap VM.
if ! command -v sshpass >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sshpass
fi

export SSHPASS="@@{NKP_BOOT_PASSWORD}@@"
sshpass -e ssh \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=20 \
    "${BOOT_USER}@${BOOT_IP}" 'cat ~/.kube/config' | sudo tee "$DEST" >/dev/null

sudo chmod 600 "$DEST"

# A kubeconfig that carries no client certificate is useless to the transport
# (it parses the cert blocks, not a token), so fail here rather than shipping a
# game whose every check errors.
if ! sudo grep -q 'client-certificate-data' "$DEST"; then
    echo "[fetch_kubeconfig] fetched file has no client-certificate-data:"
    sudo head -5 "$DEST"
    exit 1
fi

SERVER="$(sudo grep -m1 'server:' "$DEST" | awk '{print $2}')"
echo "[fetch_kubeconfig] management kubeconfig stored, API server ${SERVER}"
