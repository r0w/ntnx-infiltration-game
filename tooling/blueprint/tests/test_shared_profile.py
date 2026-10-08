"""A shared-cluster install may only prepare its own game VM."""
import json
import os
import shutil
import sys
import subprocess
from pathlib import Path

import pytest

from . import test_compile_output_shape as shape


@pytest.fixture(scope="module")
def shared_bp():
    path = Path(__file__).parents[1] / "blueprint.shared.patched.json"
    if not path.exists():
        if not (path.parent / "blueprint.patched.json").exists():
            pytest.skip("Compile the full blueprint first, as in CI")
        calm = shutil.which("calm") or str(path.parent / ".venv/bin/calm")
        env = dict(os.environ, NIG_DEPLOYMENT_ONLY="1")
        result = subprocess.run(
            [calm, "compile", "bp", "-f", "blueprint.py", "--out", "json"],
            cwd=path.parent, env=env, capture_output=True, text=True, timeout=60,
        )
        assert result.returncode == 0, result.stderr
        # Use the same post-compile passes as the shipped blueprint.
        raw = path.with_name("blueprint.shared.json")
        raw.write_text(result.stdout)
        subprocess.run(
            [sys.executable, "patch_escript.py", str(raw), str(path)],
            cwd=path.parent, check=True, capture_output=True, timeout=60,
        )
    return json.loads(path.read_text())


def test_shared_install_only_runs_tasks_on_its_new_vm(shared_bp):
    packages = shared_bp["spec"]["resources"]["package_definition_list"]
    expected = {
        "Game Content": ["Install Docker", "Run game container"],
        "NKP Game Content": ["Install Docker", "Fetch NKP kubeconfig", "Run game container"],
    }
    for package in packages:
        if package["name"] not in expected:
            assert package["type"] == "SUBSTRATE_IMAGE"
            continue
        rb = package["options"]["install_runbook"]
        tasks = [t for t in rb["task_definition_list"] if t["type"] != "DAG"]
        assert [t["name"] for t in tasks] == expected[package["name"]]
        assert all(t["type"] == "EXEC" and t["attrs"]["script_type"] == "sh" for t in tasks)
        for task in tasks:
            assert "endpoint_reference" not in json.dumps(task)
        dag = next(t for t in rb["task_definition_list"] if t["type"] == "DAG")
        assert [t["name"] for t in dag["child_tasks_local_reference_list"]] == expected[package["name"]]
        assert [(e["from_task_reference"]["name"], e["to_task_reference"]["name"])
                for e in dag["attrs"]["edges"]] == list(zip(expected[package["name"]], expected[package["name"]][1:]))


def test_shared_blueprint_has_no_ad_endpoint_dependency(shared_bp):
    assert "endpoint_reference" not in json.dumps(shared_bp)
    assert "Add AD users" not in json.dumps(shared_bp)


def test_shared_ncp_cannot_select_dedicated_cluster_operations(shared_bp):
    profiles = shared_bp["spec"]["resources"]["app_profile_list"]
    assert [p["name"] for p in profiles] == ["NCP", "NKPFundamentals"]
    for profile in profiles:
        variables = {v["name"]: v for v in profile["variable_list"]}
        assert variables["CLUSTER_PROFILE"]["value"] == "other"
    ncp = profiles[0]
    variable = next(v for v in ncp["variable_list"] if v["name"] == "CLUSTER_PROFILE")
    assert "hpoc" not in json.dumps(variable)


def test_shared_artifact_keeps_import_and_vm_contracts(shared_bp):
    shape.test_no_stub_uuid_in_metadata(shared_bp)
    shape.test_credentials_have_canonical_secret_shape(shared_bp)
    shape.test_profile_secret_vars_have_canonical_shape(shared_bp)
    shape.test_service_bearing_packages_retyped_to_deb(shared_bp)
    shape.test_substrate_boot_disk_grown_to_40_gib(shared_bp)
    shape.test_no_banned_imports_in_escripts(shared_bp)
