#script

"""
Idempotent node-removal: looks for a host whose name ends in '-4' on the
AOS cluster and removes it. POSTs the action, then polls /hosts until the
host disappears from the cluster's host list (or a deadline hits).

Two early-exit cases that print and return 0:
  1. CLUSTER_PROFILE='other' — never touch a non-hpoc cluster's hardware.
  2. No '-4' host present (already trimmed by an earlier launch).

The poll loop is bounded by POLL_ITERATIONS — each iteration does a fresh
/hosts GET and the network round-trip is the natural rate limiter
(time.sleep is banned in the Calm escript sandbox).

Calm injects @@{PC_IP}@@, @@{PC_USERNAME}@@, @@{PC_PASSWORD}@@,
@@{Game.CLUSTERUUID}@@ (set by upstream Get Cluster),
@@{CLUSTER_PROFILE}@@ (operator's launch choice: 'hpoc' or 'other').
"""

import sys
import time
import urllib3

import requests

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

PC_IP = '@@{PC_IP}@@'
PC_USERNAME = '@@{PC_USERNAME}@@'
PC_PASSWORD = '@@{PC_PASSWORD}@@'
CLUSTER_UUID = '@@{Game.CLUSTERUUID}@@'
CLUSTER_PROFILE = '@@{CLUSTER_PROFILE}@@'

BASE = "https://%s:9440/api/clustermgmt/v4.0" % PC_IP
AUTH = (PC_USERNAME, PC_PASSWORD)
HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}

# Fast polling for the first 90 s (catches the NORMAL → TO_BE_REMOVED
# transition quickly), then slow polling every 15 s for up to ~50 min.
# Total wall-clock cap: ~50 min. If we hit the cap with the host still
# progressing (TO_BE_REMOVED / in_maintenance), we exit 0 with a warning
# — the cluster shrink finishes async and `Verify final state` at the
# end of the runbook is the source of truth.
FAST_POLL_ITERS = 30          # ~30 s
SLOW_POLL_ITERS = 160         # 160 × 15 s = 40 min
SLOW_POLL_INTERVAL_SEC = 15


def list_hosts():
    r = requests.get(
        "%s/config/clusters/%s/hosts" % (BASE, CLUSTER_UUID),
        auth=AUTH, headers=HEADERS, verify=False, timeout=30,
    )
    r.raise_for_status()
    return r.json().get('data') or []


def main():
    if CLUSTER_PROFILE != 'hpoc':
        print(
            "[skip] CLUSTER_PROFILE=%r — won't touch hardware on a non-hpoc cluster. "
            "Stage 28 (expand-cluster) is filtered for non-hpoc anyway." % CLUSTER_PROFILE
        )
        return 0

    if not CLUSTER_UUID:
        print("[FAIL] CLUSTER_UUID not set — Get Cluster must run first.")
        return 2

    hosts = list_hosts()
    target = next(
        (h for h in hosts if (h.get('hostName') or '').endswith('-4')),
        None,
    )

    if not target:
        names = [h.get('hostName') for h in hosts]
        print("[skip] no host ending in '-4' (cluster has %d nodes: %s)" %
              (len(hosts), names))
        return 0

    node_uuid = target['extId']
    print("Removing host=%s ext_id=%s from cluster=%s ..." %
          (target.get('hostName'), node_uuid, CLUSTER_UUID))

    body = {"nodeUuids": [node_uuid]}
    r = requests.post(
        "%s/config/clusters/%s/$actions/remove-node" % (BASE, CLUSTER_UUID),
        auth=AUTH, headers=HEADERS, verify=False, timeout=60,
        json=body,
    )
    if r.status_code >= 400:
        print("[FAIL] remove-node POST: %d %s" % (r.status_code, r.text[:300]))
        return 1
    print("  remove-node action accepted (HTTP %d), polling for removal..." % r.status_code)

    # Two-phase polling:
    #   Phase 1 — fast for ~30 s (catches NORMAL → TO_BE_REMOVED quickly)
    #   Phase 2 — every 15 s for ~50 min (the long shrink wait)
    last_state = None

    def check_once(label):
        try:
            current = list_hosts()
        except Exception as e:
            print("  [%s] /hosts error: %s — retrying" % (label, str(e)[:120]))
            return None
        still = next((h for h in current if h.get('extId') == node_uuid), None)
        if not still:
            return ("done", current)
        state = (still.get('nodeStatus'), still.get('maintenanceState'))
        return ("progress", state)

    for i in range(FAST_POLL_ITERS):
        result = check_once("fast %d" % i)
        if result is None:
            continue
        kind, payload = result
        if kind == "done":
            print("[ok] host-4 removed (cluster now has %d nodes) — fast phase, ~%d s"
                  % (len(payload), i + 1))
            return 0
        if payload != last_state:
            print("  [fast %d] host-4 state: %s" % (i, payload))
            last_state = payload

    print("  --- switching to slow polling (every %d s) ---" % SLOW_POLL_INTERVAL_SEC)
    for i in range(SLOW_POLL_ITERS):
        result = check_once("slow %d" % i)
        if result is not None:
            kind, payload = result
            if kind == "done":
                wall = FAST_POLL_ITERS + (i + 1) * SLOW_POLL_INTERVAL_SEC
                print("[ok] host-4 removed (cluster now has %d nodes) after ~%d s"
                      % (len(payload), wall))
                return 0
            if payload != last_state:
                print("  [slow %d / +%d s] host-4 state: %s" %
                      (i, (i + 1) * SLOW_POLL_INTERVAL_SEC, payload))
                last_state = payload
        time.sleep(SLOW_POLL_INTERVAL_SEC)

    # Hit the iteration cap. If the host is still progressing (TO_BE_REMOVED
    # / in_maintenance), the cluster shrink is slow but ongoing — let the
    # install continue and let `Verify final state` (at the very end of the
    # runbook) catch the case where it genuinely never completes.
    last_status, last_maint = last_state if last_state else (None, None)
    if last_status in ("TO_BE_REMOVED", "OK_TO_BE_REMOVED") or last_maint == "in_maintenance":
        wall = FAST_POLL_ITERS + SLOW_POLL_ITERS * SLOW_POLL_INTERVAL_SEC
        print(
            "[warn] node removal still in progress after ~%d s (last state: %s). "
            "Install continues; the cluster shrink will complete async, and "
            "Verify final state will surface a real stall." % (wall, last_state)
        )
        return 0

    print("[FAIL] node removal did not complete within the cap — cluster may "
          "be stuck. Last seen state: %s" % (last_state,))
    return 1


sys.exit(main())
