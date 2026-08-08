#script

"""
Final convergence check: validates the install left the cluster in the
expected state. Game container readiness is verified separately by the
upstream `Run game container` task (it greps `docker ps` + tails the boot
log), so we only check the cluster side here.

Pass criteria — all of:
  - PC reachable + AOS cluster API responsive
  - host count > 0 and all hosts nodeStatus=NORMAL maintenanceState=normal
  - the player's expand-cluster discovery endpoint
    (`/api/clustermgmt/v4.0.b2/.../$actions/discover-unconfigured-nodes`)
    responds with a parseable task — confirms the API the in-game
    CheckNewNode relies on is wired on this cluster. Empty discoverable
    nodeList is OK (single-node HPoC with no spare chassis — stage 28
    is auto-skipped via MultiNode/NodeRemove gates anyway). We only fail
    if the API itself is broken / returns no task.

Failure exits 1 so Calm marks the install as failed and the operator can
investigate from the task log.
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

PC_BASE = "https://%s:9440" % PC_IP
BASE = "%s/api/clustermgmt" % PC_BASE
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
        try:
            r = requests.get("%s/api/%s/%s/%s" % (PC_BASE, ns, v, probe),
                             auth=AUTH, headers=HEADERS, verify=False, timeout=30)
            code = r.status_code
        except Exception:
            # Unreachable, or a response we can't read a status off — treat
            # as "this version didn't answer" and try the next candidate.
            continue
        if code != 404:
            print("[ver]  %s -> %s" % (ns, v))
            _NS_VER[ns] = v
            return v
    # Nothing answered — the PC is unreachable, so the real call is about to
    # fail anyway. Fall back to the newest candidate rather than the oldest so
    # a transient blip can't silently downgrade a healthy 7.5 cluster.
    print("[ver]  %s -> %s (no probe answered, keeping newest)" % (ns, candidates[0]))
    _NS_VER[ns] = candidates[0]
    return candidates[0]


def fetch(version, path):
    r = requests.get(
        "%s/%s/%s" % (BASE, version, path.lstrip("/")),
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
    )
    r.raise_for_status()
    return r.json().get('data') or []


def discover_unconfigured_nodes(cluster_uuid, max_polls=60):
    """Fires the discover-unconfigured-nodes task + polls until SUCCEEDED.
    Returns (nodeList, err_msg). nodeList may be empty (= no spare nodes
    on this cluster, legitimate on single-chassis HPoCs).

    Iteration-based (Calm escript sandbox: time.time() is a counter,
    time.sleep() may no-op). Each /tasks GET takes ~0.5-1s naturally →
    max_polls=60 is ~30-60 s real wall-clock without trusting sleep."""
    discover_url = (
        "%s/api/clustermgmt/v4.0.b2/config/clusters/%s/$actions/discover-unconfigured-nodes"
        % (PC_BASE, cluster_uuid)
    )
    body = {"timeout": 60, "isManualDiscovery": False, "addressType": "IPV4"}
    try:
        r = requests.post(
            discover_url, auth=AUTH, headers=HEADERS, verify=False, timeout=30, json=body,
        )
    except Exception as e:
        return None, "POST discover failed: %s" % str(e)[:200]
    if r.status_code >= 400:
        return None, "POST discover: %d %s" % (r.status_code, r.text[:200])
    task_ext_id = (r.json().get('data') or {}).get('extId')
    if not task_ext_id:
        return None, "discover task missing extId"

    task_url = "%s/api/prism/%s/config/tasks/%s" % (
        PC_BASE, ns_version('prism', 'config/tasks?$limit=1'), task_ext_id)
    last_status = None
    succeeded = False
    for _ in range(max_polls):
        try:
            tr = requests.get(task_url, auth=AUTH, headers=HEADERS, verify=False, timeout=20)
            last_status = (tr.json().get('data') or {}).get('status')
            if last_status == 'SUCCEEDED':
                succeeded = True
                break
            if last_status in ('FAILED', 'CANCELED', 'CANCELLED'):
                return None, "discover task %s" % last_status
        except Exception:
            pass
    if not succeeded:
        return None, "discover task timed out after %d polls (last status: %s)" % (max_polls, last_status)

    short_id = task_ext_id.split(':')[-1]
    resp_url = (
        "%s/api/clustermgmt/%s/config/task-response/%s?taskResponseType=UNCONFIGURED_NODES"
        % (PC_BASE, ns_version('clustermgmt', 'config/clusters?$limit=1'), short_id)
    )
    try:
        rr = requests.get(resp_url, auth=AUTH, headers=HEADERS, verify=False, timeout=20)
        rr.raise_for_status()
        node_list = ((rr.json().get('data') or {}).get('response') or {}).get('nodeList') or []
        return node_list, None
    except Exception as e:
        return None, "GET task-response failed: %s" % str(e)[:200]


def main():
    issues = []

    if not CLUSTER_UUID:
        print("FAIL: CLUSTER_UUID not set in blueprint variables.")
        return 1

    # 1. PC reachability + cluster API
    try:
        clusters = fetch("v4.0", "/config/clusters")
        cluster = next((c for c in clusters if c.get('extId') == CLUSTER_UUID), None)
        if not cluster:
            issues.append("AOS cluster %s not found in PC's cluster list" % CLUSTER_UUID)
        else:
            print("[ok] PC reachable, AOS cluster %s responsive" % cluster.get('name'))
    except Exception as e:
        print("FAIL: PC unreachable or API error: %s" % e)
        return 1

    # 2. Host fleet stable + all NORMAL
    hosts = fetch("v4.0", "/config/clusters/%s/hosts" % CLUSTER_UUID)
    if not hosts:
        issues.append("no hosts returned by /hosts")
    abnormal = [h for h in hosts if h.get('nodeStatus') != 'NORMAL']
    in_maint = [h for h in hosts if h.get('maintenanceState') != 'normal']
    if abnormal:
        issues.append("hosts not NORMAL: %s" % [h.get('hostName') for h in abnormal])
    if in_maint:
        issues.append("hosts in maintenance: %s" % [h.get('hostName') for h in in_maint])
    if not (abnormal or in_maint or not hosts):
        names = [h.get('hostName') for h in hosts]
        print("[ok] %d host(s) all NORMAL: %s" % (len(hosts), names))

    # 3. Mirrors the in-game expand-cluster check (CheckNewNode): the player
    # submits a node serial that must be currently DISCOVERABLE (rackmounted,
    # not yet in the cluster). We only assert the discover task endpoint is
    # wired — empty nodeList is OK (single-chassis HPoC has no spare; the
    # in-game stage 28 is auto-skipped by MultiNode/NodeRemove gates anyway).
    node_list, err = discover_unconfigured_nodes(CLUSTER_UUID)
    if err is not None:
        issues.append(
            "discover-unconfigured-nodes endpoint did not work — the in-game "
            "expand-cluster check will fail. Reason: %s" % err
        )
    else:
        serials = [n.get('rackableUnitSerial', '?') for n in node_list]
        print("[ok] expand-cluster API responsive (discover-unconfigured-nodes): "
              "%d discoverable node(s) — %s" % (len(node_list), serials))

    if issues:
        print()
        print("FAIL — %d issue(s):" % len(issues))
        for i in issues:
            print("  - %s" % i)
        return 1

    print()
    print("All checks passed. Game install complete.")
    return 0


sys.exit(main())
