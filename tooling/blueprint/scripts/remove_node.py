#script

"""
Idempotent node-removal: looks for a host whose name ends in '-4' on the
AOS cluster and removes it. POSTs the action, then polls /hosts until the
host disappears from the cluster's host list (or a deadline hits).

Two early-exit cases that print and return 0:
  1. CLUSTER_PROFILE='other' — never touch a non-hpoc cluster's hardware.
  2. No '-4' host present (already trimmed by an earlier launch).

remove-node returns 202 + a task that runs prechecks first. With Nutanix
Files + EC-X still present, those prechecks fail ("not enough NODES to
meet Erasure Code settings") until Curator finishes un-coding the strips
that `Disable erasure coding` (the task before this one) freed up. Rather
than guess that drain time, we re-POST on every EC precheck failure until
it passes, or hit a long cap. Any non-EC failure is fatal right away.

Poll loops are iteration-bounded (each GET's round-trip is the rate
limiter — time.sleep is unreliable in the Calm escript sandbox).

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

PC_BASE = "https://%s:9440" % PC_IP
BASE = "%s/api/clustermgmt/v4.0" % PC_BASE
# remove-node is driven on v4.2 (the version whose precheck reports the
# EC-X blocker we retry on); the host list stays on v4.0 (unchanged).
REMOVE_BASE = "%s/api/clustermgmt/v4.2" % PC_BASE
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

# remove-node precheck retry: the task FAILs within a couple seconds on an
# EC-X block, so a short task-poll catches it; if it's still RUNNING past
# that window the precheck passed and the shrink is underway. On an EC
# failure we wait EC_RETRY_GAP_SEC and re-POST, up to EC_RETRY_ATTEMPTS
# times (~30 min of Curator drain headroom).
TASK_PRECHECK_ITERS = 12      # 12 × 2 s ≈ 24 s window to catch the precheck verdict
TASK_PRECHECK_INTERVAL_SEC = 2
EC_RETRY_ATTEMPTS = 60
EC_RETRY_GAP_SEC = 30


def list_hosts():
    r = requests.get(
        "%s/config/clusters/%s/hosts" % (BASE, CLUSTER_UUID),
        auth=AUTH, headers=HEADERS, verify=False, timeout=30,
    )
    r.raise_for_status()
    return r.json().get('data') or []


def _task_failure_text(task_data):
    """Concatenate the human-readable error text from a failed task so we
    can tell an EC-X precheck block apart from a real failure."""
    parts = [task_data.get('legacyErrorMessage') or '']
    for m in (task_data.get('errorMessages') or []):
        if isinstance(m, dict):
            parts.append(m.get('message') or '')
        else:
            parts.append(str(m))
    return ' '.join(parts)


def _is_ec_block(text):
    t = (text or '').lower()
    return 'erasure code' in t or 'erasure coding' in t


def attempt_remove(node_uuid):
    """POST remove-node and watch its task long enough to classify the
    precheck outcome. Returns one of:
      'started'    — precheck passed, removal underway (or task already done)
      'ec_blocked' — precheck FAILed on the EC-X requirement (retryable)
      'failed'     — POST rejected or precheck FAILed for another reason
    """
    body = {"nodeUuids": [node_uuid]}
    r = requests.post(
        "%s/config/clusters/%s/$actions/remove-node" % (REMOVE_BASE, CLUSTER_UUID),
        auth=AUTH, headers=HEADERS, verify=False, timeout=60,
        json=body,
    )
    if r.status_code >= 400:
        print("[FAIL] remove-node POST: %d %s" % (r.status_code, r.text[:300]))
        return 'failed'

    task_ext_id = (r.json().get('data') or {}).get('extId')
    if not task_ext_id:
        # No task to inspect — assume accepted and let the /hosts poll judge.
        print("  remove-node accepted (HTTP %d, no task ref) — polling hosts" % r.status_code)
        return 'started'

    task_url = "%s/api/prism/v4.2/config/tasks/%s" % (PC_BASE, task_ext_id)
    for _ in range(TASK_PRECHECK_ITERS):
        try:
            tr = requests.get(task_url, auth=AUTH, headers=HEADERS, verify=False, timeout=30)
            data = tr.json().get('data') or {}
        except Exception as e:
            print("  task poll error: %s — retrying" % str(e)[:120])
            continue
        status = data.get('status')
        if status in ('FAILED', 'CANCELED', 'CANCELLED'):
            text = _task_failure_text(data)
            if _is_ec_block(text):
                print("  remove-node precheck blocked by EC-X: %s" % text.strip()[:200])
                return 'ec_blocked'
            print("[FAIL] remove-node task %s: %s" % (status, text.strip()[:300]))
            return 'failed'
        if status == 'SUCCEEDED':
            return 'started'
        # Still RUNNING/QUEUED — prechecks run first, so surviving this window
        # means they passed and the shrink is underway. Sleep so the window is
        # real wall-clock, not a 1-2 s busy-poll that would exit before a
        # slow precheck even fails (the patcher maps time.sleep to a ~N s shim).
        time.sleep(TASK_PRECHECK_INTERVAL_SEC)
    print("  remove-node task still running past precheck window — shrink underway")
    return 'started'


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
    # Only shrink if a 4th node exists to give up — removal must leave ≥3 (RF2
    # floor). Guards a mis-shaped 3-node cluster with a stray '-4' host name.
    if len(hosts) < 4:
        print("[skip] cluster has %d node(s) (<4) — not removing any (a shrink "
              "here would drop below the 3-node floor)" % len(hosts))
        return 0
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

    # Re-launch during an in-progress shrink: host-4 is still listed but
    # already on its way out — don't re-POST, just poll it to completion.
    already_leaving = (
        target.get('nodeStatus') in ('TO_BE_REMOVED', 'OK_TO_BE_REMOVED')
        or target.get('maintenanceState') == 'in_maintenance'
    )
    if already_leaving:
        print("  host-4 already %s/%s — removal in progress, polling..." %
              (target.get('nodeStatus'), target.get('maintenanceState')))
    else:
        # Retry the remove-node POST while the precheck keeps failing on
        # EC-X (Curator still dis-encoding). Any other failure is fatal.
        for attempt in range(EC_RETRY_ATTEMPTS):
            outcome = attempt_remove(node_uuid)
            if outcome == 'started':
                break
            if outcome == 'failed':
                return 1
            # ec_blocked — let Curator drain more strips, then retry.
            print("  EC strips not fully undone yet (attempt %d/%d) — waiting %ds"
                  % (attempt + 1, EC_RETRY_ATTEMPTS, EC_RETRY_GAP_SEC))
            time.sleep(EC_RETRY_GAP_SEC)
        else:
            print("[FAIL] remove-node precheck still EC-blocked after %d attempts — "
                  "Curator hasn't finished dis-encoding. Re-launch to resume." % EC_RETRY_ATTEMPTS)
            return 1
        print("  remove-node precheck passed, polling for removal...")

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
