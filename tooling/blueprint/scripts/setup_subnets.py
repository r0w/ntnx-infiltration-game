#script

"""
Idempotent subnet prep — 1:1 port of three legacy install tasks:

  1. RenameNetworkifNeeded.sh      — if no `secondary` / `secondary-<cluster>`
                                     subnet, rename `aux-1` → `secondary`
  2. MigrateSecondarysubnettoadvanced.sh — make `secondary` advanced-networking
                                          (required for the 2-NIC VM in stage 12)
  3. CreateSubnetTestNetwork.sh    — create the `TestNetwork` subnet stage 35
                                     uses when launching CloneProd

Re-implemented as a single Calm escript.py3 (runs on the Calm runner with
`requests`) so we don't need a Python venv + ntnx_networking_py_client
on the deployed VM. Same end state as legacy.

Calm injects @@{PC_IP}@@, @@{PC_USERNAME}@@, @@{PC_PASSWORD}@@,
@@{Game.CLUSTERUUID}@@ (set upstream by Get Cluster).
"""

import json
import sys
import time
import urllib3
import uuid

import requests

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

PC_IP = '@@{PC_IP}@@'
PC_USERNAME = '@@{PC_USERNAME}@@'
PC_PASSWORD = '@@{PC_PASSWORD}@@'
CLUSTER_UUID = '@@{Game.CLUSTERUUID}@@'

BASE = "https://%s:9440" % PC_IP
AUTH = (PC_USERNAME, PC_PASSWORD)
HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}


def _retry(_fn, *args, **kwargs):
    """Retry on transient transport errors + 5xx (issue #28). Reads only — the
    rename/migrate/create writes stay single-shot (etag clash / duplicate risk)."""
    attempts = kwargs.pop("_attempts", 5)
    backoff = kwargs.pop("_backoff", 3)
    last = "no attempt made"
    for i in range(attempts):
        try:
            r = _fn(*args, **kwargs)
        except requests.RequestException as e:
            last = "network error: %s" % str(e)[:200]
        else:
            if r.status_code < 500:
                return r
            last = "%d %s" % (r.status_code, r.text[:200])
        if i < attempts - 1:
            print("  [retry %d/%d] %s" % (i + 1, attempts, last))
            time.sleep(backoff)
    raise Exception("request failed after %d attempts: %s" % (attempts, last))


def list_subnets():
    page = 0
    out = []
    while True:
        r = _retry(
            requests.get,
            "%s/api/networking/v4.0/config/subnets?$page=%d&$limit=100" % (BASE, page),
            auth=AUTH, headers=HEADERS, verify=False, timeout=20,
        )
        r.raise_for_status()
        data = r.json().get('data') or []
        if not data:
            break
        out.extend(data)
        if len(data) < 100:
            break
        page += 1
    return out


def get_subnet_by_id(ext_id):
    r = _retry(
        requests.get,
        "%s/api/networking/v4.0/config/subnets/%s" % (BASE, ext_id),
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
    )
    r.raise_for_status()
    return r.json(), r.headers.get('etag') or r.headers.get('ETag')


def _is_secondary(name):
    """Match the secondary subnet across naming conventions: some clusters
    name it bare `secondary`, others `secondary-<clusterName>`, and casing
    can vary. Same tolerant pattern as setup_production_project.get_subnet_uuid."""
    n = (name or '').lower()
    return n == 'secondary' or n.startswith('secondary-')


def rename_aux1_to_secondary(subnets):
    """Step 1: ensure there's a `secondary` (or `secondary-<cluster>`) subnet."""
    existing = next((s for s in subnets if _is_secondary(s.get('name'))), None)
    if existing:
        print("[skip] subnet %r already present — no rename" % existing.get('name'))
        return existing

    aux1 = next((s for s in subnets if s.get('name') == 'aux-1'), None)
    if not aux1:
        print("[FAIL] no subnet named 'secondary' or 'aux-1' — manual setup needed")
        return None

    body, etag = get_subnet_by_id(aux1['extId'])
    body_data = body.get('data') or body
    body_data['name'] = 'secondary'
    headers = dict(HEADERS)
    if etag:
        headers['If-Match'] = etag
    r = requests.put(
        "%s/api/networking/v4.0/config/subnets/%s" % (BASE, aux1['extId']),
        auth=AUTH, headers=headers, verify=False, timeout=30,
        data=json.dumps(body_data),
    )
    if r.status_code >= 400:
        print("[FAIL] rename aux-1 → secondary: %d %s" % (r.status_code, r.text[:200]))
        return None
    print("[ok]   renamed 'aux-1' → 'secondary'")
    return body_data


def migrate_secondary_to_advanced(secondary):
    """Step 2: flip the `secondary` subnet to advanced-networking mode."""
    if secondary.get('isAdvancedNetworking'):
        print("[skip] subnet 'secondary' already advanced-networking")
        return True

    ext_id = secondary['extId']
    _, etag = get_subnet_by_id(ext_id)
    headers = dict(HEADERS)
    headers['Ntnx-Request-Id'] = str(uuid.uuid4())
    if etag:
        headers['If-Match'] = etag
    r = requests.post(
        "%s/api/networking/v4.0.b2/config/$actions/migrate-subnets" % BASE,
        auth=AUTH, headers=headers, verify=False, timeout=30,
        data=json.dumps({"subnets": [{"subnetUuid": ext_id}]}),
    )
    if r.status_code >= 400:
        print("[FAIL] migrate-subnets: %d %s" % (r.status_code, r.text[:200]))
        return False
    print("[ok]   migrated 'secondary' to advanced-networking")
    return True


def create_test_network(subnets):
    """Step 3: create the `TestNetwork` subnet stage 35 (CloneProd) uses."""
    if any(s.get('name') == 'TestNetwork' for s in subnets):
        print("[skip] subnet 'TestNetwork' already present")
        return True

    if not CLUSTER_UUID:
        print("[FAIL] CLUSTER_UUID not set — Get Cluster must run first")
        return False

    body = {
        "name": "TestNetwork",
        "subnetType": "VLAN",
        "networkId": 1,
        "isAdvancedNetworking": True,
        "clusterReference": CLUSTER_UUID,
        "isExternal": True,
        "isNatEnabled": False,
        "ipPrefix": "192.168.1.0/25",
        "ipConfig": [
            {
                "ipv4": {
                    "ipSubnet": {
                        "ip": {"value": "192.168.1.0"},
                        "prefixLength": 24,
                    },
                    "defaultGatewayIp": {"value": "192.168.1.1"},
                    "poolList": [
                        {
                            "startIp": {"value": "192.168.1.2"},
                            "endIp": {"value": "192.168.1.250"},
                        }
                    ],
                }
            }
        ],
    }
    r = requests.post(
        "%s/api/networking/v4.0/config/subnets" % BASE,
        auth=AUTH, headers=HEADERS, verify=False, timeout=30,
        data=json.dumps(body),
    )
    if r.status_code >= 400:
        print("[FAIL] create TestNetwork: %d %s" % (r.status_code, r.text[:200]))
        return False
    print("[ok]   created subnet 'TestNetwork' (VLAN 1, 192.168.1.0/25)")
    return True


def main():
    subnets = list_subnets()
    print("PC has %d subnets" % len(subnets))

    secondary = rename_aux1_to_secondary(subnets)
    if not secondary:
        return 1

    # Re-list since the rename mutated the snapshot.
    subnets = list_subnets()
    secondary = next((s for s in subnets if _is_secondary(s.get('name'))), None)
    if not secondary:
        print("[FAIL] 'secondary' missing after rename — bailing")
        return 1
    if not migrate_secondary_to_advanced(secondary):
        return 1

    subnets = list_subnets()
    if not create_test_network(subnets):
        return 1

    return 0


sys.exit(main())
