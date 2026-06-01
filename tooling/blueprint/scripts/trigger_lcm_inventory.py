#script

"""
Port of the legacy LaunchInventory.sh — fires a Life Cycle Manager
inventory scan so the in-game stage 29 `lcm-check-updates` finds fresh
update entities. Without this, the player can hit a stale or empty
LCM list (PC normally scans on a schedule, not necessarily fresh after
provisioning).

Async by design: the API returns 202 + a task UUID immediately; the
inventory itself runs in the background on the PC. We don't wait for
it — the game won't reach stage 29 for many minutes.

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


def main():
    # The v4 LCM action is `inventory` (NOT `perform-inventory` — that
    # path 404s, the bug seen in the 2026-06-01 run). v4.2 (PC 7.3+) is
    # the only version we target: verified live = 202 with a `{}` body.
    # No older fallback — v4.0 rejects any body ("No request body is
    # expected"), so it'd 400 anyway on the 7.5 HPoC we ship to.
    path = "/api/lifecycle/v4.2/operations/$actions/inventory"
    r = requests.post(BASE + path, auth=AUTH, headers=HEADERS,
                      verify=False, timeout=20, data="{}")
    if r.status_code in (200, 201, 202):
        print("[ok]   LCM inventory triggered via %s — task running async" % path)
        return 0

    # Failed. Best-effort log + non-fatal exit (the LCM scan might still
    # fire from the regular scheduler before the player reaches stage 29).
    print("[warn] could not trigger LCM inventory: %s -> %d %s — relying on PC's scheduler"
          % (path, r.status_code, r.text[:200]))
    return 0


sys.exit(main())
