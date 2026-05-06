#!/usr/bin/env python3
"""Bare-minimum blueprint for diagnosis: 1 service, 1 substrate, 1 package
with 1 install task ("echo hello"), 1 deployment, 1 profile, 1 credential.

NO PowerShell, NO AD endpoint, NO SetVariable, NO day-2 actions, NO secrets,
NO prereq tgz. Just enough to verify the basic shape imports AND launches
on PC 7.5. If THIS works, we incrementally re-add features in the v2 build
script to find the specific delta that triggers each error.

Usage:  python3 build_minimal.py
Output: ./blueprint.json
"""

import json
import secrets
from pathlib import Path

HERE = Path(__file__).parent.resolve()
OUT = HERE / "blueprint.json"
SCRIPTS = HERE / "scripts"

CRED = "NUTANIX"
STUB_UUID = "00000000-0000-0000-0000-000000000000"
STUB_SUBNET_UUID = "00000000-0000-0000-0000-000000000001"
STUB_ACCOUNT_UUID = "00000000-0000-0000-0000-000000000002"
STUB_PKG_UUID = "00000000-0000-0000-0000-000000000003"


def hex8():
    return secrets.token_hex(4)


def ref(name, kind):
    return {"name": name, "kind": kind}


CLOUD_INIT = """#cloud-config
users:
  - name: @@{NUTANIX.username}@@
    shell: /bin/bash
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
chpasswd:
  list: |
    @@{NUTANIX.username}@@:@@{NUTANIX.secret}@@
  expire: false
ssh_pwauth: true
"""


def read_script_patched(filename: str) -> str:
    """Read a script + rewrite Service-scoped macro reads to Profile-scoped.
    The 3 install-state vars (CLUSTERNAME, CLUSTERUUID, ProjectUUID) live on
    Profile (not Service) per the A5 cycle fix; scripts in tooling/blueprint/
    use the legacy @@{Game.X}@@ form, so we strip the `Game.` prefix at
    build time. Source scripts stay unchanged (still usable from v2)."""
    s = (SCRIPTS / filename).read_text()
    for var in ("CLUSTERNAME", "CLUSTERUUID", "ProjectUUID"):
        s = s.replace(f"@@{{Game.{var}}}@@", f"@@{{{var}}}@@")
    return s


def make_powershell_task(name: str, script_filename: str, target_endpoint: str = "AD") -> dict:
    """B2: PowerShell task targeting Service Game but exec_target=AD endpoint
    (which has its own Windows creds). inherit_target=False is critical:
    without it, PC validates the powershell script_type against target_any's
    os_type (Linux) and rejects with 'Linux os cannot have script type as
    powershell'."""
    return {
        "type": "EXEC",
        "name": name,
        "description": "",
        "attrs": {
            "type": "",
            "script": read_script_patched(script_filename),
            "script_type": "npsscript",
            "command_line_args": "",
            "exit_status": [],
        },
        "child_tasks_local_reference_list": [],
        "variable_list": [],
        "target_any_local_reference": ref("Game", "app_service"),
        "exec_target_reference": ref(target_endpoint, "app_endpoint"),
        "timeout_secs": "0",
        "retries": "0",
        "inherit_target": False,
        "status_map_list": [],
    }


def make_ssh_task(name: str, script_filename: str) -> dict:
    """A4: shell task that ssh's to the VM (login_credential_local_reference
    set to NUTANIX). Used for Install Docker / Run game container."""
    return {
        "type": "EXEC",
        "name": name,
        "description": "",
        "attrs": {
            "type": "",
            "script": read_script_patched(script_filename),
            "script_type": "sh",
            "command_line_args": "",
            "exit_status": [],
            "login_credential_local_reference": ref(CRED, "app_credential"),
        },
        "child_tasks_local_reference_list": [],
        "variable_list": [],
        "target_any_local_reference": ref("Game", "app_service"),
        "timeout_secs": "0",
        "retries": "0",
        "inherit_target": False,
        "status_map_list": [],
    }


def make_set_variable_task(name: str, script_filename: str, eval_variables: list) -> dict:
    """A3: SET_VARIABLE task. eval_variables resolve to Profile-scoped vars
    (declared on Profile.variable_list, A5 fix). Script is patched on read
    to use Profile-scoped macros."""
    return _make_set_var(name, read_script_patched(script_filename), eval_variables)


def make_set_variable_inline(name: str, script: str, eval_variables: list) -> dict:
    """Same as make_set_variable_task but takes script content directly
    instead of a filename — useful for trivial inline tests."""
    return _make_set_var(name, script, eval_variables)


def _make_set_var(name: str, script: str, eval_variables: list) -> dict:
    """C4: SET_VAR target_any = Profile Default (not Service Game).
    eval_variables resolves to Profile-declared vars per A5 fix.
    Setting target_any to Profile clears the 'Eval variable not
    defined on the Service' warning that surfaced in C3 when PC
    strict-checked eval_variables against target_any."""
    return {
        "type": "SET_VARIABLE",
        "name": name,
        "description": "",
        "attrs": {
            "type": "",
            "script": script,
            "script_type": "static_py3",
            "exit_status": [],
            "eval_scope": "local",
            "eval_variables": list(eval_variables),
        },
        "child_tasks_local_reference_list": [],
        "variable_list": [],
        "target_any_local_reference": ref("Default", "app_profile"),
        "timeout_secs": "0",
        "retries": "0",
        "inherit_target": False,
        "status_map_list": [],
    }


def make_escript_task(name: str, script_filename: str) -> dict:
    """Build an EXEC task running an escript.py3 on the Calm runner,
    targeting the Game service. No login_credential needed — escripts
    don't ssh to the VM, they execute on Calm itself."""
    return {
        "type": "EXEC",
        "name": name,
        "description": "",
        "attrs": {
            "type": "",
            "script": read_script_patched(script_filename),
            "script_type": "static_py3",
            "command_line_args": "",
            "exit_status": [],
        },
        "child_tasks_local_reference_list": [],
        "variable_list": [],
        "target_any_local_reference": ref("Game", "app_service"),
        "timeout_secs": "0",
        "retries": "0",
        "inherit_target": False,
        "status_map_list": [],
    }


def task_dag_single(leaf, target_kind="app_service", target_name="Game"):
    return {
        "type": "DAG",
        "name": hex8() + "_dag",
        "description": "",
        "attrs": {"type": "", "edges": []},
        "child_tasks_local_reference_list": [ref(leaf["name"], "app_task")],
        "variable_list": [],
        "target_any_local_reference": ref(target_name, target_kind),
        "timeout_secs": "0",
        "retries": "0",
        "inherit_target": False,
        "status_map_list": [],
    }


def runbook_with_one_task(leaf, target_kind="app_service", target_name="Game"):
    dag = task_dag_single(leaf, target_kind=target_kind, target_name=target_name)
    return {
        "name": hex8() + "_runbook",
        "description": "",
        "main_task_local_reference": ref(dag["name"], "app_task"),
        "task_definition_list": [dag, leaf],
        "variable_list": [],
    }


def runbook_sequential(leaves: list, target_kind="app_service", target_name="Game") -> dict:
    """N leaves → DAG with N-1 edges connecting leaf[i] → leaf[i+1]."""
    edges = [
        {
            "type": "",
            "from_task_reference": ref(leaves[i]["name"], "app_task"),
            "to_task_reference": ref(leaves[i + 1]["name"], "app_task"),
            "edge_type": "user_defined",
        }
        for i in range(len(leaves) - 1)
    ]
    dag = {
        "type": "DAG",
        "name": hex8() + "_dag",
        "description": "",
        "attrs": {"type": "", "edges": edges},
        "child_tasks_local_reference_list": [
            ref(t["name"], "app_task") for t in leaves
        ],
        "variable_list": [],
        "target_any_local_reference": ref(target_name, target_kind),
        "timeout_secs": "0",
        "retries": "0",
        "inherit_target": False,
        "status_map_list": [],
    }
    return {
        "name": hex8() + "_runbook",
        "description": "",
        "main_task_local_reference": ref(dag["name"], "app_task"),
        "task_definition_list": [dag] + leaves,
        "variable_list": [],
    }


def empty_runbook(target_kind="app_service", target_name="Game"):
    dag = {
        "type": "DAG",
        "name": hex8() + "_dag",
        "description": "",
        "attrs": {"type": "", "edges": []},
        "child_tasks_local_reference_list": [],
        "variable_list": [],
        "target_any_local_reference": ref(target_name, target_kind),
        "timeout_secs": "0",
        "retries": "0",
        "inherit_target": False,
        "status_map_list": [],
    }
    return {
        "name": hex8() + "_runbook",
        "description": "",
        "main_task_local_reference": ref(dag["name"], "app_task"),
        "task_definition_list": [dag],
        "variable_list": [],
    }


def system_action(name, runbook):
    return {
        "type": "system",
        "name": name,
        "description": f"System action {name}",
        "critical": False,
        "runbook": runbook,
    }


def build_service():
    create_leaf = {
        "type": "EXEC",
        "name": "Service create marker",
        "description": "",
        "attrs": {
            "type": "",
            "script": "echo created",
            "script_type": "sh",
            "command_line_args": "",
            "exit_status": [],
            "login_credential_local_reference": ref(CRED, "app_credential"),
        },
        "child_tasks_local_reference_list": [],
        "variable_list": [],
        "target_any_local_reference": ref("Game", "app_service"),
        "timeout_secs": "0",
        "retries": "0",
        "inherit_target": False,
        "status_map_list": [],
    }
    start_leaf = {
        "type": "EXEC",
        "name": "Service start marker",
        "description": "",
        "attrs": {
            "type": "",
            "script": "echo started",
            "script_type": "sh",
            "command_line_args": "",
            "exit_status": [],
            "login_credential_local_reference": ref(CRED, "app_credential"),
        },
        "child_tasks_local_reference_list": [],
        "variable_list": [],
        "target_any_local_reference": ref("Game", "app_service"),
        "timeout_secs": "0",
        "retries": "0",
        "inherit_target": False,
        "status_map_list": [],
    }
    return {
        "name": "Game",
        "description": "",
        "tier": "",
        "singleton": False,
        "depends_on_list": [],
        "port_list": [],
        # A5 fix: hidden install-state vars moved from Service to Profile
        # (cf. build_profile()). Service has no var declarations now —
        # SET_VARIABLE tasks' eval_variables resolve to Profile-scoped vars,
        # macro reads in scripts use @@{CLUSTERUUID}@@ (no Game. prefix).
        # No more bidirectional Service↔Package binding → no cycle.
        "variable_list": [],
        "action_list": [
            system_action("action_create", runbook_with_one_task(create_leaf)),
            system_action("action_start", runbook_with_one_task(start_leaf)),
            system_action("action_stop", empty_runbook()),
            system_action("action_delete", empty_runbook()),
            system_action("action_restart", empty_runbook()),
            # D1 test: does action_soft_delete trigger PC's synthesis
            # of Profile/Package/Deployment.SoftDelete cycles?
            system_action("action_soft_delete", empty_runbook()),
        ],
    }


def build_substrate_image_pkg():
    return {
        "name": "Ubuntu2404",
        "description": "",
        "type": "SUBSTRATE_IMAGE",
        "service_local_reference_list": [],
        "options": {
            "type": "",
            "name": "Ubuntu2404",
            "description": "",
            "resources": {
                "type": "",
                "image_type": "DISK_IMAGE",
                "source_uri": "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img",
                "version": {"type": "", "product_name": "Ubuntu", "product_version": "24.04"},
                "architecture": "X86_64",
                "checksum": {"type": "", "checksum_value": "", "checksum_algorithm": ""},
            },
        },
        "variable_list": [],
        "action_list": [],
        "version": "",
    }


def build_install_pkg():
    return {
        "name": "Game Content",
        "description": "",
        "type": "DEB",
        "service_local_reference_list": [ref("Game", "app_service")],
        "options": {
            "type": "",
            "install_runbook": runbook_sequential([
                # A6: scale up to 14 install tasks (A4 minus Add AD users
                # + Upload prereq BPs which require Phase B/D3) WITH the
                # A5 fix applied: vars on Profile, scripts patched at read
                # to use @@{X}@@ instead of @@{Game.X}@@.
                make_escript_task("Activate policy engine", "activate_policy_engine.py"),
                make_set_variable_task("Get Cluster", "get_cluster.py", ["CLUSTERNAME", "CLUSTERUUID"]),
                make_escript_task("Ensure host 4 removed", "remove_node.py"),
                make_escript_task("Wait for cluster health", "cluster_health.py"),
                make_escript_task("Setup subnets", "setup_subnets.py"),
                make_set_variable_task("Setup production project", "setup_production_project.py", ["ProjectUUID"]),
                make_escript_task("Create Local users", "create_local_users.py"),
                # B2: PowerShell task on AD endpoint (cross-target).
                make_powershell_task("Add AD users", "add_ad_users.ps1", target_endpoint="AD"),
                make_escript_task("Create Prod VMs", "create_prod_vms.py"),
                make_escript_task("Setup jumphost endpoint", "setup_jumphost_endpoint.py"),
                make_escript_task("Clone fake BPs", "clone_fake_bps.py"),
                make_escript_task("Trigger LCM inventory", "trigger_lcm_inventory.py"),
                make_ssh_task("Install Docker", "install_docker.sh"),
                make_ssh_task("Run game container", "run_container.sh"),
                make_escript_task("Verify final state", "verify_state.py"),
            ]),
            "uninstall_runbook": empty_runbook(),
            "upgrade_runbook": {},
        },
        "variable_list": [],
        "action_list": [],
        "version": "",
    }


def build_substrate():
    return {
        "name": "VM",
        "description": "",
        "type": "AHV_VM",
        "os_type": "Linux",
        "create_spec": {
            "name": "ntnx-min-@@{calm_time}@@",
            "type": "",
            "categories": {"Environment": "Production"},
            "availability_zone_reference": None,
            "backup_policy": None,
            "cluster_reference": {"type": "", "kind": "cluster", "name": "", "uuid": STUB_UUID},
            "resources": {
                "type": "",
                "account_uuid": STUB_ACCOUNT_UUID,
                "memory_size_mib": 4096,
                "num_sockets": 2,
                "num_vcpus_per_socket": 1,
                "power_state": "ON",
                "hardware_clock_timezone": "",
                "guest_tools": None,
                "parent_reference": None,
                "vtpm_config": None,
                "gpu_list": [],
                "serial_port_list": [],
                "boot_config": {
                    "type": "",
                    "boot_type": "UEFI",
                    "mac_address": "",
                    "boot_device": {
                        "type": "",
                        "disk_address": {"type": "", "device_index": 0, "adapter_type": "SCSI"},
                    },
                },
                "disk_list": [
                    {
                        "type": "",
                        "data_source_reference": {
                            "type": "",
                            "kind": "app_package",
                            "name": "Ubuntu2404",
                            "uuid": STUB_PKG_UUID,
                        },
                        "volume_group_reference": None,
                        "device_properties": {
                            "type": "",
                            "device_type": "DISK",
                            "disk_address": {"type": "", "device_index": 0, "adapter_type": "SCSI"},
                        },
                        "disk_size_mib": 20480,
                    }
                ],
                "nic_list": [
                    {
                        "type": "",
                        "nic_type": "NORMAL_NIC",
                        "subnet_reference": {"type": "", "kind": "subnet", "name": "", "uuid": STUB_SUBNET_UUID},
                        "network_function_nic_type": "INGRESS",
                        "mac_address": "",
                        "ip_endpoint_list": [],
                        "network_function_chain_reference": None,
                        "vpc_reference": None,
                    }
                ],
                "guest_customization": {
                    "type": "",
                    "cloud_init": {"type": "", "meta_data": "", "user_data": CLOUD_INIT},
                    "sysprep": None,
                },
            },
        },
        "editables": {
            "create_spec": {
                "cluster_reference": True,
                "resources": {"nic_list": {"0": {"subnet_reference": True}}},
            }
        },
        "variable_list": [],
        "readiness_probe": {
            "connection_type": "SSH",
            "connection_port": 22,
            "delay_secs": "30",
            "retries": "5",
            "address": "@@{platform.status.resources.nic_list[0].ip_endpoint_list[0].ip}@@",
            "disable_readiness_probe": False,
            "connection_protocol": "",
            "login_credential_local_reference": ref(CRED, "app_credential"),
        },
        "action_list": [],
    }


def build_deployment():
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


def make_local_var(name, value="", label="", hidden=False, mandatory=False,
                   editable=True, choices=None, description=""):
    v = {
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


def make_secret_var(name, label="", mandatory=False):
    return {
        "type": "SECRET",
        "name": name,
        "description": "",
        "options": {"type": "PREDEFINED", "choices": []},
        "is_hidden": False,
        "is_mandatory": mandatory,
        "data_type": "BASE",
        "val_type": "STRING",
        "label": label,
        "attrs": {"type": "SECRET", "is_secret_modified": False, "secret_reference": {}},
        "value": "",
        "editables": {"value": True},
    }


def build_profile_action(name, description, leaf):
    """C3: day-2 user action on Profile. type='user' (vs 'system' for
    lifecycle actions). Single-task runbook wrapping the leaf."""
    dag = task_dag_single(leaf)
    rb = {
        "name": hex8() + "_runbook",
        "description": "",
        "main_task_local_reference": ref(dag["name"], "app_task"),
        "task_definition_list": [dag, leaf],
        "variable_list": [],
    }
    return {
        "type": "user",
        "name": name,
        "description": description,
        "critical": False,
        "runbook": rb,
    }


def build_profile():
    return {
        "name": "Default",
        "description": "",
        "application_url": "",
        "environment_reference_list": [],
        "deployment_create_list": [build_deployment()],
        # A5 fix: hidden install-state vars on Profile (not Service).
        # Avoids the bidirectional Service↔Package binding that triggers
        # PC 7.5's cycle synthesis. SET_VAR tasks in package install
        # write here; downstream tasks read via @@{X}@@ (Profile-scoped
        # macros — no entity prefix).
        "variable_list": [
            # Hidden state vars (set by SET_VAR install tasks)
            make_local_var("CLUSTERNAME", hidden=True),
            make_local_var("CLUSTERUUID", hidden=True),
            make_local_var("ProjectUUID", hidden=True),
            # C1+C2: full v2 runtime vars (parity)
            make_local_var("PC_IP", "", label="Prism Central IP", mandatory=True),
            make_local_var("PC_USERNAME", "admin", label="Prism Central username", mandatory=True),
            make_secret_var("PC_PASSWORD", label="Prism Central password", mandatory=True),
            make_local_var("IMAGE_REPO", "ghcr.io/r0w/ntnx-infiltration-game", label="Container image repository"),
            make_local_var("IMAGE_TAG", "latest", label="Image tag"),
            make_local_var("GHCR_USERNAME", "x-access-token", label="ghcr.io username"),
            make_secret_var("GHCR_TOKEN", label="ghcr.io token (empty for public images)"),
            make_local_var("CLUSTER_PROFILE", "other", label="Cluster profile",
                           mandatory=True, choices=["other", "hpoc"]),
            make_secret_var("ADMIN_PASSWORD", label="Game /admin password", mandatory=True),
            make_local_var("MODE", "live", label="Run mode", choices=["live", "test", "mock"]),
            make_local_var("LOG_LEVEL", "info", label="Server log level",
                           choices=["debug", "info", "warn", "error"]),
            make_local_var("TIMEZONE", "UTC", label="Time zone",
                           choices=["UTC", "Europe/Paris", "Europe/London", "America/New_York",
                                    "America/Los_Angeles", "Asia/Tokyo"]),
            make_local_var("GAME_VLAN_ID", "", label="Pinned VLAN id (empty = randomized 0-249 per session)"),
            make_local_var("GAME_PROD_USERNAME", "thebadguy", label="Production username"),
            make_secret_var("GAME_PROD_PASSWORD", label="Production user password"),
            make_local_var("GAME_OLD_PC", "", label="Legacy PC IP for stage 29"),
            make_local_var("GAME_OLD_PC_USERNAME", "planner", label="Legacy PC username"),
            make_secret_var("GAME_OLD_PC_PASSWORD", label="Legacy PC password"),
            make_local_var("GAME_EMAIL_REPORT", "", label="Email for end-game report (optional)"),
            make_local_var("GAME_FRONTEND_HOST", "", label="Public hostname (optional)"),
        ],
        "action_list": [
            # C3: day-2 user actions
            build_profile_action(
                "Update Game",
                "Pull a fresh image and restart the container",
                make_ssh_task("docker pull and restart container", "update_game.sh"),
            ),
            build_profile_action(
                "Verify State",
                "Re-run the post-install convergence checks",
                make_escript_task("Verify final state", "verify_state.py"),
            ),
        ],
        "patch_list": [],
        "snapshot_config_list": [],
        "restore_config_list": [],
    }


def build_credential():
    return {
        "type": "PASSWORD",
        "name": CRED,
        "description": "",
        "username": "nutanix",
        "secret": {"attrs": {"secret_reference": {}, "is_secret_modified": False}},
        "cred_class": "static",
        "editables": {"secret": True},
    }


def build_blueprint():
    return {
        "api_version": "3.0",
        "product_version": "4.3.0",
        "contains_secrets": False,
        "status": {},
        "metadata": {
            "kind": "blueprint",
            "name": "ntnx-min",
            "spec_version": 1,
        },
        "spec": {
            "name": "ntnx-min",
            "description": "Minimal diagnostic blueprint — 1 service, 1 install task",
            "resources": {
                "type": "",
                "client_attrs": {"None": ""},
                "default_credential_local_reference": ref(CRED, "app_credential"),
                "credential_definition_list": [build_credential()],
                "service_definition_list": [build_service()],
                "package_definition_list": [build_substrate_image_pkg(), build_install_pkg()],
                "substrate_definition_list": [build_substrate()],
                "published_service_definition_list": [],
                "app_profile_list": [build_profile()],
            },
        },
    }


def main():
    bp = build_blueprint()
    OUT.write_text(json.dumps(bp, indent=2))
    size = OUT.stat().st_size
    print(f"[ok] wrote {OUT.name} ({size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
