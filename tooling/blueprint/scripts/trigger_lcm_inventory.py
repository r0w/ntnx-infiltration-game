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

# PC 7.5 serves these v4 namespaces at v4.2; PC 7.3 stops at v4.1 and 404s
# anything pinned higher. Probe once per namespace, highest first.
_NS_VER = {}


def ns_version(ns, probe, candidates=('v4.2', 'v4.1', 'v4.0')):
    """Highest version of a v4 namespace this PC actually serves."""
    if ns in _NS_VER:
        return _NS_VER[ns]
    for v in candidates:
        code = None
        for _ in range(2):  # a blip must not demote the version
            try:
                code = requests.get("%s/api/%s/%s/%s" % (BASE, ns, v, probe),
                                    auth=AUTH, headers=HEADERS,
                                    verify=False, timeout=30).status_code
                break
            except Exception:
                pass
        if code is None:
            # Unreachable tells us nothing about which versions exist. Stop
            # probing rather than demote the whole run on a network blip.
            break
        if code != 404:
            print("[ver]  %s -> %s" % (ns, v))
            _NS_VER[ns] = v
            return v
    # Inconclusive: keep the newest so a bad probe can't downgrade a healthy
    # cluster. If every version really 404s, the real call fails loudly.
    print("[ver]  %s -> %s (probe inconclusive, keeping newest)"
          % (ns, candidates[0]))
    _NS_VER[ns] = candidates[0]
    return candidates[0]


def lcm_version():
    return ns_version('lifecycle', 'resources/lcm-summaries')


# The v4 LCM action is `inventory` (NOT `perform-inventory` — that path
# 404s, the bug seen in the 2026-06-01 run). Version is negotiated: PC 7.5
# has v4.2, PC 7.3 tops out at v4.1. v4.2/v4.1 want a `{}` body; v4.0
# rejects any body ("No request body is expected") and wants none, both
# verified live -> 202.


def cluster_ids():
    # Every LCM-capable cluster (PCVM cluster + each registered PE).
    # Best-effort: a network/JSON error here just yields [] → main() falls
    # back to a single default-cluster inventory rather than crashing the
    # install runbook (this task is non-fatal by design).
    try:
        r = requests.get("%s/api/lifecycle/%s/resources/lcm-summaries"
                         % (BASE, lcm_version()),
                         auth=AUTH, headers=HEADERS,
                         verify=False, timeout=20)
        ids = []
        if r.status_code == 200:
            for s in (r.json().get("data") or []):
                cid = s.get("clusterExtId")
                if cid and cid not in ids:
                    ids.append(cid)
        return ids
    except Exception as e:
        print("[warn] could not list LCM clusters: %s" % str(e)[:160])
        return []


def fire(cid):
    # Mutate the module-level HEADERS so the build-time patcher's
    # `_req_headers(HEADERS)` wrapper (which adds NTNX-Request-Id) also
    # carries the per-cluster target. cid=None → default cluster.
    HEADERS.pop("X-Cluster-Id", None)
    if cid:
        HEADERS["X-Cluster-Id"] = cid
    try:
        v = lcm_version()
        url = "%s/api/lifecycle/%s/operations/$actions/inventory" % (BASE, v)
        # v4.0 refuses a request body; v4.1+ expects one.
        body = None if v == "v4.0" else "{}"
        r = requests.post(url, auth=AUTH, headers=HEADERS,
                          verify=False, timeout=20, data=body)
        return r.status_code in (200, 201, 202), r.status_code, r.text[:160]
    except Exception as e:
        return False, 0, str(e)[:160]


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
