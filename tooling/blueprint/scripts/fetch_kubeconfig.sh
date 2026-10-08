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

# Left blank on the launch screen: ask Prism Central. The bootstrap VM is named
# `nkp-boot` by the bootcamp's own automation, and the operator has already
# typed the Prism credentials one field higher up, so there is nothing here a
# human knows that the cluster does not.
if [[ -z "$BOOT_IP" ]]; then
    echo "[fetch_kubeconfig] no bootstrap IP given — looking for the nkp-boot VM on Prism Central"
    BOOT_IP="$(curl -sk --max-time 60 \
        -u "@@{PC_USERNAME}@@:@@{PC_PASSWORD}@@" \
        -X POST "https://@@{PC_IP}@@:9440/api/nutanix/v3/vms/list" \
        -H 'Content-Type: application/json' \
        -d '{"kind":"vm","length":500}' \
      | python3 -c '
import json, sys
try:
    vms = json.load(sys.stdin).get("entities", [])
except Exception:
    sys.exit(0)
for vm in vms:
    st = vm.get("status") or {}
    if (st.get("name") or "") != "nkp-boot":
        continue
    for nic in (st.get("resources") or {}).get("nic_list") or []:
        for ep in nic.get("ip_endpoint_list") or []:
            if ep.get("ip"):
                print(ep["ip"])
                sys.exit(0)
')"
    [[ -n "$BOOT_IP" ]] && echo "[fetch_kubeconfig] found nkp-boot at ${BOOT_IP}"
fi

if [[ -z "$BOOT_IP" ]]; then
    echo "[fetch_kubeconfig] no bootstrap VM address, and no VM named nkp-boot on this Prism Central."
    echo "[fetch_kubeconfig] Fill in the NKP bootstrap VM IP on the launch screen and re-run."
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
