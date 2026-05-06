#!/usr/bin/env python3
"""End-to-end import + activate + simple_launch of blueprint.json on a PC.

Reads blueprint.json next to this file, populates credential secrets and
runtime variable values inline (so the BP activates clean), then fires a
simple_launch and prints the resulting app_uuid + runlog_uuid for monitoring.

Env (defaults shown):
  PC_ENDPOINT       https://<pc-ip>:9440
  PC_USER           admin
  PC_PASSWORD       <your PC admin password>
  PROJECT_NAME      lab
  BP_NAME           ntnx-infiltration-game
  APP_NAME          ntnx-infiltration-game            (override per launch)
  GHCR_TOKEN        (required, from .env or arg)
  GAME_VLAN_ID      20
  GAME_PROD_PASSWORD       MyPassword4Prod!
  GAME_OLD_PC_PASSWORD     ILike2Plan!
  GAME_EMAIL_REPORT        -secret-message@ntnxlab.com
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

HERE = Path(__file__).parent
BP_JSON = HERE / "blueprint.json"

PC = os.environ.get("PC_ENDPOINT", "https://<pc-ip>:9440").rstrip("/")
PC_USER = os.environ.get("PC_USER", "admin")
PC_PWD = os.environ.get("PC_PASSWORD", "")
PROJECT_NAME = os.environ.get("PROJECT_NAME", "lab")
BP_NAME = os.environ.get("BP_NAME", "ntnx-infiltration-game")
APP_NAME = os.environ.get("APP_NAME", BP_NAME)

# secrets / runtime values for the install. Empty defaults = leave unset
# (BP keeps its own default). GAME_VLAN_ID empty = randomized 0-249 per session.
SECRETS_AND_VARS = {
    "PC_IP": PC.split("://", 1)[1].split(":")[0],
    "PC_USERNAME": PC_USER,
    "PC_PASSWORD": PC_PWD,
    "GHCR_TOKEN": os.environ.get("GHCR_TOKEN", ""),
    "ADMIN_PASSWORD": os.environ.get("ADMIN_PASSWORD", "nutanix/4u"),
    "CLUSTER_PROFILE": os.environ.get("CLUSTER_PROFILE", "hpoc"),
    "MODE": os.environ.get("MODE", "live"),
    "GAME_VLAN_ID": os.environ.get("GAME_VLAN_ID", ""),
    "GAME_PROD_PASSWORD": os.environ.get("GAME_PROD_PASSWORD", "MyPassword4Prod!"),
    "GAME_OLD_PC_PASSWORD": os.environ.get("GAME_OLD_PC_PASSWORD", "ILike2Plan!"),
    "GAME_EMAIL_REPORT": os.environ.get(
        "GAME_EMAIL_REPORT", "-secret-message@ntnxlab.com"
    ),
}

# credential_definition_list values. NUTANIX cred is used by Calm to SSH
# into the deployed VM (readiness_probe + Install Docker + Run game
# container), NOT for PC API calls. Only the secret is filled — the
# username comes from the BP itself (currently `nutanix`, set in
# blueprint.py and matched by cloud_init_data.yaml's `users:` block).
# Overwriting it here would silently desync from the cloud-init user.
CRED_SECRETS = {
    "NUTANIX": PC_PWD,
}

S = requests.Session()
S.auth = (PC_USER, PC_PWD)
S.headers.update({"Content-Type": "application/json", "Accept": "application/json"})
S.verify = False


def api(method: str, path: str, **kw):
    url = path if path.startswith("http") else PC + path
    r = S.request(method, url, timeout=60, **kw)
    if not r.ok:
        print(f"!! {method} {path} → {r.status_code}\n{r.text[:2000]}", file=sys.stderr)
    return r


def get_project_uuid(name: str) -> str:
    r = api("POST", "/api/nutanix/v3/projects/list", json={"length": 50})
    r.raise_for_status()
    for p in r.json().get("entities", []):
        if p["status"]["name"] == name:
            return p["metadata"]["uuid"]
    raise RuntimeError(f"project {name!r} not found")


def import_blueprint(bp_path: Path, project_uuid: str) -> dict:
    """Upload via /import_file — the same multipart endpoint Prism UI's
    Self-Service > Blueprints > Upload hits. Validates that the BP we
    ship is UI-uploadable as-is (no pre-strip, no re-shape). Relies on
    `patch_escript.normalize_secrets_for_import` having produced the
    canonical no-secret shape; otherwise PC asks for a passphrase and
    fails."""
    # multipart form: file + name + project_uuid (matches calm-dsl's
    # upload_using_import_file at api/blueprint.py:322).
    url = PC + "/api/calm/v3.0/blueprints/import_file"
    with bp_path.open("rb") as fp:
        files = {"file": (bp_path.name, fp, "application/json")}
        data = {"name": BP_NAME, "project_uuid": project_uuid}
        # no `Content-Type: application/json` header — requests sets the
        # multipart boundary automatically. Override the session default.
        r = requests.post(
            url,
            auth=(PC_USER, PC_PWD),
            verify=False,
            timeout=60,
            files=files,
            data=data,
        )
    if not r.ok:
        print(f"!! POST /import_file → {r.status_code}\n{r.text[:2000]}",
              file=sys.stderr)
    r.raise_for_status()
    return r.json()


def get_blueprint(uuid: str) -> dict:
    r = api("GET", f"/api/nutanix/v3/blueprints/{uuid}")
    r.raise_for_status()
    return r.json()


def update_blueprint(uuid: str, body: dict) -> dict:
    r = api("PUT", f"/api/nutanix/v3/blueprints/{uuid}", json=body)
    r.raise_for_status()
    return r.json()


def activate_blueprint(bp_uuid: str) -> dict:
    """Inject secret values into the freshly-imported BP and PUT it back so
    Calm transitions it from DRAFT → ACTIVE."""
    fresh = get_blueprint(bp_uuid)

    for cred in fresh["spec"]["resources"].get("credential_definition_list", []):
        if cred["name"] in CRED_SECRETS:
            cred["secret"] = {
                "attrs": {"is_secret_modified": True},
                "value": CRED_SECRETS[cred["name"]],
            }

    for prof in fresh["spec"]["resources"].get("app_profile_list", []):
        for v in prof.get("variable_list", []):
            if v["name"] in SECRETS_AND_VARS:
                v["value"] = SECRETS_AND_VARS[v["name"]]
                if v.get("type") == "SECRET":
                    v.setdefault("attrs", {})["is_secret_modified"] = True

    body = {
        "api_version": fresh["api_version"],
        "metadata": fresh["metadata"],
        "spec": fresh["spec"],
    }
    return update_blueprint(bp_uuid, body)


def find_existing_bp(name: str) -> str | None:
    r = api(
        "POST",
        "/api/nutanix/v3/blueprints/list",
        json={"filter": f"name=={name}", "length": 50},
    )
    r.raise_for_status()
    for e in r.json().get("entities", []):
        if e["status"]["name"] == name:
            return e["metadata"]["uuid"]
    return None


def delete_bp(uuid: str):
    api("DELETE", f"/api/nutanix/v3/blueprints/{uuid}")


def get_cluster_uuid(name_hint: str | None) -> tuple[str, str]:
    """Return (uuid, name) of the first cluster (or matching name_hint)."""
    r = api("GET", "/api/clustermgmt/v4.0/config/clusters")
    r.raise_for_status()
    clusters = [c for c in r.json().get("data", []) if c.get("name")]
    if name_hint:
        for c in clusters:
            if c["name"] == name_hint:
                return c["extId"], c["name"]
    return clusters[0]["extId"], clusters[0]["name"]


def get_subnet_uuid(project_uuid: str) -> tuple[str, str]:
    """Pick the first subnet whitelisted in the project."""
    r = api("GET", f"/api/nutanix/v3/projects_internal/{project_uuid}")
    r.raise_for_status()
    pres = r.json()["spec"]["project_detail"]["resources"]
    subs = pres.get("subnet_reference_list", []) or []
    if not subs:
        raise RuntimeError(f"project {project_uuid} has no whitelisted subnets")
    s = subs[0]
    return s["uuid"], s.get("name", "")


def fetch_runtime_editables(bp_uuid: str) -> dict:
    r = api("GET", f"/api/nutanix/v3/blueprints/{bp_uuid}/runtime_editables")
    r.raise_for_status()
    return r.json()["resources"][0]


def fill_runtime_editables(
    re_block: dict, project_uuid: str, cluster_name_hint: str | None
) -> dict:
    """Mutate the runtime_editables block: fill secrets + substrate
    cluster/subnet placeholders with real cluster + project subnet."""
    cluster_uuid, cluster_name = get_cluster_uuid(cluster_name_hint)
    subnet_uuid, subnet_name = get_subnet_uuid(project_uuid)
    print(f"   substrate cluster={cluster_name}({cluster_uuid})")
    print(f"   substrate subnet={subnet_name}({subnet_uuid})")

    re = re_block["runtime_editables"]

    for v in re.get("variable_list", []):
        if v["name"] in SECRETS_AND_VARS:
            v["value"] = {"value": SECRETS_AND_VARS[v["name"]]}

    for cred in re.get("credential_list", []):
        if cred["name"] in CRED_SECRETS:
            cred["value"] = {
                "secret": {
                    "attrs": {"is_secret_modified": True},
                    "value": CRED_SECRETS[cred["name"]],
                }
            }

    for s in re.get("substrate_list", []):
        spec = s["value"]["spec"]
        spec["cluster_reference"] = {
            "kind": "cluster",
            "name": cluster_name,
            "uuid": cluster_uuid,
        }
        nic0 = spec["resources"]["nic_list"]["0"]
        nic0["subnet_reference"] = {
            "kind": "subnet",
            "name": subnet_name,
            "uuid": subnet_uuid,
        }

    return re_block


def simple_launch(bp_uuid: str, project_uuid: str, cluster_hint: str | None) -> dict:
    re_block = fetch_runtime_editables(bp_uuid)
    re_block = fill_runtime_editables(re_block, project_uuid, cluster_hint)
    payload = {
        "spec": {
            "app_name": APP_NAME,
            "app_description": "",
            "app_profile_reference": re_block["app_profile_reference"],
            "runtime_editables": re_block["runtime_editables"],
        }
    }
    r = api("POST", f"/api/nutanix/v3/blueprints/{bp_uuid}/simple_launch", json=payload)
    r.raise_for_status()
    return r.json()


def main():
    if not BP_JSON.exists():
        sys.exit(f"missing {BP_JSON}")

    print(f"=> PC {PC} as {PC_USER}")
    proj = get_project_uuid(PROJECT_NAME)
    print(f"=> project {PROJECT_NAME} = {proj}")

    if not SECRETS_AND_VARS["GHCR_TOKEN"]:
        sys.exit("GHCR_TOKEN env required")

    existing = find_existing_bp(BP_NAME)
    if existing:
        print(f"=> existing BP {BP_NAME} ({existing}) — deleting first")
        delete_bp(existing)
        time.sleep(2)

    print("=> import_file (multipart, like Prism UI upload) …")
    imported = import_blueprint(BP_JSON, proj)
    bp_uuid = imported["metadata"]["uuid"]
    print(f"   bp_uuid={bp_uuid}, state={imported['status'].get('state')}")

    print("=> activate (PUT with secrets) …")
    activated = activate_blueprint(bp_uuid)
    state = activated["status"].get("state")
    print(f"   state={state}")
    if state and state != "ACTIVE":
        msgs = activated.get("status", {}).get("message_list", [])
        print(f"   messages: {msgs}")

    cluster_hint = os.environ.get("CLUSTER_NAME_HINT") or None
    print("=> simple_launch …")
    launched = simple_launch(bp_uuid, proj, cluster_hint)
    req_id = launched.get("status", {}).get("request_id") or launched.get(
        "request_id"
    )
    print(f"   request_id={req_id}")
    print(f"   raw status: {json.dumps(launched.get('status', {}), indent=2)[:600]}")

    print("\nNext: poll /api/nutanix/v3/apps/list and look for an app named",
          APP_NAME)


if __name__ == "__main__":
    main()
