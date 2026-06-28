#script

"""
Port of the legacy CreatefakeBPs.sh — clones the `CloneProd` blueprint
into 10 fake-named copies (ApacheServer, PrimaryAD, Wordpress, etc.) so
the Prism Self-Service Blueprints page looks like a busy production
cluster (immersion).

Skips silently if `CloneProd` hasn't been uploaded yet — it's an
operator-managed prereq (uploaded once per fresh PC via Prism UI from
the release asset prereqs/CloneProd.tgz).

Skips entirely on CLUSTER_PROFILE=other to keep the shared cluster's
Self-Service catalog clean. The 10 fake BPs are pure immersion — no
pack stage checks for them — so skipping them on shared clusters costs
nothing functionally. Same gate pattern as remove_node.py and
activate_policy_engine.py.

Idempotent: skips per-name if a BP with that name already exists.

Calm injects @@{PC_IP}@@, @@{PC_USERNAME}@@, @@{PC_PASSWORD}@@,
@@{CLUSTER_PROFILE}@@.
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
CLUSTER_PROFILE = '@@{CLUSTER_PROFILE}@@'

FAKE_NAMES = [
    "ApacheServer",
    "PrimaryAD",
    "Wordpress",
    "KubernetesCluster",
    "BlankVM_AnyCloud",
    "HadoopCluster",
    "RansomwareProbe",
    "EmailServer",
    "FW",
    "IPAM",
]
SOURCE_BP_NAME = "CloneProd"

BASE = "https://%s:9440" % PC_IP
AUTH = (PC_USERNAME, PC_PASSWORD)
HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}


def _retry(_fn, *args, **kwargs):
    """Retry on transient transport errors + 5xx (issue #28). BP list only; the
    per-name clone already tolerates failure (it continues)."""
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


def list_bps():
    r = _retry(
        requests.post,
        "%s/api/nutanix/v3/blueprints/list" % BASE,
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
        data=json.dumps({"kind": "blueprint", "length": 250}),
    )
    r.raise_for_status()
    return r.json().get('entities') or []


def main():
    if CLUSTER_PROFILE != 'hpoc':
        print(
            "[skip] CLUSTER_PROFILE=%r — fake-BP cloning is pure immersion for "
            "vanilla HPoC; on a shared cluster it just pollutes the Self-Service "
            "catalog and no pack stage depends on these BPs." % CLUSTER_PROFILE
        )
        return 0

    bps = list_bps()
    by_name = {(b.get('status', {}).get('name') or b.get('metadata', {}).get('name')): b for b in bps}

    source = by_name.get(SOURCE_BP_NAME)
    if not source:
        print("[skip] source BP '%s' not on PC — operator hasn't uploaded "
              "prereqs/CloneProd.tgz yet, skipping fake-BP cloning" % SOURCE_BP_NAME)
        return 0

    source_uuid = source['metadata']['uuid']
    print("Cloning '%s' (%s) into %d fake BPs..." % (SOURCE_BP_NAME, source_uuid, len(FAKE_NAMES)))

    for name in FAKE_NAMES:
        if name in by_name:
            print("  [skip] %-25s already present" % name)
            continue
        body = {
            "blueprint_name": name,
            "metadata": {"kind": "blueprint"},
        }
        r = requests.post(
            "%s/api/nutanix/v3/blueprints/%s/clone" % (BASE, source_uuid),
            auth=AUTH, headers=HEADERS, verify=False, timeout=30,
            data=json.dumps(body),
        )
        if r.status_code >= 400:
            print("  [FAIL] %-25s — %d %s" % (name, r.status_code, r.text[:150]))
            continue
        print("  [ok]   %-25s cloned" % name)
    return 0


sys.exit(main())
