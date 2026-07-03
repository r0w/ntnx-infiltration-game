#script

"""
Create the 3 local PC users the game scenario references at stage 21
(approval-policy approvers): charlie, thom, william. 1:1 port of the
legacy `Create Local users.sh` task — same usernames, displayNames,
email IDs, and password — re-implemented as a Calm escript.py3 so we
don't need a Python venv + ntnx_iam_py_client on the VM.

Idempotent: if a user already exists (matched by lowercased username),
we skip with a log line.

Calm injects @@{PC_IP}@@, @@{PC_USERNAME}@@, @@{PC_PASSWORD}@@.
"""

import json
import sys
import urllib3

import requests
from requests.adapters import HTTPAdapter, Retry

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

PC_IP = '@@{PC_IP}@@'
PC_USERNAME = '@@{PC_USERNAME}@@'
PC_PASSWORD = '@@{PC_PASSWORD}@@'

BASE = "https://%s:9440" % PC_IP
AUTH = (PC_USERNAME, PC_PASSWORD)
HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}


def _make_session():
    """A Session that retries transient transport errors + 5xx via urllib3's
    Retry adapter (issue #28) — proven to work in the Calm escript sandbox.
    Route ONLY idempotent calls through it (POST is allowed because our v3
    `/list` reads are POSTs); mutations stay on plain `requests`."""
    retry = Retry(total=4, connect=4, read=4, backoff_factor=0.5,
                  status_forcelist=(500, 502, 503, 504),
                  allowed_methods=frozenset(("GET", "POST", "PUT", "DELETE")),
                  raise_on_status=False)
    s = requests.Session()
    adapter = HTTPAdapter(max_retries=retry)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


_SESS = _make_session()

USERS = [
    {
        "username": "charlie",
        "firstName": "Charlie",
        "lastName": "Ugly",
        "displayName": "Charlie",
        "emailId": "charlie.ugly@others.com",
        "password": "Nutanix/4u",
    },
    {
        "username": "thom",
        "firstName": "Thom",
        "lastName": "Cat",
        "displayName": "Thom",
        "emailId": "thom.cat@others.com",
        "password": "Nutanix/4u",
    },
    {
        "username": "william",
        "firstName": "William",
        "lastName": "Shake",
        "displayName": "Willy",
        "emailId": "william.shake@others.com",
        "password": "Nutanix/4u",
    },
]


def list_existing_usernames():
    seen = set()
    page = 0
    while True:
        r = _SESS.get(
            "%s/api/iam/v4.0/authn/users?$page=%d&$limit=100" % (BASE, page),
            auth=AUTH, headers=HEADERS, verify=False, timeout=20,
        )
        r.raise_for_status()
        data = r.json().get('data') or []
        if not data:
            break
        for u in data:
            seen.add((u.get('username') or '').lower())
        if len(data) < 100:
            break
        page += 1
    return seen


def create_user(u):
    body = dict(u)
    body['userType'] = 'LOCAL'
    r = requests.post(
        "%s/api/iam/v4.0/authn/users" % BASE,
        auth=AUTH, headers=HEADERS, verify=False, timeout=30,
        data=json.dumps(body),
    )
    if r.status_code in (200, 201, 202):
        return True, "created"
    return False, "%d %s" % (r.status_code, r.text[:200])


def main():
    existing = list_existing_usernames()
    print("PC has %d existing users" % len(existing))
    for u in USERS:
        if (u['username'] or '').lower() in existing:
            print("  [skip] %-12s already present" % u['username'])
            continue
        ok, msg = create_user(u)
        tag = "[ok]  " if ok else "[FAIL]"
        print("  %s %-12s — %s" % (tag, u['username'], msg))
        if not ok:
            return 1
    return 0


sys.exit(main())
