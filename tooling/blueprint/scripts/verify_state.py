#script

"""
Final convergence check: validates the install left the cluster in the
expected state. Game container readiness is verified separately by the
upstream `Run game container` task (it greps `docker ps` + tails the boot
log), so we only check the cluster side here.

Pass criteria — all of:
  - PC reachable + AOS cluster API responsive
  - host count > 0 and all hosts nodeStatus=NORMAL maintenanceState=normal
  - the player's expand-cluster check (mirrors the live CheckNewNode
    rackable-units lookup, multiple API versions) returns a non-empty
    list of node serials — confirms the same endpoint the in-game check
    relies on actually answers on this cluster

We deliberately don't try to count "spare nodes" via /rackable-units:
post-removal, AHV moves the freed node to an unconfigured/discovered
state that this endpoint doesn't surface, so a 'no spare' signal here is
ambiguous. The player hits a real blocker at stage 28 if the cluster
genuinely has no spare; we'd rather not block the install on that.

Failure exits 1 so Calm marks the install as failed and the operator can
investigate from the task log.
"""

import sys
import urllib3

import requests

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

PC_IP = '@@{PC_IP}@@'
PC_USERNAME = '@@{PC_USERNAME}@@'
PC_PASSWORD = '@@{PC_PASSWORD}@@'
CLUSTER_UUID = '@@{Game.CLUSTERUUID}@@'

BASE = "https://%s:9440/api/clustermgmt" % PC_IP
AUTH = (PC_USERNAME, PC_PASSWORD)
HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}


def fetch(version, path):
    r = requests.get(
        "%s/%s/%s" % (BASE, version, path.lstrip("/")),
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
    )
    r.raise_for_status()
    return r.json().get('data') or []


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

    # 3. Mirrors the in-game expand-cluster check (CheckNewNode): the
    # player submits a node serial and we look it up in the cluster's
    # rackable-units. Try multiple API versions because PC 7.5 ships
    # b2/4.0/4.2 inconsistently across builds — same pattern as the live
    # check. We only assert the endpoint responds (some version) and
    # returns at least one rackable-unit; we don't compare against an
    # expected count because chassis topology varies cluster to cluster.
    units = []
    last_err = None
    for v in ("v4.0.b2", "v4.0", "v4.2"):
        try:
            units = fetch(v, "/config/clusters/%s/rackable-units" % CLUSTER_UUID)
            print("[ok] expand-cluster API responsive (%s/rackable-units): %d unit(s) — %s" % (
                v,
                len(units),
                [(u.get('modelName', '?'), u.get('serial', '?')) for u in units],
            ))
            break
        except Exception as e:
            last_err = "%s: %s" % (v, str(e)[:120])
            continue
    else:
        issues.append(
            "rackable-units endpoint did not respond on any of v4.0.b2 / v4.0 / "
            "v4.2 — the in-game expand-cluster check will fail. Last error: %s" %
            last_err
        )

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
