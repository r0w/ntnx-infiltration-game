#script

"""
Disable Erasure Coding on the AOS cluster's storage containers so the
4th host can be removed.

A fresh HPoC with Nutanix Files turns EC ON on the Files container
(`Nutanix_<fs>_ctr`). EC strips need 4 nodes, so `Remove 4th host on
HPoC` fails its precheck ("not enough NODES to meet Erasure Code
settings") until EC is off. We PUT every ON container back to OFF
(clustermgmt v4.2). That stops new strips; Curator un-codes the existing
ones in the background, so we don't wait on a drain here — the node
removal retries its precheck until Curator catches up.

Idempotent (OFF/NONE containers are skipped) and hpoc-gated: only `hpoc`
removes a node. Validated live on DM3-POC013.

Calm injects @@{PC_IP}@@, @@{PC_USERNAME}@@, @@{PC_PASSWORD}@@,
@@{Game.CLUSTERUUID}@@ (Get Cluster), @@{CLUSTER_PROFILE}@@.
"""

import json
import sys
import urllib3
import uuid

import requests

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

PC_IP = '@@{PC_IP}@@'
PC_USERNAME = '@@{PC_USERNAME}@@'
PC_PASSWORD = '@@{PC_PASSWORD}@@'
CLUSTER_UUID = '@@{Game.CLUSTERUUID}@@'
CLUSTER_PROFILE = '@@{CLUSTER_PROFILE}@@'

BASE = "https://%s:9440" % PC_IP
AUTH = (PC_USERNAME, PC_PASSWORD)
HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}

# clustermgmt v4.2 is where the StorageContainer model exposes `erasureCode`
# (enum NONE | OFF | ON). v4.0/v4.1 don't carry the field.
CTR_BASE = "%s/api/clustermgmt/v4.2/config/storage-containers" % BASE
# Tasks: iteration-based poll (sandbox time.sleep is unreliable). Each GET
# round-trips ~0.5-1 s, so ~120 iters ≈ a couple minutes — the update task
# is quick (~20 s live).
TASK_POLL_ITERS = 120


def list_containers():
    page = 0
    out = []
    while True:
        r = requests.get(
            "%s?$page=%d&$limit=100" % (CTR_BASE, page),
            auth=AUTH, headers=HEADERS, verify=False, timeout=30,
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


def get_container(ext_id):
    """Returns (data_body, etag) for a single container — the ETag is
    required as If-Match on the PUT."""
    r = requests.get(
        "%s/%s" % (CTR_BASE, ext_id),
        auth=AUTH, headers=HEADERS, verify=False, timeout=30,
    )
    r.raise_for_status()
    return r.json().get('data') or {}, r.headers.get('etag') or r.headers.get('ETag')


def poll_task(task_ext_id):
    """Poll a prism task to a terminal state. Returns the status string
    (SUCCEEDED / FAILED / ...) or None if it never settled within the cap."""
    url = "%s/api/prism/v4.2/config/tasks/%s" % (BASE, task_ext_id)
    last = None
    for _ in range(TASK_POLL_ITERS):
        try:
            tr = requests.get(url, auth=AUTH, headers=HEADERS, verify=False, timeout=30)
            last = (tr.json().get('data') or {}).get('status')
            if last in ('SUCCEEDED', 'FAILED', 'CANCELED', 'CANCELLED'):
                return last
        except Exception as e:
            print("    task poll error: %s — retrying" % str(e)[:120])
    return last


def disable_one(ctr):
    """Flip a single container's erasureCode to OFF. Returns True on success."""
    ext_id = ctr.get('containerExtId')
    name = ctr.get('name')
    body, etag = get_container(ext_id)
    body['erasureCode'] = 'OFF'

    headers = dict(HEADERS)
    headers['Ntnx-Request-Id'] = str(uuid.uuid4())
    if etag:
        headers['If-Match'] = etag

    r = requests.put(
        "%s/%s" % (CTR_BASE, ext_id),
        auth=AUTH, headers=headers, verify=False, timeout=60,
        data=json.dumps(body),
    )
    if r.status_code >= 400:
        print("[FAIL] PUT %s erasureCode=OFF: %d %s" % (name, r.status_code, r.text[:300]))
        return False

    task = (r.json().get('data') or {}).get('extId')
    if not task:
        # Some PC builds apply the change synchronously without a task ref.
        print("[ok]   %s erasureCode -> OFF (no task ref returned)" % name)
        return True

    status = poll_task(task)
    if status == 'SUCCEEDED':
        print("[ok]   %s erasureCode -> OFF (task SUCCEEDED)" % name)
        return True
    print("[FAIL] %s update task ended %s" % (name, status))
    return False


def main():
    if CLUSTER_PROFILE != 'hpoc':
        print(
            "[skip] CLUSTER_PROFILE=%r — no node removal happens, so EC can "
            "stay as-is." % CLUSTER_PROFILE
        )
        return 0

    if not CLUSTER_UUID:
        print("[FAIL] CLUSTER_UUID not set — Get Cluster must run first.")
        return 2

    containers = list_containers()
    # Scope to our AOS cluster (the list spans every registered cluster).
    ours = [c for c in containers if c.get('clusterExtId') == CLUSTER_UUID]
    on = [c for c in ours if c.get('erasureCode') == 'ON']

    print("Cluster %s has %d storage container(s); %d with EC ON: %s" % (
        CLUSTER_UUID, len(ours), len(on), [c.get('name') for c in on]))

    if not on:
        print("[skip] no container with erasureCode=ON — nothing to disable.")
        return 0

    failed = 0
    for ctr in on:
        if not disable_one(ctr):
            failed += 1

    if failed:
        print("[FAIL] %d container(s) could not be set to OFF." % failed)
        return 1

    print("[done] EC disabled on %d container(s). Curator will dis-encode "
          "existing strips in the background; node-removal retries its "
          "precheck until that's done." % len(on))
    return 0


sys.exit(main())
