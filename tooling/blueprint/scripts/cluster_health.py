#script

"""
Wait until the cluster is healthy after the node-removal.

Replaces the legacy `Delay 900s` task: instead of sleeping a flat 15 min,
poll `/clustermgmt/v4.0/config/clusters/{uuid}/hosts` until the cluster
has stabilized, then exit. Caps at MAX_POLLS so a stuck removal is
surfaced as a Calm task failure rather than a silent indefinite wait.

Pacing note: the loop is iteration-based, NOT wall-clock-based. Two
sandbox quirks force this:
  - `time.sleep(N)` is rewritten by the patcher to a TCP-timeout shim
    (`requests.get('http://192.0.2.1/', timeout=N)`) that returns
    instantly on networks where 192.0.2.1 isn't a black-hole — so we
    can't trust it to actually pause N seconds.
  - `time.time()` is rewritten to `_fake_time()`, an incrementing
    counter (1, 2, 3, …) — useless as a wall-clock deadline.
Each iteration here makes one `list_hosts()` API call which naturally
takes ~1 s on the Calm VM, so MAX_POLLS ≈ wall-clock seconds of cap.

Stability criterion (must hold across STABLE_POLLS_REQUIRED consecutive
polls):
  - host count > 0
  - the set of (hostName, nodeStatus, maintenanceState) tuples did not
    change since the previous poll
  - every host has nodeStatus == 'NORMAL' and maintenanceState == 'normal'

We do NOT key on a specific hostname pattern (`-4`, etc.): the node-removal
script picks whatever idle host the chassis exposes, and on this HPoC the
removed node varies (e.g. `-3`). A stable, all-NORMAL host list is enough.

Calm injects `@@{PC_IP}@@`, `@@{PC_USERNAME}@@`, `@@{PC_PASSWORD}@@`.
Run as a `CalmTask.Exec.escript.py3` task right after `Remove 1 host`.
"""

import sys
import urllib3

import requests

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

PC_IP = '@@{PC_IP}@@'
PC_USERNAME = '@@{PC_USERNAME}@@'
PC_PASSWORD = '@@{PC_PASSWORD}@@'

MAX_POLLS = 3600
STABLE_POLLS_REQUIRED = 30

BASE = "https://%s:9440/api/clustermgmt/v4.0" % PC_IP
AUTH = (PC_USERNAME, PC_PASSWORD)
HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}


def get_aos_cluster_uuid():
    r = requests.get("%s/config/clusters" % BASE, auth=AUTH, headers=HEADERS, verify=False, timeout=20)
    r.raise_for_status()
    for cluster in (r.json().get('data') or []):
        if "AOS" in cluster.get('config', {}).get('clusterFunction', []):
            return cluster['extId'], cluster.get('name', '?')
    raise RuntimeError("No AOS cluster found in PC %s" % PC_IP)


def list_hosts(cluster_uuid):
    r = requests.get(
        "%s/config/clusters/%s/hosts" % (BASE, cluster_uuid),
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
    )
    r.raise_for_status()
    return r.json().get('data') or []


def snapshot(hosts):
    return tuple(sorted(
        (h.get('hostName', '?'), h.get('nodeStatus', '?'), h.get('maintenanceState', '?'))
        for h in hosts
    ))


def main():
    cluster_uuid, cluster_name = get_aos_cluster_uuid()
    print("Polling cluster %s (%s) for stabilization, max %d polls (~%d min wall-clock)" %
          (cluster_name, cluster_uuid, MAX_POLLS, MAX_POLLS // 60))

    last_snapshot = None
    stable_count = 0

    for poll in range(1, MAX_POLLS + 1):
        try:
            hosts = list_hosts(cluster_uuid)
        except Exception as e:
            print("[poll %d] hosts fetch failed: %s — retrying" % (poll, e))
            continue

        snap = snapshot(hosts)
        all_normal = all(h.get('nodeStatus') == 'NORMAL' for h in hosts)
        no_maintenance = all(h.get('maintenanceState') == 'normal' for h in hosts)
        host_count = len(hosts)
        stable = host_count > 0 and snap == last_snapshot and all_normal and no_maintenance

        if stable:
            stable_count += 1
            print("[poll %d] stable (%d/%d) — hosts=%d nodeStatus=NORMAL maintenance=normal" %
                  (poll, stable_count, STABLE_POLLS_REQUIRED, host_count))
            if stable_count >= STABLE_POLLS_REQUIRED:
                names = [h.get('hostName') for h in hosts]
                print("Cluster healthy after %d polls. Hosts: %s" % (poll, names))
                return 0
        else:
            stable_count = 0
            print("[poll %d] not yet — hosts=%d all-NORMAL=%s no-maintenance=%s churn=%s" %
                  (poll, host_count, all_normal, no_maintenance, snap != last_snapshot))

        last_snapshot = snap

    print("TIMEOUT after %d polls. Last snapshot: %s" % (MAX_POLLS, last_snapshot))
    return 1


sys.exit(main())
