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

Resumable: reuse matching VMs and finish their project and power configuration.

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
SECONDARY_SUBNET_NAME = '@@{GAME_SECONDARY_NETWORK}@@'.strip() or "secondary"

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


TASK_POLLS = 300


def wait_for_task(response, v3=False):
    """A 202 only accepts the mutation; wait for Nutanix's actual verdict."""
    payload = response.json()
    if v3:
        task_id = payload.get('status', {}).get('execution_context', {}).get('task_uuid')
        path = '/api/nutanix/v3/tasks/'
    else:
        task_id = (payload.get('data') or {}).get('extId')
        path = '/api/prism/v4.0/config/tasks/'
    if not task_id:
        return False, 'mutation response missing task reference; outcome unknown'

    last = 'no task response'
    for _ in range(TASK_POLLS):
        try:
            r = requests.get(BASE + path + task_id, auth=AUTH, headers=HEADERS,
                             verify=False, timeout=20)
            r.raise_for_status()
            task = r.json() if v3 else (r.json().get('data') or {})
        except (requests.RequestException, ValueError) as exc:
            last = str(exc)[:200]
        else:
            last = task.get('status', 'missing status')
            if last == 'SUCCEEDED':
                return True, 'task succeeded'
            if last in ('FAILED', 'CANCELED', 'CANCELLED'):
                messages = [task.get('legacyErrorMessage') or '',
                            task.get('error_detail') or '']
                messages.extend(('%s %s' % (m.get('code', ''), m.get('message', ''))) if isinstance(m, dict) else str(m)
                                for m in task.get('errorMessages', []))
                return False, 'task %s: %s' % (last, ' '.join(str(m) for m in messages if m))
        time.sleep(2)
    return False, 'task %s did not finish after %d polls (last: %s); outcome unknown' % (
        task_id, TASK_POLLS, last)


def _req_retry(method, url, attempts=5, backoff=4, timeout=20, **kwargs):
    """GET/POST with retry on transient 5xx + network errors. PC's v3/v4 list
    endpoints throw sporadic 500s when the cluster is busy (aplos under load
    during a deploy) — a single blip shouldn't fail the whole task. This is
    what bit `Create Prod VMs` once (500 on v3/images/list). Mirrors the
    retry loops in setup_production_project.py. Read-only lookups only — never
    wrap the VM-create POST (retrying a mutation risks double-create)."""
    last = None
    for i in range(attempts):
        delay = backoff
        try:
            r = requests.request(method, url, auth=AUTH, headers=HEADERS,
                                  verify=False, timeout=timeout, **kwargs)
        except requests.RequestException as e:
            last = "network error: %s" % str(e)[:200]
        else:
            if r.status_code < 500 and r.status_code != 429:
                return r
            last = "%d %s" % (r.status_code, r.text[:200])
            retry_after = r.headers.get('Retry-After', '')
            if retry_after.isdigit():
                delay = max(backoff, int(retry_after))
                if delay > 300:
                    raise Exception('API asks for a retry after %ds; resume installation later' % delay)
        if i < attempts - 1:
            print("  [retry %d/%d] %s -> %s" % (i + 1, attempts, url.split('?')[0], last))
            time.sleep(delay)
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
    subs = []
    for page in range(200):
        r = _req_retry("GET", "%s/api/networking/v4.0/config/subnets?$limit=100&$page=%d" % (BASE, page))
        r.raise_for_status()
        chunk = r.json().get('data') or []
        subs.extend(chunk)
        if len(chunk) < 100:
            break
    name_lc = name.lower()
    matches = [s for s in subs if (s.get('name') or '').lower() == name_lc]
    if not matches and name_lc == 'secondary':
        matches = [s for s in subs if (s.get('name') or '').lower().startswith('secondary-')]
    if len(matches) > 1:
        raise ValueError("Multiple networks match %r; configure the exact name" % name)
    return matches[0]['extId'] if matches else None


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


def find_vm(name):
    r = _req_retry(
        'GET', "%s/api/vmm/v4.0/ahv/config/vms" % BASE,
        params={'$filter': "name eq '%s'" % name, '$limit': 100,
                '$select': 'extId,name,cluster,categories,nics'},
    )
    r.raise_for_status()  # Failed inventory reads must never mean 'absent'.
    matches = r.json().get('data') or []
    if len(matches) > 1:
        raise Exception('Multiple VMs named %s; resolve the ambiguity before resuming' % name)
    return matches[0] if matches else None


def validate_existing_vm(vm, cat_uuid, subnet_uuid):
    if (vm.get('cluster') or {}).get('extId') != CLUSTER_UUID:
        raise Exception('Existing VM belongs to another cluster; refusing to reuse it')
    categories = [c.get('extId') for c in vm.get('categories') or []]
    subnets = [((n.get('networkInfo') or n.get('nicNetworkInfo') or {}).get('subnet') or {}).get('extId')
               for n in vm.get('nics') or []]
    if cat_uuid not in categories or subnet_uuid not in subnets:
        raise Exception('Existing VM does not match the production category/network; inspect it before resuming')


def ensure_vm(spec, cat_uuid, subnet_uuid, image_uuid):
    for attempt in range(3):
        vm = find_vm(spec['name'])
        if vm:
            validate_existing_vm(vm, cat_uuid, subnet_uuid)
            return True, 'existing VM verified; completing project and power configuration'
        ok, message = create_vm(spec, cat_uuid, subnet_uuid, image_uuid)
        if ok:
            return True, message
        # Only retry a confirmed failed task. A timeout or lost POST response
        # can still create a VM later; leave that task for operator inspection.
        retryable = message.startswith('task FAILED:') and any(
            code in message for code in ('VMM-10011', 'RETRYABLE_ERROR',
                                         'VMM-30604', 'SUBNET_NOT_FOUND_ERROR'))
        if not retryable or attempt == 2:
            if 'SUBNET_NOT_FOUND' in message or 'VMM-30604' in message or 'subnet not found' in message.lower():
                message += ('; the migrated network is not usable for VM creation yet, even if '
                            'migration says COMPLETED. See the migrated-network recovery steps '
                            'in docs/OPERATOR.md. Keep Advanced mode and the existing subnet.')
            return False, message
        print('[retry %d/2] Confirmed VM creation failure: %s' % (attempt + 1, message))
        time.sleep(30 * (attempt + 1))
    return False, 'VM creation retry limit reached'


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
    ok, message = wait_for_task(r)
    return (True, "created") if ok else (False, message)


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
        vm = find_vm(vm_name)
        if vm:
            vm_uuid = vm['extId']
            break
        time.sleep(2)
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
    ok, message = wait_for_task(r, v3=True)
    if not ok:
        return False, message
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
        ok, msg = ensure_vm(spec, cat_uuid, subnet_uuid, image_uuid)
        if not ok:
            print("  [FAIL] %-30s — %s" % (spec['name'], msg))
            return 1
        print("  [ok]   %-30s — %s" % (spec['name'], msg))
        ok, msg = assign_project_and_set_power(spec['name'], power_on)
        if not ok:
            print("        post-create: [FAIL] %s" % msg)
            return 1
        else:
            print("        post-create: [ok]   %s" % msg)
    return 0


sys.exit(main())
