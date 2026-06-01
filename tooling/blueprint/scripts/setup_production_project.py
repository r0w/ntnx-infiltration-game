#script

"""
1:1 port of the legacy CreateProject.sh + create-project.py — creates
the global `production` Calm project, adds `thebadguy` (LDAP-imported
from the AD endpoint set up earlier in the install) as Project Admin
via an Access Control Policy, and emits the ProjectUUID Calm variable
for downstream tasks.

Idempotent on the project creation; the LDAP user import + ACP add are
fired unconditionally (Prism's PUT /projects_internal handles re-adds
gracefully — operation: ADD is a no-op when the user is already a
member).

Calm injects @@{PC_IP}@@, @@{PC_USERNAME}@@, @@{PC_PASSWORD}@@,
@@{Game.CLUSTERUUID}@@.
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

PROJECT_NAME = "production"
PROJECT_ADMIN = "thebadguy"  # AD user (created by Add AD users task)

BASE = "https://%s:9440" % PC_IP
AUTH = (PC_USERNAME, PC_PASSWORD)
HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}


def find_existing_project():
    """Return the uuid of the `production` project if it exists in a HEALTHY
    state. If the project exists but state == ERROR (e.g. previous deploy hit
    a Calm policy-engine-not-ready race during create), delete it and return
    None so the caller re-creates a clean one. Recreating without deleting
    would 409 on duplicate name."""
    r = requests.post(
        "%s/api/nutanix/v3/projects/list" % BASE,
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
        data=json.dumps({"kind": "project", "filter": "name==%s" % PROJECT_NAME}),
    )
    r.raise_for_status()
    entities = r.json().get('entities') or []
    if not entities:
        return None
    p = entities[0]
    state = (p.get('status') or {}).get('state')
    uuid = p['metadata']['uuid']
    if state == 'ERROR':
        print("  [recover] existing project %s in state=ERROR — deleting before recreate" % uuid)
        dr = requests.delete(
            "%s/api/nutanix/v3/projects/%s" % (BASE, uuid),
            auth=AUTH, headers=HEADERS, verify=False, timeout=30,
        )
        if dr.status_code >= 400:
            raise Exception("could not delete ERROR-state project %s: %d %s" % (uuid, dr.status_code, dr.text[:200]))
        # Wait briefly for the delete task to settle so the subsequent create
        # doesn't 409 on duplicate name. Iteration-based (sandbox sleep is
        # unreliable); MAX_POLLS=30 ≈ 15-30 s real wall-clock.
        for _ in range(30):
            chk = requests.post(
                "%s/api/nutanix/v3/projects/list" % BASE,
                auth=AUTH, headers=HEADERS, verify=False, timeout=20,
                data=json.dumps({"kind": "project", "filter": "name==%s" % PROJECT_NAME}),
            )
            if chk.status_code == 200 and not (chk.json().get('entities') or []):
                break
        return None
    return uuid


def get_account_uuid():
    r = requests.post(
        "%s/api/nutanix/v3/accounts/list" % BASE,
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
        data=json.dumps({"kind": "account", "filter": "type==nutanix_pc"}),
    )
    r.raise_for_status()
    for e in r.json().get('entities') or []:
        if e.get('metadata', {}).get('name') == 'NTNX_LOCAL_AZ':
            return e['metadata']['uuid']
    raise Exception("NTNX_LOCAL_AZ account not found")


def get_subnet_uuid(name):
    """Look up a subnet by name via the stable v3 list API.

    Tolerant of cluster-prefixed names: matches `name` exactly first, then
    falls back to `<name>-<anything>` (e.g. HPoC subnets named
    `primary-<cluster-name>` instead of just `primary`).

    Retries with a short delay because PC's v3 subnets/list is eventually
    consistent: the upstream Setup subnets task may have JUST migrated
    `secondary` to advanced-networking and created `TestNetwork` — for
    a few seconds afterwards v3/list can lag behind v4. Verified live
    2026-05-02: Setup production project failed with "no subnet named
    'secondary'" 3 s after Setup subnets confirmed it exists.
    """
    for attempt in range(6):  # 6 × 5 s = 30 s cap
        r = requests.post(
            "%s/api/nutanix/v3/subnets/list" % BASE,
            auth=AUTH, headers=HEADERS, verify=False, timeout=20,
            data=json.dumps({"kind": "subnet", "length": 250}),
        )
        r.raise_for_status()
        entities = r.json().get('entities') or []
        for e in entities:
            if e['status'].get('name') == name:
                return e['metadata']['uuid']
        for e in entities:
            if e['status'].get('name', '').startswith(name + '-'):
                return e['metadata']['uuid']
        if attempt < 5:
            print("  [warn] subnet '%s' not yet visible (attempt %d/6) — waiting 5 s" %
                  (name, attempt + 1))
            time.sleep(5)
    return None


def create_project(account_uuid, primary_uuid, secondary_uuid):
    body = {
        "metadata": {"kind": "project"},
        "spec": {
            "name": PROJECT_NAME,
            "description": "Production Project",
            "resources": {
                "resource_domain": {"resources": []},
                "account_reference_list": [{"kind": "account", "uuid": account_uuid}],
                "cluster_reference_list": [{"kind": "cluster", "uuid": CLUSTER_UUID}],
                "default_subnet_reference": {"kind": "subnet", "uuid": primary_uuid},
                "subnet_reference_list": [
                    {"kind": "subnet", "name": "primary", "uuid": primary_uuid},
                    {"kind": "subnet", "name": "secondary", "uuid": secondary_uuid},
                ],
            },
        },
    }
    r = requests.post(
        "%s/api/nutanix/v3/projects" % BASE,
        auth=AUTH, headers=HEADERS, verify=False, timeout=30,
        data=json.dumps(body),
    )
    if r.status_code >= 400:
        raise Exception("create project failed: %d %s" % (r.status_code, r.text[:300]))
    task_uuid = r.json()["status"]["execution_context"]["task_uuid"]

    # Iteration-based, NOT wall-clock-based. The sandbox rewrites time.time()
    # to a 1-incrementing counter and time.sleep() to a TCP-timeout that
    # often returns instantly — a `deadline = time.time() + 60` loop blasts
    # through 60 iterations in milliseconds and times out before PC finishes
    # the project create task. Each /tasks GET takes ~0.5-1s naturally, so
    # MAX_POLLS=120 is ~60-120 s of real wall-clock without trusting sleep.
    MAX_POLLS = 120
    for poll in range(MAX_POLLS):
        r = requests.get(
            "%s/api/nutanix/v3/tasks/%s" % (BASE, task_uuid),
            auth=AUTH, headers=HEADERS, verify=False, timeout=20,
        )
        r.raise_for_status()
        task = r.json()
        if task.get("status") == "SUCCEEDED":
            return task["entity_reference_list"][0]["uuid"]
        if task.get("status") == "FAILED":
            raise Exception("project create task failed: %s" % task)
    raise Exception("project create task timed out after %d polls" % MAX_POLLS)


def get_project_spec_version(project_uuid):
    r = requests.get(
        "%s/api/nutanix/v3/projects/%s" % (BASE, project_uuid),
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
    )
    r.raise_for_status()
    return r.json()["metadata"]["spec_version"]


def get_directory_id():
    """Returns the first directory service ID. Legacy assumes [0]."""
    r = requests.get(
        "%s/api/iam/v4.0/authn/directory-services" % BASE,
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
    )
    r.raise_for_status()
    data = r.json().get('data') or []
    if not data:
        return None
    return data[0]['extId']


def import_ldap_user(directory_id):
    """Import thebadguy as an LDAP user from the AD directory service.
    Idempotent: if already present, the API returns the existing entry."""
    body = {
        "firstName": "Henry",
        "lastName": "Ugly",
        "displayName": PROJECT_ADMIN,
        "username": PROJECT_ADMIN,
        "userType": "LDAP",
        "idpId": directory_id,
    }
    r = requests.post(
        "%s/api/iam/v4.0/authn/users" % BASE,
        auth=AUTH, headers=HEADERS, verify=False, timeout=30,
        data=json.dumps(body),
    )
    # 200/201/202 = created, 409 = already exists. Both fine.
    if r.status_code not in (200, 201, 202, 409):
        print("[warn] LDAP user import returned %d %s" % (r.status_code, r.text[:200]))


def get_user_uuid(username):
    # IAM v4 caps $limit at 100 — filter server-side by username instead of
    # listing everyone (a $limit=250 here was getting a 400 SchemaValidation).
    r = requests.get(
        "%s/api/iam/v4.0/authn/users" % BASE,
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
        params={"$filter": "username eq '%s'" % username, "$limit": 100},
    )
    # Don't raise on non-200; ACP setup is best-effort. Operator can
    # add the user to the project manually via Prism UI if needed.
    if r.status_code >= 400:
        print("[warn] GET users returned %d %s" % (r.status_code, r.text[:200]))
        return None
    for u in r.json().get('data') or []:
        if u.get('username') == username:
            return u['extId']
    return None


def get_project_admin_role_uuid():
    r = requests.get(
        "%s/api/iam/v4.0/authz/roles?$filter=startswith(displayName,'Project')&$select=displayName,extId"
        % BASE,
        auth=AUTH, headers=HEADERS, verify=False, timeout=20,
    )
    if r.status_code >= 400:
        print("[warn] GET roles returned %d %s" % (r.status_code, r.text[:200]))
        return None
    for role in r.json().get('data') or []:
        if role.get('displayName') == 'Project Admin':
            return role['extId']
    return None


def build_acp_filters(project_uuid, cluster_uuid):
    """The 3-context ACP filter list — verbatim from the legacy script."""
    return {
        "context_list": [
            # Context 1: full Project Admin scope inside this project
            {
                "scope_filter_expression_list": [
                    {
                        "operator": "IN",
                        "left_hand_side": "PROJECT",
                        "right_hand_side": {"uuid_list": [project_uuid]},
                    }
                ],
                "entity_filter_expression_list": [
                    {
                        "operator": "IN",
                        "left_hand_side": {"entity_type": "ALL"},
                        "right_hand_side": {"collection": "ALL"},
                    }
                ],
            },
            # Context 2: per-entity-type permissions (no scope = global)
            {
                "entity_filter_expression_list": [
                    {"operator": "IN", "left_hand_side": {"entity_type": "image"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "marketplace_item"},
                     "right_hand_side": {"collection": "SELF_OWNED"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "directory_service"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "role"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "project"},
                     "right_hand_side": {"uuid_list": [project_uuid]}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "environment"},
                     "right_hand_side": {"collection": "SELF_OWNED"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "app_icon"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "category"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "app_task"},
                     "right_hand_side": {"collection": "SELF_OWNED"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "app_variable"},
                     "right_hand_side": {"collection": "SELF_OWNED"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "identity_provider"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "vm_recovery_point"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "report_config"},
                     "right_hand_side": {"collection": "SELF_OWNED"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "virtual_network"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "resource_type"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "custom_provider"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "distributed_virtual_switch"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "container"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "cluster"},
                     "right_hand_side": {"uuid_list": [cluster_uuid]}},
                ],
            },
            # Context 3: project-scoped Calm/Self-Service entities
            {
                "scope_filter_expression_list": [
                    {
                        "operator": "IN",
                        "left_hand_side": "PROJECT",
                        "right_hand_side": {"uuid_list": [project_uuid]},
                    }
                ],
                "entity_filter_expression_list": [
                    {"operator": "IN", "left_hand_side": {"entity_type": "blueprint"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "environment"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "marketplace_item"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "runbook"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "vm"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "user"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "user_group"},
                     "right_hand_side": {"collection": "ALL"}},
                    {"operator": "IN", "left_hand_side": {"entity_type": "app_showback"},
                     "right_hand_side": {"collection": "ALL"}},
                ],
            },
        ]
    }


def add_user_as_project_admin(project_uuid, account_uuid, primary_uuid,
                              secondary_uuid, cluster_uuid, user_uuid,
                              role_uuid, directory_id, spec_version):
    """PUT /api/nutanix/v3/projects_internal/{uuid} with the user_list +
    access_control_policy_list payload that adds thebadguy as Project Admin."""
    payload = {
        "api_version": "3.1",
        "metadata": {
            "project_reference": {
                "kind": "project",
                "name": PROJECT_NAME,
                "uuid": project_uuid,
            },
            "spec_version": spec_version,
            "kind": "project",
            "uuid": project_uuid,
        },
        "spec": {
            "project_detail": {
                "name": PROJECT_NAME,
                "resources": {
                    "account_reference_list": [
                        {"kind": "account", "uuid": account_uuid}
                    ],
                    "user_reference_list": [
                        {"name": PROJECT_ADMIN, "kind": "user", "uuid": user_uuid}
                    ],
                    "default_subnet_reference": {
                        "kind": "subnet", "uuid": primary_uuid,
                    },
                    "subnet_reference_list": [
                        {"kind": "subnet", "name": "secondary", "uuid": secondary_uuid},
                        {"kind": "subnet", "name": "primary", "uuid": primary_uuid},
                    ],
                    "cluster_reference_list": [
                        {"kind": "cluster", "uuid": cluster_uuid}
                    ],
                    "enable_directory_and_identity_provider_shortlist": False,
                },
                "description": "Production Project",
            },
            "user_list": [
                {
                    "metadata": {"kind": "user", "uuid": user_uuid},
                    "user": {
                        "resources": {
                            "directory_service_user": {
                                "user_principal_name": PROJECT_ADMIN,
                                "directory_service_reference": {
                                    "uuid": directory_id,
                                    "kind": "directory_service",
                                },
                            }
                        }
                    },
                    "operation": "ADD",
                }
            ],
            "access_control_policy_list": [
                {
                    "acp": {
                        "name": "nuCalmAcp-" + str(uuid.uuid4()),
                        "resources": {
                            "role_reference": {
                                "name": "Project Admin",
                                "uuid": role_uuid,
                                "kind": "role",
                            },
                            "user_reference_list": [
                                {"name": PROJECT_ADMIN, "kind": "user", "uuid": user_uuid}
                            ],
                            "filter_list": build_acp_filters(project_uuid, cluster_uuid),
                        },
                        "description": "",
                    },
                    "metadata": {"kind": "access_control_policy"},
                    "operation": "ADD",
                }
            ],
        },
    }
    r = requests.put(
        "%s/api/nutanix/v3/projects_internal/%s" % (BASE, project_uuid),
        auth=AUTH, headers=HEADERS, verify=False, timeout=60,
        data=json.dumps(payload),
    )
    if r.status_code >= 400:
        print("[warn] projects_internal PUT returned %d: %s" % (r.status_code, r.text[:300]))
        return False
    return True


def main():
    if not CLUSTER_UUID:
        print("[FAIL] CLUSTER_UUID not set — Get Cluster must run first")
        return 2

    # Step 1: ensure project exists.
    project_uuid = find_existing_project()
    created_now = False
    if project_uuid:
        print("[skip] project '%s' already exists, uuid=%s" % (PROJECT_NAME, project_uuid))
    else:
        account_uuid = get_account_uuid()
        primary_uuid = get_subnet_uuid('primary')
        secondary_uuid = get_subnet_uuid('secondary')
        if not primary_uuid:
            print("[warn] no subnet named 'primary' — falling back to 'secondary'")
            primary_uuid = secondary_uuid
        if not secondary_uuid:
            print("[FAIL] no subnet named 'secondary' — Setup subnets must run first")
            return 2
        print("Creating project '%s'" % PROJECT_NAME)
        project_uuid = create_project(account_uuid, primary_uuid, secondary_uuid)
        print("[ok]   created project uuid=%s" % project_uuid)
        created_now = True

    # Step 2: import thebadguy as LDAP user + attach to project as Project Admin.
    # Look up the resources we'll need for the PUT — fetch fresh in case the
    # cached uuids drift between create_project and now.
    account_uuid = get_account_uuid()
    primary_uuid = get_subnet_uuid('primary') or get_subnet_uuid('secondary')
    secondary_uuid = get_subnet_uuid('secondary')

    directory_id = get_directory_id()
    if not directory_id:
        print("[warn] no directory service registered — skipping ACP setup. "
              "Operator must add 'thebadguy' as Project Admin via Prism UI.")
        print("ProjectUUID=%s" % project_uuid)
        return 0

    print("Importing LDAP user '%s' from directory %s" % (PROJECT_ADMIN, directory_id))
    import_ldap_user(directory_id)

    user_uuid = get_user_uuid(PROJECT_ADMIN)
    if not user_uuid:
        print("[warn] LDAP user '%s' not visible after import — skipping ACP setup" % PROJECT_ADMIN)
        print("ProjectUUID=%s" % project_uuid)
        return 0

    role_uuid = get_project_admin_role_uuid()
    if not role_uuid:
        print("[warn] 'Project Admin' role not found — skipping ACP setup")
        print("ProjectUUID=%s" % project_uuid)
        return 0

    spec_version = get_project_spec_version(project_uuid)

    print("Adding '%s' (uuid=%s) as Project Admin (role=%s)..." %
          (PROJECT_ADMIN, user_uuid, role_uuid))
    ok = add_user_as_project_admin(
        project_uuid, account_uuid, primary_uuid, secondary_uuid,
        CLUSTER_UUID, user_uuid, role_uuid, directory_id, spec_version,
    )
    if ok:
        print("[ok]   ACP set: '%s' is Project Admin on '%s'" % (PROJECT_ADMIN, PROJECT_NAME))
    else:
        print("[warn] ACP PUT failed — operator can re-add manually via Prism UI")

    # Calm SetVariable task captures the line `ProjectUUID=...` from stdout.
    print("ProjectUUID=%s" % project_uuid)
    return 0


sys.exit(main())
