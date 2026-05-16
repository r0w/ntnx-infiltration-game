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


def fetch(version, path):
    r = requests.get(
        "%s/%s/%s" % (BASE, version, path.lstrip("/")),
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
    )
    r.raise_for_status()
    return r.json().get('data') or []


def discover_unconfigured_nodes(cluster_uuid, timeout_secs=60):
    """Fires the discover-unconfigured-nodes task + polls until SUCCEEDED.
    Returns (nodeList, err_msg). nodeList may be empty (= no spare nodes
    on this cluster, legitimate on single-chassis HPoCs)."""
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

    # Poll the task. Same Python semantics: 5 s interval, 3 min deadline.
    task_url = "%s/api/prism/v4.2/config/tasks/%s" % (PC_BASE, task_ext_id)
    deadline = time.time() + timeout_secs
    last_status = None
    while time.time() < deadline:
        try:
            tr = requests.get(task_url, auth=AUTH, headers=HEADERS, verify=False, timeout=20)
            last_status = (tr.json().get('data') or {}).get('status')
            if last_status == 'SUCCEEDED':
                break
            if last_status in ('FAILED', 'CANCELED', 'CANCELLED'):
                return None, "discover task %s" % last_status
        except Exception:
            pass
        time.sleep(5)
    else:
        return None, "discover task timed out (last status: %s)" % last_status

    short_id = task_ext_id.split(':')[-1]
    resp_url = (
        "%s/api/clustermgmt/v4.2/config/task-response/%s?taskResponseType=UNCONFIGURED_NODES"
        % (PC_BASE, short_id)
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
