#!/usr/bin/env python3
"""Build blueprint.json directly. Zero external deps. No calm-dsl.

Shape is copied structurally from the legacy ntnx-escape-game BP that
PC 7.5 imports clean across all HPoCs we've tested. Hex DAG names,
attrs.type="" everywhere, edge_type="user_defined" everywhere,
retries/timeout_secs as "0" strings.

Usage:  python3 build_blueprint.py
Output: ./blueprint.json
"""

from __future__ import annotations

import base64
import io
import json
import secrets
import tarfile
from pathlib import Path

HERE = Path(__file__).parent.resolve()
SCRIPTS_DIR = HERE / "scripts"
PREREQS_DIR = HERE / "prereqs"
OUT = HERE / "blueprint.json"


# ──────────────────────────────────────────────────────────────────────
# Helpers


def hex8() -> str:
    """8-char lowercase hex, matches legacy hand-rolled DAG name pattern."""
    return secrets.token_hex(4)


def _patch_for_calm_escript(s: str) -> str:
    """Apply build-time rewrites that adapt source scripts to Calm 7.5's
    escript sandbox + the v3-tmp cycle fix:

    1. Profile-scope hidden state vars: rewrite `@@{Game.X}@@` → `@@{X}@@`
       for CLUSTERNAME, CLUSTERUUID, ProjectUUID (cycle root cause —
       SET_VARIABLE that reads + writes Service vars trips PC 7.5's
       lifecycle planner into back-edge detection).
    2. Banned imports: Calm escript.py3 sandbox rejects `import sys` with
       'Syntax Error: import of "sys" not allowed'. Strip the import +
       rewrite `sys.exit(N)` → `raise SystemExit(N)` (built-in, no import).
    """
    for var in ("CLUSTERNAME", "CLUSTERUUID", "ProjectUUID"):
        s = s.replace(f"@@{{Game.{var}}}@@", f"@@{{{var}}}@@")
    import re
    # Strip banned imports. Calm escript sandbox bans: sys, urllib3, time.
    s = re.sub(r"^import sys\s*\n", "", s, flags=re.MULTILINE)
    s = re.sub(r"^import urllib3\s*\n", "", s, flags=re.MULTILINE)
    s = re.sub(r"^urllib3\.disable_warnings\([^)]*\)\s*\n", "", s, flags=re.MULTILINE)
    # `time` is banned. Strip the import + rewrite call sites:
    # - `time.sleep(N)` → `_sleep_secs(N)` (real wall-clock sleep via TCP
    #   timeout to RFC 5737 documentation IP 192.0.2.1 — no response from
    #   that range, so requests.get blocks until the timeout fires).
    # - `time.time()` → `_fake_time()` (counter that increments per call,
    #   so deadline-based loops at least terminate).
    s = re.sub(r"^import time\s*\n", "", s, flags=re.MULTILINE)
    s = re.sub(r"\btime\.sleep\(([^)]*)\)", r"_sleep_secs(\1)", s)
    s = re.sub(r"\btime\.time\(\)", "_fake_time()", s)
    # `json` is banned. requests.post/put accept `json=X` kwarg that
    # auto-serializes — replace `data=json.dumps(X)` patterns. Strip
    # the import. `r.json()` (Response method) keeps working since
    # it doesn't need the module.
    s = re.sub(r"^import json\s*\n", "", s, flags=re.MULTILINE)
    s = re.sub(r"data=json\.dumps\(", "json=(", s)
    # Banned name: `SystemExit` (NameError at runtime). Rewrite both
    # `sys.exit(X)` and `raise SystemExit(X)` to `_calm_exit(X)`,
    # then prepend a helper that raises a generic Exception for
    # non-zero codes (Calm logs the exception as a script failure).
    s = re.sub(r"\bsys\.exit\(", "_calm_exit(", s)
    s = re.sub(r"\braise\s+SystemExit\(", "_calm_exit(", s)
    # NTNX-Request-Id idempotency header is required on PC 7.5 v4 API
    # mutations (POST/PUT/DELETE on /api/.../v4.0/*). Build-time: inject
    # _req_id() helper + rewrite `headers=HEADERS` to interleave a
    # unique request id per call.
    helper = (
        "import uuid as _uuid\n"
        "\n"
        "def _calm_exit(code=0):\n"
        "    if code:\n"
        "        raise Exception('script exit code: ' + str(code))\n"
        "\n"
        "def _req_id():\n"
        "    return str(_uuid.uuid4())\n"
        "\n"
        "def _req_headers(base):\n"
        "    h = dict(base)\n"
        "    h['NTNX-Request-Id'] = _req_id()\n"
        "    return h\n"
        "\n"
        "_FAKE_TIME = [0]\n"
        "def _fake_time():\n"
        "    _FAKE_TIME[0] += 1\n"
        "    return _FAKE_TIME[0]\n"
        "\n"
        "def _sleep_secs(n):\n"
        "    # Approximate sleep without time.sleep (sandbox-banned): TCP\n"
        "    # connect to RFC 5737 documentation IP 192.0.2.1 — that range\n"
        "    # is non-routable, so the SYN gets no response and requests\n"
        "    # blocks until our `timeout` fires.\n"
        "    try:\n"
        "        requests.get('http://192.0.2.1/', timeout=float(n))\n"
        "    except Exception:\n"
        "        pass\n\n"
    )
    # Replace `headers=HEADERS` with `headers=_req_headers(HEADERS)` for
    # mutating calls. (GET-only calls also get the header but it's
    # harmless.)
    s = re.sub(r"headers=HEADERS\b", "headers=_req_headers(HEADERS)", s)
    # Insert helper after the leading "#script" marker (and any docstring)
    if s.startswith("#script"):
        # find end of header (first blank line after maybe a docstring)
        lines = s.split("\n")
        # Keep #script line + advance through blank/docstring header
        i = 1
        # consume blank lines + a single triple-quoted docstring if present
        while i < len(lines) and not lines[i].strip(): i += 1
        if i < len(lines) and lines[i].lstrip().startswith('"""'):
            j = i + 1
            while j < len(lines) and '"""' not in lines[j]: j += 1
            i = j + 1
        s = "\n".join(lines[:i] + ["", helper.rstrip()] + lines[i:])
    else:
        s = helper + s
    return s


def read_script(filename: str) -> str:
    s = (SCRIPTS_DIR / filename).read_text()
    # Only Python escripts get the Calm sandbox patches. PowerShell
    # (.ps1) and shell (.sh) scripts use different syntax and don't
    # need (and can't tolerate) the Python helper injection.
    if filename.endswith(".py") or filename.endswith(".py3") or filename.endswith(".template"):
        return _patch_for_calm_escript(s)
    return s


PREREQ_SUBS: dict[str, dict[str, str]] = {
    "CloneProd": {
        "{PC_IP}": "@@{PC_IP}@@",
        "{PC_USER}": "@@{PC_USERNAME}@@",
        "{PC_PWD}": "@@{PC_PASSWORD}@@",
        "{PROJECT}": "production",
    },
    "BlankVM-source": {
        "{CLUSTER_NAME}": "@@{Game.CLUSTERNAME}@@",
        "{PROJECT}": "production",
    },
}


def patch_and_repack_tgz(tgz_path: Path, subs: dict[str, str]) -> bytes:
    """Open .tgz, sed-substitute placeholders in every .py/.sh, repack.
    Done at BUILD time so the runtime escript doesn't need tarfile/io
    (both banned by the Calm sandbox)."""
    src_buf = io.BytesIO(tgz_path.read_bytes())
    out_buf = io.BytesIO()
    src = tarfile.open(fileobj=src_buf, mode="r:gz")
    out = tarfile.open(fileobj=out_buf, mode="w:gz")
    n_patched = 0
    for member in src.getmembers():
        if member.isfile() and (member.name.endswith(".py") or member.name.endswith(".sh")):
            content = src.extractfile(member).read().decode("utf-8", errors="replace")
            patched = content
            for k, v in subs.items():
                patched = patched.replace(k, v)
            if patched != content:
                n_patched += 1
            data = patched.encode("utf-8")
            info = tarfile.TarInfo(name=member.name)
            info.size = len(data)
            info.mode = member.mode
            info.mtime = member.mtime
            out.addfile(info, io.BytesIO(data))
        else:
            extracted = src.extractfile(member) if member.isfile() else None
            out.addfile(member, extracted)
    src.close()
    out.close()
    print(f"  pre-patched {n_patched} files in {tgz_path.name}")
    return out_buf.getvalue()


def b64_inline_push_prereq_script() -> str:
    """Read push_prereq_bps.sh.template and inline the raw .tgz blobs as
    base64. The shell script (running on the deployed VM, no Calm escript
    sandbox) decodes, extracts, sed-patches, then uploads via a
    calm-dsl Docker container — same pattern as the legacy escape-game BP."""
    s = (SCRIPTS_DIR / "push_prereq_bps.sh.template").read_text()
    cp = base64.b64encode((PREREQS_DIR / "CloneProd.tgz").read_bytes()).decode("ascii")
    bv = base64.b64encode((PREREQS_DIR / "NewblankVM.tgz").read_bytes()).decode("ascii")
    return s.replace("__CLONEPROD_TGZ_B64__", cp).replace("__BLANKVM_TGZ_B64__", bv)


def ref(name: str, kind: str) -> dict:
    return {"name": name, "kind": kind}


# ──────────────────────────────────────────────────────────────────────
# Build entities


# Stub UUIDs — operator overrides cluster_reference + nic[0].subnet_reference
# at launch via the Prism UI (they are listed in substrate.editables below).
STUB_CLUSTER_UUID = "00000000-0000-0000-0000-000000000000"
STUB_SUBNET_UUID = "00000000-0000-0000-0000-000000000001"
STUB_ACCOUNT_UUID = "00000000-0000-0000-0000-000000000002"
STUB_PKG_UUID = "00000000-0000-0000-0000-000000000003"

CRED_NUTANIX = "NUTANIX"

CLOUD_INIT = """#cloud-config
timezone: @@{TIMEZONE}@@
password: @@{NUTANIX.secret}@@
chpasswd: { expire: false }
ssh_pwauth: true
"""


# ──────────────────────────────────────────────────────────────────────
# Tasks


def task_exec(
    name: str,
    script: str,
    script_type: str,
    target_endpoint: str | None = None,
    set_vars: list[str] | None = None,
    login_cred: str | None = None,
    target_service: str = "Game",
) -> dict:
    """Build an EXEC or SET_VARIABLE task in legacy shape."""
    is_setvar = bool(set_vars)
    attrs: dict = {
        "type": "",
        "script": script,
        "script_type": script_type,
        "exit_status": [],
    }
    if is_setvar:
        # SET_VARIABLE: NO command_line_args (PC 7.5 rejects it as "Rogue
        # field"). Add eval_scope + eval_variables instead.
        attrs["eval_scope"] = "local"
        attrs["eval_variables"] = list(set_vars or [])
    else:
        attrs["command_line_args"] = ""
    if login_cred:
        attrs["login_credential_local_reference"] = ref(login_cred, "app_credential")

    # SET_VARIABLE target_any = Service Game (NOT Profile Default).
    # Empirical 2026-04-28: Profile-targeted SET_VAR tasks inside a
    # Package install runbook are NOT executed by Calm — Get Cluster
    # was silently skipped, then downstream `Ensure host 4 removed`
    # failed with "CLUSTER_UUID not set". Reverting to Service target
    # makes Calm execute the task; the previously-observed "Eval
    # variable not defined on the Service" warning at validate time
    # is non-blocking. Cycle is still avoided because scripts no
    # longer read @@{Game.X}@@ macros (Profile-scoped @@{X}@@ instead),
    # which was the actual back-edge trigger per v3-tmp A4e.
    target_ref = ref(target_service, "app_service")

    task: dict = {
        "type": "SET_VARIABLE" if is_setvar else "EXEC",
        "name": name,
        "description": "",
        "attrs": attrs,
        "child_tasks_local_reference_list": [],
        "variable_list": [],
        "target_any_local_reference": target_ref,
        "timeout_secs": "0",
        "retries": "0",
        "inherit_target": False,
        "status_map_list": [],
    }
    if target_endpoint:
        task["exec_target_reference"] = ref(target_endpoint, "app_endpoint")
    return task


def task_dag(name: str, leaves: list[dict], target_service: str = "Game") -> dict:
    """Build a DAG with sequential edges leaf[0] → leaf[1] → ... → leaf[N-1]."""
    edges = [
        {
            "type": "",
            "from_task_reference": ref(leaves[i]["name"], "app_task"),
            "to_task_reference": ref(leaves[i + 1]["name"], "app_task"),
            "edge_type": "user_defined",
        }
        for i in range(len(leaves) - 1)
    ]
    return {
        "type": "DAG",
        "name": name,
        "description": "",
        "attrs": {"type": "", "edges": edges},
        "child_tasks_local_reference_list": [
            ref(t["name"], "app_task") for t in leaves
        ],
        "variable_list": [],
        "target_any_local_reference": ref(target_service, "app_service"),
        "timeout_secs": "0",
        "retries": "0",
        "inherit_target": False,
        "status_map_list": [],
    }


def runbook(dag: dict, leaves: list[dict]) -> dict:
    """Wrap the DAG + leaves into a runbook dict (used by service actions
    and package install/uninstall)."""
    return {
        "name": hex8() + "_runbook",
        "description": "",
        "main_task_local_reference": ref(dag["name"], "app_task"),
        "task_definition_list": [dag] + leaves,
        "variable_list": [],
    }


# ──────────────────────────────────────────────────────────────────────
# Install task list — sequential, in order


# (display_name, script_filename | None, script_type, options)
# script_filename=None means use b64_inline_push_prereq_script() at build.
INSTALL_SPEC: list[tuple[str, str | None, str, dict]] = [
    ("Activate policy engine", "activate_policy_engine.py", "static_py3", {}),
    ("Get Cluster", "get_cluster.py", "static_py3", {"set_vars": ["CLUSTERNAME", "CLUSTERUUID"]}),
    # remove_node.py just POSTs the remove-node action and returns — no
    # polling, no time.sleep — sandbox-safe. cluster_health stays disabled
    # because it polls with deadlines that the escript sandbox can't
    # implement reliably (no time.time, no time.sleep).
    ("Ensure host 4 removed", "remove_node.py", "static_py3", {}),
    # ("Wait for cluster health", "cluster_health.py", "static_py3", {}),
    ("Setup subnets", "setup_subnets.py", "static_py3", {}),
    ("Setup production project", "setup_production_project.py", "static_py3", {"set_vars": ["ProjectUUID"]}),
    ("Create Local users", "create_local_users.py", "static_py3", {}),
    ("Add AD users", "add_ad_users.ps1", "npsscript", {"target_endpoint": "AD"}),
    ("Create Prod VMs", "create_prod_vms.py", "static_py3", {}),
    ("Setup jumphost endpoint", "setup_jumphost_endpoint.py", "static_py3", {}),
    ("Trigger LCM inventory", "trigger_lcm_inventory.py", "static_py3", {}),
    ("Install Docker", "install_docker.sh", "sh", {"login_cred": CRED_NUTANIX}),
    # Push prereq BPs runs on the VM (after Install Docker) using a
    # calm-dsl Docker container. Calm's import_file API only accepts
    # JSON BPs and the escript sandbox can't compile calm-dsl Python →
    # JSON, so we follow the legacy approach. script_filename=None →
    # b64_inline_push_prereq_script() at build time inlines the .tgz
    # blobs into the sh script.
    ("Push prereq BPs", None, "sh", {"login_cred": CRED_NUTANIX}),
    ("Clone fake BPs", "clone_fake_bps.py", "static_py3", {}),
    ("Run game container", "run_container.sh", "sh", {"login_cred": CRED_NUTANIX}),
    ("Verify final state", "verify_state.py", "static_py3", {}),
]


def build_install_runbook() -> dict:
    leaves = []
    for name, script_file, stype, opts in INSTALL_SPEC:
        script = b64_inline_push_prereq_script() if script_file is None else read_script(script_file)
        leaves.append(
            task_exec(
                name=name,
                script=script,
                script_type=stype,
                target_endpoint=opts.get("target_endpoint"),
                set_vars=opts.get("set_vars"),
                login_cred=opts.get("login_cred"),
            )
        )
    dag = task_dag(hex8() + "_dag", leaves)
    return runbook(dag, leaves)


def build_uninstall_runbook() -> dict:
    """Empty uninstall — single no-op task so PC's lifecycle planner has
    something to run instead of synthesizing a hyphenated wrapper."""
    leaf = task_exec(
        name="Uninstall placeholder",
        script="echo Uninstall placeholder; exit 0",
        script_type="sh",
        login_cred=CRED_NUTANIX,
    )
    dag = task_dag(hex8() + "_dag", [leaf])
    return runbook(dag, [leaf])


def build_service_action(action_name: str, leaves: list[dict]) -> dict:
    """Build a Service action_list[] entry. action_name is one of
    action_create / action_start / action_stop / action_delete /
    action_restart / action_soft_delete. Leaves can be empty for
    placeholder actions."""
    if leaves:
        dag = task_dag(hex8() + "_dag", leaves)
        rb = runbook(dag, leaves)
    else:
        # Empty action — DAG with no children. Legacy emits this same shape
        # for action_stop / action_delete / action_restart.
        empty_dag = task_dag(hex8() + "_dag", [])
        rb = {
            "name": hex8() + "_runbook",
            "description": "",
            "main_task_local_reference": ref(empty_dag["name"], "app_task"),
            "task_definition_list": [empty_dag],
            "variable_list": [],
        }
    return {
        "type": "system",
        "name": action_name,
        "description": f"System action for {action_name.replace('action_', '')}",
        "critical": False,
        "runbook": rb,
    }


def build_service_create_action() -> dict:
    """action_create: real content (mkdir + touch a marker)."""
    leaf = task_exec(
        name="Initialize game runtime dir",
        script="sudo mkdir -p /var/lib/ntnx-infiltration-game/data && sudo touch /var/lib/ntnx-infiltration-game/.created",
        script_type="sh",
        login_cred=CRED_NUTANIX,
    )
    return build_service_action("action_create", [leaf])


def build_service_start_action() -> dict:
    """action_start: docker start (idempotent — the container is already
    running by install time, this just ensures it is on a re-launch)."""
    leaf = task_exec(
        name="Start game container",
        script="sudo docker start ntnx-infiltration-game >/dev/null 2>&1 || true",
        script_type="sh",
        login_cred=CRED_NUTANIX,
    )
    return build_service_action("action_start", [leaf])


def build_service() -> dict:
    return {
        "name": "Game",
        "description": "",
        "tier": "",
        "singleton": False,
        "depends_on_list": [],
        "port_list": [],
        # E1 cycle fix: hidden install-state vars moved to Profile
        # (cf. build_profile_variables). Service.variable_list stays empty
        # so SET_VAR tasks don't create the bidirectional Service↔Package
        # binding that triggers PC 7.5's 9 cycles.
        "variable_list": [],
        "action_list": [
            build_service_create_action(),
            build_service_start_action(),
            build_service_action("action_stop", []),
            build_service_action("action_delete", []),
            build_service_action("action_restart", []),
            build_service_action("action_soft_delete", []),
        ],
    }


# ──────────────────────────────────────────────────────────────────────
# Variables


def local_var(
    name: str,
    value: str,
    label: str = "",
    hidden: bool = False,
    mandatory: bool = False,
    editable: bool = True,
    choices: list[str] | None = None,
    description: str = "",
) -> dict:
    v: dict = {
        "type": "LOCAL",
        "name": name,
        "description": description,
        "options": {"type": "PREDEFINED", "choices": choices or []},
        "is_hidden": hidden,
        "is_mandatory": mandatory,
        "data_type": "BASE",
        "val_type": "STRING",
        "label": label,
        "attrs": {"type": ""},
        "value": value,
    }
    if editable and not hidden:
        v["editables"] = {"value": True}
    return v


def secret_var(
    name: str,
    label: str = "",
    mandatory: bool = False,
    default: str = "",
    hidden: bool = False,
) -> dict:
    """Secret runtime var. PC 7.5 requires `editables.value=True` when
    is_mandatory=True so the user can actually fill it at launch
    ("marked as mandatory but not runtime editable" error otherwise).
    `hidden=True` keeps the value editable via API but hides it from the
    Prism UI launch dialog (use for secrets baked at activate time)."""
    v = {
        "type": "SECRET",
        "name": name,
        "description": "",
        "options": {"type": "PREDEFINED", "choices": []},
        "is_hidden": hidden,
        "is_mandatory": mandatory,
        "data_type": "BASE",
        "val_type": "STRING",
        "label": label,
        "attrs": {
            "type": "SECRET",
            "is_secret_modified": bool(default),
            "secret_reference": {},
        },
        "value": default,
        "editables": {"value": True},
    }
    return v


# ──────────────────────────────────────────────────────────────────────
# Substrate (AHV VM)


SSH_ADDRESS_MACRO = (
    "@@{platform.status.resources.nic_list[0].ip_endpoint_list[0].ip}@@"
)


def build_substrate_fragment_action(action_name: str) -> dict:
    """Substrate lifecycle hook (pre_action_create / post_action_create /
    post_action_delete). Empty DAG body — but legacy has these declared
    even when empty, and they appear to be load-bearing for PC 7.5's
    lifecycle planner: their presence prevents the synthesis cycle on
    Package/Profile/Deployment Create/Delete/SoftDelete actions."""
    empty_dag = task_dag(hex8() + "_dag", [], target_service="VM")
    # Substrate-targeted DAG: target_any kind=app_substrate, not app_service
    empty_dag["target_any_local_reference"] = ref("VM", "app_substrate")
    rb = {
        "name": hex8() + "_runbook",
        "description": "",
        "main_task_local_reference": ref(empty_dag["name"], "app_task"),
        "task_definition_list": [empty_dag],
        "variable_list": [],
    }
    return {
        "type": "fragment",
        "name": action_name,
        "description": "",
        "critical": False,
        "runbook": rb,
    }


def build_substrate() -> dict:
    create_spec = {
        "name": "ntnx-infiltration-@@{calm_time}@@",
        "type": "",
        "categories": {"Environment": "Production"},
        "availability_zone_reference": None,
        "backup_policy": None,
        "cluster_reference": {
            "type": "",
            "kind": "cluster",
            "name": "",
            "uuid": STUB_CLUSTER_UUID,
        },
        "resources": {
            "type": "",
            "account_uuid": STUB_ACCOUNT_UUID,
            "memory_size_mib": 8192,
            "num_sockets": 4,
            "num_vcpus_per_socket": 1,
            "power_state": "ON",
            "hardware_clock_timezone": "",
            "guest_tools": None,
            "parent_reference": None,
            "vtpm_config": None,
            "gpu_list": [],
            "serial_port_list": [],
            "boot_config": {
                "boot_type": "UEFI",
                "boot_device": {
                    "disk_address": {
                        "device_index": 0,
                        "adapter_type": "SCSI",
                    },
                },
            },
            "disk_list": [
                {
                    "type": "",
                    "data_source_reference": {
                        "type": "",
                        "kind": "app_package",
                        "name": "Ubuntu2204",
                        "uuid": STUB_PKG_UUID,
                    },
                    "volume_group_reference": None,
                    "device_properties": {
                        "type": "",
                        "device_type": "DISK",
                        "disk_address": {
                            "type": "",
                            "device_index": 0,
                            "adapter_type": "SCSI",
                        },
                    },
                    "disk_size_mib": 40960,
                }
            ],
            "nic_list": [
                {
                    "type": "",
                    "nic_type": "NORMAL_NIC",
                    "subnet_reference": {
                        "type": "",
                        "kind": "subnet",
                        "name": "",
                        "uuid": STUB_SUBNET_UUID,
                    },
                    "network_function_nic_type": "INGRESS",
                    "mac_address": "",
                    "ip_endpoint_list": [],
                    "network_function_chain_reference": None,
                    "vpc_reference": None,
                }
            ],
            "guest_customization": {
                "cloud_init": {"user_data": CLOUD_INIT},
                "sysprep": None,
            },
        },
    }
    return {
        "name": "VM",
        "description": "",
        "type": "AHV_VM",
        "os_type": "Linux",
        "create_spec": create_spec,
        "editables": {
            "create_spec": {
                "cluster_reference": True,
                "resources": {
                    "nic_list": {"0": {"subnet_reference": True}},
                },
            }
        },
        "variable_list": [],
        "readiness_probe": {
            "connection_type": "SSH",
            "connection_port": 22,
            "delay_secs": "30",
            "retries": "5",
            "address": SSH_ADDRESS_MACRO,
            "disable_readiness_probe": False,
            "connection_protocol": "",
            "login_credential_local_reference": ref(CRED_NUTANIX, "app_credential"),
        },
        "action_list": [],
    }


# ──────────────────────────────────────────────────────────────────────
# Package, Deployment, Profile


def build_package_substrate_image() -> dict:
    """Ubuntu 22.04 cloud image — Noble 24.04 cloud-init is broken on this
    HPoC AHV build (cd8cd937…); Jammy works."""
    return {
        "name": "Ubuntu2204",
        "description": "",
        "type": "SUBSTRATE_IMAGE",
        "service_local_reference_list": [],
        "options": {
            "type": "",
            "name": "Ubuntu2204",
            "description": "",
            "resources": {
                "type": "",
                "image_type": "DISK_IMAGE",
                "source_uri": "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img",
                "version": {
                    "type": "",
                    "product_name": "Ubuntu",
                    "product_version": "22.04",
                },
                "architecture": "X86_64",
                "checksum": {
                    "type": "",
                    "checksum_value": "",
                    "checksum_algorithm": "",
                },
            },
        },
        "variable_list": [],
        "action_list": [],
        "version": "",
    }


def build_package_custom() -> dict:
    """The Game Content package with options.install_runbook +
    options.uninstall_runbook. Type=DEB matches legacy
    ntnx-escape-game BP — calm-dsl 4.3.1 only emits CUSTOM, but
    hand-authored we can pick DEB which legacy uses and which
    avoids triggering PC 7.5's CUSTOM-package lifecycle synthesis
    that closes a cycle on Profile/Package/Deployment Create/Delete/
    SoftDelete (confirmed empirically 2026-04-28)."""
    return {
        "name": "Game Content",
        "description": "",
        "type": "DEB",
        "service_local_reference_list": [ref("Game", "app_service")],
        "options": {
            "type": "",
            "install_runbook": build_install_runbook(),
            "uninstall_runbook": build_uninstall_runbook(),
            "upgrade_runbook": {},
        },
        "variable_list": [],
        "action_list": [],
        "version": "",
    }


def build_deployment() -> dict:
    return {
        "name": "GameDeployment",
        "description": "",
        "type": "GREENFIELD",
        "min_replicas": "1",
        "max_replicas": "1",
        "default_replicas": "1",
        "depends_on_list": [],
        "variable_list": [],
        "package_local_reference_list": [ref("Game Content", "app_package")],
        "substrate_local_reference": ref("VM", "app_substrate"),
        "published_service_local_reference_list": [],
        "action_list": [],
    }


def build_profile_action_update_game() -> dict:
    leaf = task_exec(
        name="docker pull and restart container",
        script=read_script("update_game.sh"),
        script_type="sh",
        login_cred=CRED_NUTANIX,
    )
    dag = task_dag(hex8() + "_dag", [leaf])
    return {
        "type": "user",
        "name": "Update Game",
        "description": "Pull a fresh image and restart the container",
        "critical": False,
        "runbook": runbook(dag, [leaf]),
    }


def build_profile_action_verify_state() -> dict:
    leaf = task_exec(
        name="Verify final state",
        script=read_script("verify_state.py"),
        script_type="static_py3",
    )
    dag = task_dag(hex8() + "_dag", [leaf])
    return {
        "type": "user",
        "name": "Verify State",
        "description": "Re-run the post-install convergence checks",
        "critical": False,
        "runbook": runbook(dag, [leaf]),
    }


def build_profile_variables() -> list[dict]:
    """Runtime vars surfaced at launch UI + 3 hidden install-state vars
    (E1 cycle fix: moved from Service to Profile)."""
    return [
        # Hidden install-state vars (set by SET_VAR install tasks).
        # Live on Profile to avoid the Service↔Package bidirectional
        # binding that triggers PC 7.5's 9 cycles. Read from scripts as
        # @@{CLUSTERNAME}@@ (Profile-scoped, no entity prefix).
        local_var("CLUSTERNAME", "", hidden=True, mandatory=False),
        local_var("CLUSTERUUID", "", hidden=True, mandatory=False),
        local_var("ProjectUUID", "", hidden=True, mandatory=False),
        # Runtime vars (visible at launch UI)
        local_var("PC_IP", "", label="Prism Central IP", mandatory=True),
        local_var("PC_USERNAME", "admin", label="Prism Central username", mandatory=True),
        secret_var("PC_PASSWORD", label="Prism Central password", mandatory=True),
        local_var(
            "CLUSTER_PROFILE",
            "other",
            label="Cluster profile",
            mandatory=True,
            choices=["other", "hpoc"],
            description="hpoc unlocks destructive actions; other filters them",
        ),
        local_var(
            "MODE",
            "live",
            label="Run mode",
            choices=["live", "test"],
            description="live = production; test = adds operator debug tools",
        ),
        local_var(
            "TIMEZONE",
            "UTC",
            label="Time zone",
            choices=[
                "UTC",
                "Europe/Paris",
                "Europe/London",
                "America/New_York",
                "America/Los_Angeles",
                "Asia/Tokyo",
            ],
        ),
        secret_var("GAME_PROD_PASSWORD", label="Production user password"),
        secret_var("GAME_OLD_PC_PASSWORD", label="Planner PC password"),
        # Hidden — operator never edits these at launch
        secret_var("ADMIN_PASSWORD", label="Game /admin password", default="nutanix/4u", hidden=True),
        local_var("LOG_LEVEL", "info", label="Server log level", choices=["debug", "info", "warn", "error"], hidden=True),
        local_var("GAME_VLAN_ID", "", label="Pinned VLAN id (empty = randomized 0-249 per session)", hidden=True),
        local_var("GAME_PROD_USERNAME", "thebadguy", label="Production username", hidden=True),
        local_var("GAME_OLD_PC", "", label="Legacy PC IP for stage 29", hidden=True),
        local_var("GAME_OLD_PC_USERNAME", "planner", label="Legacy PC username", hidden=True),
        local_var("GAME_EMAIL_REPORT", "", label="Email for end-game report (optional)", hidden=True),
        local_var("GAME_FRONTEND_HOST", "", label="Public hostname (optional)", hidden=True),
        # Container image — last block at launch, in order: repo > tag > token
        local_var("IMAGE_REPO", "ghcr.io/r0w/ntnx-infiltration-game", label="Container image repository"),
        local_var("IMAGE_TAG", "latest", label="Image tag"),
        local_var("GHCR_USERNAME", "x-access-token", label="ghcr.io username", hidden=True),
        secret_var("GHCR_TOKEN", label="ghcr.io token (empty for public images)"),
    ]


def build_profile() -> dict:
    return {
        "name": "Default",
        "description": "",
        "application_url": "",
        "environment_reference_list": [],
        "deployment_create_list": [build_deployment()],
        "variable_list": build_profile_variables(),
        "action_list": [
            build_profile_action_update_game(),
            build_profile_action_verify_state(),
        ],
        "patch_list": [],
        "snapshot_config_list": [],
        "restore_config_list": [],
    }


# ──────────────────────────────────────────────────────────────────────
# Credentials


def build_credential(name: str, username: str, description: str = "") -> dict:
    """Static-class credential. The empty `secret.attrs.secret_reference`
    + `is_secret_modified=false` is the legacy shape — PC 7.5 surfaces
    a password prompt at launch when the secret is empty. The
    `editables.secret=True` flag tells the launch UI to expose the
    secret as fillable instead of erroring at validate time."""
    return {
        "type": "PASSWORD",
        "name": name,
        "description": description,
        "username": username,
        "secret": {
            "attrs": {
                "secret_reference": {},
                "is_secret_modified": False,
            }
        },
        "cred_class": "static",
        "editables": {"secret": True},
    }


# ──────────────────────────────────────────────────────────────────────
# Top-level


def build_blueprint() -> dict:
    return {
        "api_version": "3.0",
        "product_version": "4.3.0",
        "contains_secrets": False,
        "status": {},
        "metadata": {
            "kind": "blueprint",
            "name": "ntnx-infiltration-game",
            "spec_version": 1,
        },
        "spec": {
            "name": "ntnx-infiltration-game",
            "description": "Deploy the Nutanix Infiltration Game on a brand-new HPoC. When deployed:\n\n - Game:       http://@@{VM.address}@@:3000/\n - Scoreboard: http://@@{VM.address}@@:3000/scoreboard\n - Admin:      http://@@{VM.address}@@:3000/admin",
            "resources": {
                "type": "",
                "client_attrs": {"None": ""},
                "default_credential_local_reference": ref(CRED_NUTANIX, "app_credential"),
                "credential_definition_list": [
                    build_credential(
                        CRED_NUTANIX,
                        "ubuntu",
                        description="SSH login for the deployed game VM (Ubuntu cloudimg default user — cloud-init sets the password from this secret)",
                    ),
                ],
                "service_definition_list": [build_service()],
                "package_definition_list": [
                    build_package_substrate_image(),
                    build_package_custom(),
                ],
                "substrate_definition_list": [build_substrate()],
                "published_service_definition_list": [],
                "app_profile_list": [build_profile()],
            },
        },
    }


def main() -> int:
    bp = build_blueprint()
    OUT.write_text(json.dumps(bp, indent=2))
    size = OUT.stat().st_size
    print(f"[ok] wrote {OUT.name} ({size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
