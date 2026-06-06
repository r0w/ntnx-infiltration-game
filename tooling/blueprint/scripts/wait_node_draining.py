#script

"""
Gate that holds `Activate policy engine` (Branch 2) until the 4th host has
left the scheduling pool, so the Calm Policy VM is never placed on the node
that `Remove 4th host on HPoC` (Branch 1) is tearing down.

Branch 1 fires the remove-node POST and polls until the host is gone; this
script does NOT trigger anything — it only observes. It returns 0 as soon as
the '-4' host reaches a state where AHV/ADS will no longer place a fresh VM
on it:
  - host absent (already removed), OR
  - nodeStatus in {TO_BE_REMOVED, OK_TO_BE_REMOVED}, OR
  - maintenanceState == 'in_maintenance'.

Three early-exit cases that print and return 0 WITHOUT waiting (so the deploy
never stalls when there's no shrink to wait for):
  1. CLUSTER_PROFILE != 'hpoc' — Branch 1's removal is skipped too, no race.
  2. No '-4' host present (already trimmed / single-node).
  3. The poll cap is hit while host-4 is still NORMAL — Branch 1's removal
     likely never started (failed POST); activating the policy engine is
     harmless then (no node leaving), so warn and proceed rather than block.

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

# We only wait for the NORMAL → maintenance transition (seconds to ~1-2 min
# once Branch 1 POSTs the removal), not the full shrink. Cap at ~5 min: fast
# poll for the first ~30 s, then every 15 s for ~4.5 min. If we never see the
# transition, proceed anyway (see early-exit #3).
FAST_POLL_ITERS = 30          # ~30 s
SLOW_POLL_ITERS = 18          # 18 × 15 s = 4.5 min
SLOW_POLL_INTERVAL_SEC = 15

# nodeStatus values that mean the host is on its way out — ADS won't place a
# new VM on it once it shows any of these (or once it's in maintenance).
LEAVING_STATES = ("TO_BE_REMOVED", "OK_TO_BE_REMOVED")


def list_hosts():
    r = requests.get(
        "%s/config/clusters/%s/hosts" % (BASE, CLUSTER_UUID),
        auth=AUTH, headers=HEADERS, verify=False, timeout=30,
    )
    r.raise_for_status()
    return r.json().get('data') or []


def is_draining(host):
    """True once the host has left the scheduling pool."""
    status = host.get('nodeStatus')
    maint = host.get('maintenanceState')
    return status in LEAVING_STATES or maint == 'in_maintenance'


def main():
    if CLUSTER_PROFILE != 'hpoc':
        print(
            "[skip] CLUSTER_PROFILE=%r — no node removal happens, so no "
            "placement race. Activating policy engine immediately." % CLUSTER_PROFILE
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
        print("[skip] no host ending in '-4' (cluster has %d nodes: %s) — "
              "nothing to drain, activating policy engine now." % (len(hosts), names))
        return 0

    node_uuid = target['extId']
    print("Waiting for host=%s (ext_id=%s) to leave the scheduling pool "
          "before policy-engine activation ..." % (target.get('hostName'), node_uuid))

    last_state = None

    def check_once(label):
        try:
            current = list_hosts()
        except Exception as e:
            print("  [%s] /hosts error: %s — retrying" % (label, str(e)[:120]))
            return None
        still = next((h for h in current if h.get('extId') == node_uuid), None)
        if not still:
            return ("gone", None)
        if is_draining(still):
            return ("draining", (still.get('nodeStatus'), still.get('maintenanceState')))
        return ("normal", (still.get('nodeStatus'), still.get('maintenanceState')))

    # Phase 1 — fast (network round-trip is the rate limiter).
    for i in range(FAST_POLL_ITERS):
        result = check_once("fast %d" % i)
        if result is None:
            continue
        kind, payload = result
        if kind == "gone":
            print("[ok] host-4 already removed — safe to activate policy engine "
                  "(fast phase, ~%d s)." % (i + 1))
            return 0
        if kind == "draining":
            print("[ok] host-4 draining (state=%s) — safe to activate policy "
                  "engine (fast phase, ~%d s)." % (payload, i + 1))
            return 0
        if payload != last_state:
            print("  [fast %d] host-4 state: %s (still schedulable, waiting)" % (i, payload))
            last_state = payload

    # Phase 2 — slow.
    print("  --- switching to slow polling (every %d s) ---" % SLOW_POLL_INTERVAL_SEC)
    for i in range(SLOW_POLL_ITERS):
        result = check_once("slow %d" % i)
        if result is not None:
            kind, payload = result
            wall = FAST_POLL_ITERS + (i + 1) * SLOW_POLL_INTERVAL_SEC
            if kind == "gone":
                print("[ok] host-4 removed after ~%d s — safe to activate policy engine." % wall)
                return 0
            if kind == "draining":
                print("[ok] host-4 draining (state=%s) after ~%d s — safe to "
                      "activate policy engine." % (payload, wall))
                return 0
            if payload != last_state:
                print("  [slow %d / +%d s] host-4 state: %s (still schedulable)" %
                      (i, (i + 1) * SLOW_POLL_INTERVAL_SEC, payload))
                last_state = payload
        time.sleep(SLOW_POLL_INTERVAL_SEC)

    # Cap hit with host-4 still NORMAL — Branch 1's removal likely never fired.
    # Activating the policy engine is harmless when no node is leaving, so
    # proceed rather than block the install.
    wall = FAST_POLL_ITERS + SLOW_POLL_ITERS * SLOW_POLL_INTERVAL_SEC
    print(
        "[warn] host-4 still schedulable after ~%d s (last state: %s). The "
        "node-removal in Branch 1 may not have started; proceeding to activate "
        "the policy engine anyway (no node leaving = no placement race)." %
        (wall, last_state)
    )
    return 0


sys.exit(main())
