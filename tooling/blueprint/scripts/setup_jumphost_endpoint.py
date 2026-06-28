#script

"""
1:1 port of the legacy CreateJumphost.py — creates a Calm endpoint named
"jumphost" in the `production` project, pointing at the Calm-provisioned
Game VM (SSH on port 22 with the BP_CRED_NUTANIX credentials). Used by
CloneProd's day-2 actions and surfaces a realistic-looking endpoint in
Prism for immersion.

Idempotent: skips if an endpoint named "jumphost" already exists.

Calm injects @@{PC_IP}@@, @@{PC_USERNAME}@@, @@{PC_PASSWORD}@@,
@@{VM.address}@@ (= Calm-provisioned VM's IP),
@@{NUTANIX.username}@@ + @@{NUTANIX.secret}@@ (= the BP credential),
@@{Game.ProjectUUID}@@.
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
PROJECT_UUID = '@@{Game.ProjectUUID}@@'
VM_ADDRESS = '@@{VM.address}@@'
ENDPOINT_USER = '@@{NUTANIX.username}@@'
ENDPOINT_PASSWORD = '@@{NUTANIX.secret}@@'

ENDPOINT_NAME = "jumphost"
PROJECT_NAME = "production"

BASE = "https://%s:9440" % PC_IP
AUTH = (PC_USERNAME, PC_PASSWORD)
HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}


def _retry(_fn, *args, **kwargs):
    """Retry on transient transport errors + 5xx (issue #28). Idempotent calls
    only (list + stale-delete); the endpoint create stays single-shot."""
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


def find_existing_endpoint():
    """Returns the uuid of `jumphost` if present, else None."""
    r = _retry(
        requests.post,
        "%s/api/nutanix/v3/endpoints/list" % BASE,
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
        data=json.dumps({"kind": "endpoint", "filter": "name==%s" % ENDPOINT_NAME}),
    )
    if r.status_code >= 400:
        return None
    for e in r.json().get('entities') or []:
        return e.get('metadata', {}).get('uuid')
    return None


def main():
    # Refresh the endpoint each install — a stale `jumphost` left over
    # from a previous deploy points at the OLD VM's IP + OLD cred user
    # (ubuntu vs nutanix flip in v0.2.27 — mid-session). The CloneProd
    # day-2 `Clone the Environment` task SSHs through this endpoint;
    # any drift between cloud-init's user and the endpoint's cred breaks
    # Calm's hardcoded `python_remote` venv path on the target.
    stale = find_existing_endpoint()
    if stale:
        d = _retry(
            requests.delete,
            "%s/api/nutanix/v3/endpoints/%s" % (BASE, stale),
            auth=AUTH, headers=HEADERS, verify=False, timeout=30,
        )
        if d.status_code in (200, 202, 204):
            print("[ok]   deleted stale endpoint '%s' (uuid=%s)" %
                  (ENDPOINT_NAME, stale))
        else:
            print("[warn] delete stale endpoint returned %d %s" %
                  (d.status_code, d.text[:200]))

    cred_uuid = str(uuid.uuid4())
    cred_name = "endpoint_cred_game" + cred_uuid[:3]

    payload = {
        "api_version": "3.0",
        "spec": {
            "resources": {
                "type": "Linux",
                "value_type": "IP",
                "attrs": {
                    "credential_definition_list": [
                        {
                            "description": "",
                            "username": ENDPOINT_USER,
                            "type": "PASSWORD",
                            "name": cred_name,
                            "cred_class": "static",
                            "secret": {
                                "attrs": {"is_secret_modified": True},
                                "value": ENDPOINT_PASSWORD,
                            },
                            "uuid": cred_uuid,
                        }
                    ],
                    "login_credential_reference": {
                        "name": cred_name,
                        "kind": "app_credential",
                        "uuid": cred_uuid,
                    },
                    "values": [VM_ADDRESS],
                    "port": 22,
                },
            },
            "name": ENDPOINT_NAME,
        },
        "metadata": {
            "project_reference": {
                "name": PROJECT_NAME,
                "kind": "project",
                "uuid": PROJECT_UUID,
            },
            "kind": "endpoint",
        },
    }
    r = requests.post(
        "%s/api/nutanix/v3/endpoints" % BASE,
        auth=AUTH, headers=HEADERS, verify=False, timeout=30,
        data=json.dumps(payload),
    )
    if r.status_code >= 400:
        print("[FAIL] create endpoint: %d %s" % (r.status_code, r.text[:300]))
        return 1
    print("[ok]   created endpoint '%s' → %s:22" % (ENDPOINT_NAME, VM_ADDRESS))
    return 0


sys.exit(main())
