#script

"""
1:1 port of the legacy CreateProdVMs.sh — creates 7 hardcoded VMs in the
`production` project, tagged Environment=Production, on the `secondary`
subnet, cloned from the Ubuntu2204 image. Assigns their project via v3
API (v4 doesn't expose project assignment yet).

Power: on `hpoc` (dedicated cluster) the VMs are powered ON. On `other`
(shared cluster) they are created + project-assigned but left powered
OFF — the player still sees the production inventory for the AD-login
narrative, but we don't burn compute on a cluster we don't own.

Idempotent: skips a VM if a VM with the same name already exists.

Calm injects @@{PC_IP}@@, @@{PC_USERNAME}@@, @@{PC_PASSWORD}@@,
@@{Game.CLUSTERUUID}@@, @@{Game.ProjectUUID}@@, @@{CLUSTER_PROFILE}@@.
"""

import json
import sys
import time
import urllib3

import requests

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

PC_IP = '@@{PC_IP}@@'
PC_USERNAME = '@@{PC_USERNAME}@@'
PC_PASSWORD = '@@{PC_PASSWORD}@@'
CLUSTER_UUID = '@@{Game.CLUSTERUUID}@@'
PROJECT_UUID = '@@{Game.ProjectUUID}@@'
CLUSTER_PROFILE = '@@{CLUSTER_PROFILE}@@'

CAT_KEY = "Environment"
CAT_VALUE = "Production"
PROJECT_NAME = "production"
IMAGE_NAME = "Ubuntu2204"
SECONDARY_SUBNET_NAME = "secondary"

VM_SPECS = [
    {"name": "prd-ransom-probe-1",        "numSockets": 2, "memorySizeGB": 4},
    {"name": "prd-ransom-payment-core",   "numSockets": 2, "memorySizeGB": 4},
    {"name": "prd-ransom-payment-front",  "numSockets": 2, "memorySizeGB": 4},
    {"name": "beta-ransom-engine-v2.2",   "numSockets": 2, "memorySizeGB": 4},
    {"name": "prd-mail",                  "numSockets": 2, "memorySizeGB": 4},
    {"name": "prd-directory",             "numSockets": 2, "memorySizeGB": 4},
    {"name": "prd-scan",                  "numSockets": 2, "memorySizeGB": 4},
]

BASE = "https://%s:9440" % PC_IP
AUTH = (PC_USERNAME, PC_PASSWORD)
HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}


def _req_retry(method, url, attempts=5, backoff=4, timeout=20, **kwargs):
    """GET/POST with retry on transient 5xx + network errors. PC's v3/v4 list
    endpoints throw sporadic 500s when the cluster is busy (aplos under load
    during a deploy) — a single blip shouldn't fail the whole task. This is
    what bit `Create Prod VMs` once (500 on v3/images/list). Mirrors the
    retry loops in setup_production_project.py. Read-only lookups only — never
    wrap the VM-create POST (retrying a mutation risks double-create)."""
    last = None
    for i in range(attempts):
        try:
            r = requests.request(method, url, auth=AUTH, headers=HEADERS,
                                  verify=False, timeout=timeout, **kwargs)
        except requests.RequestException as e:
            last = "network error: %s" % str(e)[:200]
        else:
            if r.status_code < 500:
                return r
            last = "%d %s" % (r.status_code, r.text[:200])
        if i < attempts - 1:
            print("  [retry %d/%d] %s -> %s" % (i + 1, attempts, url.split('?')[0], last))
            time.sleep(backoff)
    raise Exception("request failed after %d attempts: %s %s -> %s"
                    % (attempts, method, url, last))


def get_category_uuid():
    r = _req_retry(
        "GET",
        "%s/api/prism/v4.0/config/categories?$filter=(key eq '%s') and (value eq '%s')"
        % (BASE, CAT_KEY, CAT_VALUE),
    )
    r.raise_for_status()
    data = r.json().get('data') or []
    return data[0]['extId'] if data else None


def get_subnet_uuid(name):
    r = _req_retry(
        "GET", "%s/api/networking/v4.0/config/subnets?$limit=100" % BASE,
    )
    r.raise_for_status()
    subs = r.json().get('data') or []
    name_lc = (name or '').lower()
    for s in subs:
        if (s.get('name') or '').lower() == name_lc:
            return s['extId']
    # Tolerate cluster-prefixed names (e.g. `secondary-<cluster>`), casing
    # included; same pattern as setup_production_project.get_subnet_uuid.
    for s in subs:
        if (s.get('name') or '').lower().startswith(name_lc + '-'):
            return s['extId']
    return None


def get_image_uuid():
    """Image was registered when Calm provisioned the Game VM substrate."""
    r = _req_retry(
        "POST", "%s/api/nutanix/v3/images/list" % BASE,
        data=json.dumps({"kind": "image", "length": 100}),
    )
    r.raise_for_status()
    for image in r.json().get('entities') or []:
        if image.get('status', {}).get('name') == IMAGE_NAME:
            return image['metadata']['uuid']
    return None


def vm_exists(name):
    r = requests.get(
        "%s/api/vmm/v4.0/ahv/config/vms?$filter=name eq '%s'" % (BASE, name),
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
    )
    if r.status_code >= 400:
        return False
    return bool(r.json().get('data'))


def create_vm(spec, cat_uuid, subnet_uuid, image_uuid):
    body = {
        "name": spec['name'],
        "numSockets": spec['numSockets'],
        "memorySizeBytes": spec['memorySizeGB'] * 1024 * 1024 * 1024,
        "cluster": {"extId": CLUSTER_UUID},
        "categories": [{"extId": cat_uuid}],
        "nics": [
            {
                "backingInfo": {
                    "$objectType": "vmm.v4.ahv.config.EmulatedNic",
                    "isConnected": True,
                    "numQueues": 1,
                },
                "networkInfo": {"subnet": {"extId": subnet_uuid}},
            }
        ],
        "disks": [
            {
                "diskAddress": {"busType": "SCSI", "index": 0},
                "backingInfo": {
                    "$objectType": "vmm.v4.ahv.config.VmDisk",
                    "diskSizeBytes": 42949672960,
                    "dataSource": {
                        "reference": {
                            "$objectType": "vmm.v4.ahv.config.ImageReference",
                            "imageExtId": image_uuid,
                        }
                    },
                },
            }
        ],
    }
    r = requests.post(
        "%s/api/vmm/v4.0/ahv/config/vms" % BASE,
        auth=AUTH, headers=HEADERS, verify=False, timeout=60,
        data=json.dumps(body),
    )
    if r.status_code >= 400:
        return False, "%d %s" % (r.status_code, r.text[:200])
    return True, "created"


def assign_project_and_set_power(vm_name, power_on):
    """Wait for the VM to appear, then PUT v3 with project + power_state.
    v4 doesn't expose project assignment yet — v3 round-trip required.
    `power_on=False` (shared `other` cluster) leaves the VM created +
    project-assigned but powered OFF.

    Iteration-based poll (sandbox time.time() is a counter; time.sleep() may
    no-op). Each /vms?$filter GET takes ~0.5-1s naturally → MAX_POLLS=300 is
    ~3-5 min real wall-clock without trusting sleep."""
    MAX_POLLS = 300
    vm_uuid = None
    for _ in range(MAX_POLLS):
        r = requests.get(
            "%s/api/vmm/v4.0/ahv/config/vms?$filter=name eq '%s'" % (BASE, vm_name),
            auth=AUTH, headers=HEADERS, verify=False, timeout=20,
        )
        if r.status_code == 200:
            data = r.json().get('data') or []
            if data:
                vm_uuid = data[0]['extId']
                break
    if not vm_uuid:
        return False, "VM did not appear within %d polls" % MAX_POLLS

    r = requests.get(
        "%s/api/nutanix/v3/vms/%s" % (BASE, vm_uuid),
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
    )
    if r.status_code >= 400:
        return False, "v3 GET: %d" % r.status_code
    info = r.json()
    info.pop('status', None)  # v3 PUT rejects status
    info['metadata']['project_reference'] = {
        "kind": "project", "name": PROJECT_NAME, "uuid": PROJECT_UUID,
    }
    info['spec']['resources']['power_state'] = 'ON' if power_on else 'OFF'
    r = requests.put(
        "%s/api/nutanix/v3/vms/%s" % (BASE, vm_uuid),
        auth=AUTH, headers=HEADERS, verify=False, timeout=30,
        data=json.dumps(info),
    )
    if r.status_code != 202:
        return False, "v3 PUT: %d %s" % (r.status_code, r.text[:200])
    return True, "project assigned + powered %s" % ("ON" if power_on else "OFF")


def main():
    if not CLUSTER_UUID or not PROJECT_UUID:
        print("[FAIL] CLUSTER_UUID and ProjectUUID required (run upstream tasks first)")
        return 2

    cat_uuid = get_category_uuid()
    if not cat_uuid:
        print("[FAIL] category %s:%s not found on PC" % (CAT_KEY, CAT_VALUE))
        return 1
    subnet_uuid = get_subnet_uuid(SECONDARY_SUBNET_NAME)
    if not subnet_uuid:
        print("[FAIL] subnet '%s' not found" % SECONDARY_SUBNET_NAME)
        return 1
    image_uuid = get_image_uuid()
    if not image_uuid:
        print("[FAIL] image '%s' not found — Calm should have registered it during VM provisioning" % IMAGE_NAME)
        return 1

    power_on = CLUSTER_PROFILE == 'hpoc'
    if not power_on:
        print("[info] CLUSTER_PROFILE=%r — prod VMs created + project-assigned but "
              "left powered OFF (shared cluster: visible for the AD-login narrative, "
              "no compute burned)." % CLUSTER_PROFILE)

    for spec in VM_SPECS:
        if vm_exists(spec['name']):
            print("  [skip] %-30s already present" % spec['name'])
            continue
        ok, msg = create_vm(spec, cat_uuid, subnet_uuid, image_uuid)
        if not ok:
            print("  [FAIL] %-30s — %s" % (spec['name'], msg))
            continue
        print("  [ok]   %-30s — %s" % (spec['name'], msg))
        ok, msg = assign_project_and_set_power(spec['name'], power_on)
        if not ok:
            print("        post-create: [FAIL] %s" % msg)
        else:
            print("        post-create: [ok]   %s" % msg)
    return 0


sys.exit(main())
