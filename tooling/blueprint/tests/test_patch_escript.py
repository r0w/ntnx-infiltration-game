"""
Regression tests for the post-compile patcher in patch_escript.py.

Each test exercises one pass of the 6-pass pipeline against a small
synthetic input — fast (no calm-dsl, no PC), deterministic, focused
on the rules we learned the hard way during the v0.2.x → v0.3.x
iteration on a live HPoC. The companion live-deploy validation
(mission-complete sessions on DM3-POC100) covers the integration
side; these tests catch shape regressions before that.

Run from the repo root:
    tooling/blueprint/.venv/bin/pytest tooling/blueprint/tests/

Or from within tooling/blueprint/:
    ./.venv/bin/pytest tests/
"""
import sys
from pathlib import Path

# Make the patcher importable without packaging the dir.
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

from patch_escript import (  # noqa: E402
    _patch_for_calm_escript,
    grow_substrate_boot_disk,
    normalize_secrets_for_import,
    rewrite_custom_packages_to_deb,
    strip_owner_reference,
    strip_project_reference,
    walk_tasks,
)


# ─── Pass 1: sandbox patcher ─────────────────────────────────────────────


def test_patcher_strips_banned_imports():
    src = (
        "#script\n"
        '"""docstring"""\n'
        "import sys\n"
        "import urllib3\n"
        "import time\n"
        "import json\n"
        "import requests\n"
        "\n"
        "def main():\n"
        "    sys.exit(0)\n"
    )
    out = _patch_for_calm_escript(src)
    # Each banned import line is stripped at the top level.
    assert "\nimport sys\n" not in out
    assert "\nimport urllib3\n" not in out
    assert "\nimport time\n" not in out
    assert "\nimport json\n" not in out
    # `import requests` stays — that one is allowed.
    assert "import requests" in out


def test_patcher_rewrites_sys_exit_to_calm_exit():
    src = "#script\n\nimport sys\nsys.exit(2)\n"
    out = _patch_for_calm_escript(src)
    assert "sys.exit" not in out
    assert "_calm_exit(2)" in out


def test_patcher_rewrites_time_sleep_to_sleep_secs():
    import re

    src = "#script\n\nimport time\ntime.sleep(5)\n"
    out = _patch_for_calm_escript(src)
    # The literal string "time.sleep" appears in the helper docstring
    # ("Approximate sleep without time.sleep (sandbox-banned)") — assert
    # the absence of an actual *call* (followed by paren), not the
    # comment-mention.
    assert not re.search(r"\btime\.sleep\(", out)
    assert "_sleep_secs(5)" in out


def test_patcher_rewrites_data_json_dumps_to_json_kwarg():
    src = (
        "#script\n\nimport json\n"
        'requests.post(url, headers=HEADERS, data=json.dumps({"a": 1}))\n'
    )
    out = _patch_for_calm_escript(src)
    assert "data=json.dumps" not in out
    assert 'json=({"a": 1})' in out


def test_patcher_injects_helpers_after_script_marker():
    src = "#script\n\nimport sys\nsys.exit(0)\n"
    out = _patch_for_calm_escript(src)
    # All 5 helpers must be defined exactly once.
    assert out.count("def _calm_exit") == 1
    assert out.count("def _sleep_secs") == 1
    assert out.count("def _req_id") == 1
    assert out.count("def _req_headers") == 1
    assert out.count("def _fake_time") == 1


def test_patcher_rewrites_game_var_to_profile_scope():
    """Cycle-fix shape: `@@{Game.X}@@` (Service-scoped) is rewritten to
    `@@{X}@@` (bare = Profile-scoped) for the three captured-state vars.
    Reading those off the Service while writing them via SET_VARIABLE
    closes a back-edge in PC's lifecycle planner. Profile scope sidesteps."""
    src = "#script\n\nx = '@@{Game.CLUSTERNAME}@@ @@{Game.CLUSTERUUID}@@ @@{Game.ProjectUUID}@@'\n"
    out = _patch_for_calm_escript(src)
    assert "@@{Game.CLUSTERNAME}@@" not in out
    assert "@@{CLUSTERNAME}@@" in out
    assert "@@{CLUSTERUUID}@@" in out
    assert "@@{ProjectUUID}@@" in out


def test_patcher_wraps_headers_call_with_req_headers():
    src = "#script\n\nrequests.post(url, headers=HEADERS, json={})\n"
    out = _patch_for_calm_escript(src)
    assert "headers=HEADERS" not in out
    assert "headers=_req_headers(HEADERS)" in out


# ─── Pass 2: CUSTOM → DEB on service-bearing packages ─────────────────────


def test_custom_to_deb_only_for_service_bearing_packages():
    bp = {
        "spec": {
            "resources": {
                "package_definition_list": [
                    {  # service-bearing CUSTOM → should retype to DEB
                        "type": "CUSTOM",
                        "service_local_reference_list": [{"kind": "app_service", "uuid": "x"}],
                    },
                    {  # CUSTOM with no services → stays CUSTOM (image package)
                        "type": "CUSTOM",
                        "service_local_reference_list": [],
                    },
                    {  # SUBSTRATE_IMAGE → unchanged
                        "type": "SUBSTRATE_IMAGE",
                        "service_local_reference_list": [{"kind": "x", "uuid": "y"}],
                    },
                ]
            }
        }
    }
    n = rewrite_custom_packages_to_deb(bp)
    assert n == 1
    pkgs = bp["spec"]["resources"]["package_definition_list"]
    assert pkgs[0]["type"] == "DEB"
    assert pkgs[1]["type"] == "CUSTOM"
    assert pkgs[2]["type"] == "SUBSTRATE_IMAGE"


# ─── Pass 3: boot disk grow ───────────────────────────────────────────────


def test_grow_substrate_boot_disk_only_when_zero():
    bp = {
        "spec": {
            "resources": {
                "substrate_definition_list": [
                    {
                        "type": "AHV_VM",
                        "create_spec": {
                            "resources": {
                                "disk_list": [
                                    {"disk_size_mib": 0},  # boot disk → grow
                                    {"disk_size_mib": 0},  # second disk → leave alone (only first)
                                ]
                            }
                        },
                    },
                    {
                        "type": "AHV_VM",
                        "create_spec": {
                            "resources": {
                                "disk_list": [
                                    {"disk_size_mib": 100000},  # already sized → leave
                                ]
                            }
                        },
                    },
                    {  # non-AHV substrate, skipped
                        "type": "EXISTING_VM",
                        "create_spec": {"resources": {"disk_list": [{"disk_size_mib": 0}]}},
                    },
                ]
            }
        }
    }
    n = grow_substrate_boot_disk(bp, target_mib=40960)
    assert n == 1
    disks = bp["spec"]["resources"]["substrate_definition_list"][0]["create_spec"][
        "resources"
    ]["disk_list"]
    assert disks[0]["disk_size_mib"] == 40960
    assert disks[1]["disk_size_mib"] == 0  # only first disk grown


# ─── Pass 4: strip metadata.owner_reference ───────────────────────────────


def test_strip_owner_reference():
    bp = {"metadata": {"owner_reference": {"uuid": "stub-uuid"}, "kind": "blueprint"}}
    n = strip_owner_reference(bp)
    assert n == 1
    assert "owner_reference" not in bp["metadata"]
    assert "kind" in bp["metadata"]


def test_strip_owner_reference_idempotent():
    bp = {"metadata": {"kind": "blueprint"}}
    n = strip_owner_reference(bp)
    assert n == 0


# ─── Pass 5: strip metadata.project_reference ─────────────────────────────


def test_strip_project_reference():
    bp = {
        "metadata": {
            "project_reference": {"uuid": "stub-uuid", "name": "production"},
            "kind": "blueprint",
        }
    }
    n = strip_project_reference(bp)
    assert n == 1
    assert "project_reference" not in bp["metadata"]


# ─── Pass 6: normalize secrets for import ─────────────────────────────────


def test_normalize_secrets_credentials():
    bp = {
        "spec": {
            "resources": {
                "credential_definition_list": [
                    {
                        "name": "NUTANIX",
                        "secret": {
                            "value": "plaintext-leak",
                            "attrs": {"is_secret_modified": True},
                        },
                    }
                ],
                "app_profile_list": [],
            }
        }
    }
    n = normalize_secrets_for_import(bp)
    assert n == 1
    sec = bp["spec"]["resources"]["credential_definition_list"][0]["secret"]
    # Canonical no-secret shape: no value field, attrs flag false + null ref.
    assert "value" not in sec
    assert sec["attrs"]["is_secret_modified"] is False
    assert sec["attrs"]["secret_reference"] is None


def test_normalize_secrets_profile_variables():
    bp = {
        "spec": {
            "resources": {
                "credential_definition_list": [],
                "app_profile_list": [
                    {
                        "variable_list": [
                            {
                                "name": "PC_PASSWORD",
                                "type": "SECRET",
                                "value": "plaintext-leak",
                                "attrs": {"is_secret_modified": True},
                            },
                            {
                                "name": "CLUSTER_PROFILE",
                                "type": "LOCAL",
                                "value": "hpoc",  # non-secret, must be preserved
                            },
                        ]
                    }
                ],
            }
        }
    }
    n = normalize_secrets_for_import(bp)
    assert n == 1
    vars_list = bp["spec"]["resources"]["app_profile_list"][0]["variable_list"]
    secret_var = next(v for v in vars_list if v["name"] == "PC_PASSWORD")
    assert "value" not in secret_var
    assert secret_var["attrs"] == {
        "is_secret_modified": False,
        "secret_reference": None,
    }
    # LOCAL var passes through untouched.
    local_var = next(v for v in vars_list if v["name"] == "CLUSTER_PROFILE")
    assert local_var["value"] == "hpoc"


# ─── walk_tasks integration ───────────────────────────────────────────────


def test_walk_tasks_patches_install_runbook_escripts():
    """The patcher's main entry point must reach install/uninstall/upgrade
    runbooks under packages, AND day-2 actions on services / profiles /
    packages — that's what `walk_tasks` covers."""
    bp = {
        "spec": {
            "resources": {
                "service_definition_list": [],
                "package_definition_list": [
                    {
                        "options": {
                            "install_runbook": {
                                "task_definition_list": [
                                    {
                                        "type": "EXEC",
                                        "attrs": {
                                            "script_type": "static_py3",
                                            "script": "#script\nimport sys\nsys.exit(0)\n",
                                        },
                                    }
                                ]
                            }
                        }
                    }
                ],
                "app_profile_list": [],
            }
        }
    }
    n = walk_tasks(bp, _patch_for_calm_escript)
    assert n == 1
    rewritten = bp["spec"]["resources"]["package_definition_list"][0]["options"][
        "install_runbook"
    ]["task_definition_list"][0]["attrs"]["script"]
    assert "sys.exit" not in rewritten
    assert "_calm_exit" in rewritten


def test_walk_tasks_skips_shell_and_powershell_scripts():
    """Only `static_py3` / `static` script types are escripts. Sh + PowerShell
    keep their content as-is — they don't run inside the escript sandbox."""
    bp = {
        "spec": {
            "resources": {
                "service_definition_list": [],
                "package_definition_list": [
                    {
                        "options": {
                            "install_runbook": {
                                "task_definition_list": [
                                    {
                                        "type": "EXEC",
                                        "attrs": {
                                            "script_type": "sh",
                                            "script": "import sys\nsys.exit(0)",
                                        },
                                    },
                                    {
                                        "type": "EXEC",
                                        "attrs": {
                                            "script_type": "powershell",
                                            "script": "Write-Host 'sys.exit(0)'",
                                        },
                                    },
                                ]
                            }
                        }
                    }
                ],
                "app_profile_list": [],
            }
        }
    }
    n = walk_tasks(bp, _patch_for_calm_escript)
    assert n == 0
    # shell/ps content untouched
    sh = bp["spec"]["resources"]["package_definition_list"][0]["options"][
        "install_runbook"
    ]["task_definition_list"][0]["attrs"]["script"]
    assert sh.startswith("import sys")
