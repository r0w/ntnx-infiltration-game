#script

"""
Port of the legacy LaunchInventory.sh — fires a Life Cycle Manager
inventory scan so the in-game stage 29 `lcm-check-updates` finds fresh
update entities. Without this, the player can hit a stale or empty
LCM list (PC normally scans on a schedule, not necessarily fresh after
provisioning).

LCM inventory is PER-CLUSTER: one POST scans one cluster only. PC's LCM
has TWO scopes — "Prism Central" (the PCVM cluster) and "Prism Element
Clusters" (each registered PE). We list every LCM-capable cluster from
lcm-summaries and fire an inventory on each via the `X-Cluster-Id`
header, so both tabs are populated for stage 29.

Async by design: each POST returns 202 + a task UUID immediately; the
inventory runs in the background on the PC. We don't wait — the game
won't reach stage 29 for many minutes.

Calm injects @@{PC_IP}@@, @@{PC_USERNAME}@@, @@{PC_PASSWORD}@@.
"""

import sys
import urllib3

import requests

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

PC_IP = '@@{PC_IP}@@'
PC_USERNAME = '@@{PC_USERNAME}@@'
PC_PASSWORD = '@@{PC_PASSWORD}@@'

BASE = "https://%s:9440" % PC_IP
AUTH = (PC_USERNAME, PC_PASSWORD)
HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}


# The v4 LCM action is `inventory` (NOT `perform-inventory` — that path
# 404s, the bug seen in the 2026-06-01 run). v4.2 (PC 7.3+) verified live
# = 202 with a `{}` body. No older fallback — v4.0 rejects any body
# ("No request body is expected"), so it'd 400 on the 7.5 HPoC we ship to.
SUMMARIES = "/api/lifecycle/v4.2/resources/lcm-summaries"
INVENTORY = "/api/lifecycle/v4.2/operations/$actions/inventory"


def cluster_ids():
    # Every LCM-capable cluster (PCVM cluster + each registered PE).
    r = requests.get(BASE + SUMMARIES, auth=AUTH, headers=HEADERS,
                     verify=False, timeout=20)
    ids = []
    if r.status_code == 200:
        for s in (r.json().get("data") or []):
            cid = s.get("clusterExtId")
            if cid and cid not in ids:
                ids.append(cid)
    return ids


def fire(cid):
    # Mutate the module-level HEADERS so the build-time patcher's
    # `_req_headers(HEADERS)` wrapper (which adds NTNX-Request-Id) also
    # carries the per-cluster target. cid=None → default cluster.
    HEADERS.pop("X-Cluster-Id", None)
    if cid:
        HEADERS["X-Cluster-Id"] = cid
    r = requests.post(BASE + INVENTORY, auth=AUTH, headers=HEADERS,
                      verify=False, timeout=20, data="{}")
    return r.status_code in (200, 201, 202), r.status_code, r.text[:160]


def main():
    ids = cluster_ids()
    # Fall back to a single default-cluster inventory if we couldn't list
    # clusters — better than firing nothing.
    targets = ids if ids else [None]
    fired = 0
    for cid in targets:
        ok, code, body = fire(cid)
        label = cid or "default"
        if ok:
            fired += 1
            print("[ok]   LCM inventory triggered on %s — task running async" % label)
        else:
            print("[warn] LCM inventory failed on %s -> %d %s" % (label, code, body))
    if fired == 0:
        print("[warn] no LCM inventory triggered — relying on PC's scheduler")
    return 0


sys.exit(main())
