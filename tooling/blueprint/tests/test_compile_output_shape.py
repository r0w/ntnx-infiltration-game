"""
Shape-regression tests on the compiled+patched blueprint.json.

Reads `blueprint.patched.json` produced by `PATCH=1 ./compile.sh
blueprint.py` (or by CI's `compile-blueprint` job) and asserts the
output JSON matches the structure shipped releases must have.

Skipped (not failed) if the file isn't there yet — run the compile
once locally before pytest, or rely on CI to build it before this
test step. Decoupling the test from calm-dsl env makes it portable
to dev machines that haven't bootstrapped the venv.

Catches:
  - stub UUIDs leaking into metadata (would trip PC's owner/project
    binding on a different cluster);
  - sandbox-banned imports sneaking back into an escript;
  - service-bearing CUSTOM packages not retyped to DEB (would
    `Found cycles in tasks` at launch);
  - boot disk ending up at 0 (Docker install would `dpkg disk full`);
  - secret values shipped in plaintext (PC would ask for a passphrase
    on UI import and reject).
"""
import json
import re
from pathlib import Path

import pytest

HERE = Path(__file__).parent
BP_DIR = HERE.parent
PATCHED_JSON = BP_DIR / "blueprint.patched.json"

# Stub UUIDs from seed_ci_cache.py — none of these may appear in the
# shipping JSON. They're CI-only placeholders that get patched out.
STUB_UUID_RE = re.compile(r"00000000-0000-0000-0000-0000000000\d+")


@pytest.fixture(scope="module")
def compiled_bp() -> dict:
    """Read the patcher output. Skip if it doesn't exist — `PATCH=1
    ./compile.sh blueprint.py` is the build step that produces it."""
    if not PATCHED_JSON.exists():
        pytest.skip(
            f"{PATCHED_JSON.name} missing — run `PATCH=1 ./compile.sh "
            "blueprint.py` first (or let CI build it)"
        )
    return json.loads(PATCHED_JSON.read_text())


# ─── metadata: no stub references ─────────────────────────────────────────


def test_no_stub_uuid_in_metadata(compiled_bp: dict):
    """`patch_escript.strip_owner_reference` + `strip_project_reference`
    must run, otherwise PC rejects the import on a different cluster."""
    md = compiled_bp.get("metadata", {})
    # Both refs must be absent — UI import re-binds them.
    assert "owner_reference" not in md, (
        "metadata.owner_reference still present — strip pass regressed"
    )
    assert "project_reference" not in md, (
        "metadata.project_reference still present — strip pass regressed"
    )


def test_no_stub_uuid_anywhere_in_metadata(compiled_bp: dict):
    """Even if the strip passes ran, a stub UUID elsewhere in metadata
    would trip on launch. Belt-and-braces sweep."""
    blob = json.dumps(compiled_bp.get("metadata", {}))
    matches = STUB_UUID_RE.findall(blob)
    assert not matches, (
        f"stub UUIDs leaked into metadata: {matches}"
    )


# ─── secrets: canonical no-secret shape ───────────────────────────────────


def test_credentials_have_canonical_secret_shape(compiled_bp: dict):
    """Every credential's `secret` block must match calm-dsl's own
    strip_credentials output: `attrs={is_secret_modified:False,
    secret_reference:None}`, no `value`. Otherwise PC's UI import asks
    for a passphrase + fails."""
    creds = (
        compiled_bp.get("spec", {})
        .get("resources", {})
        .get("credential_definition_list", [])
    )
    assert creds, "BP has no credentials — unexpected"
    for cred in creds:
        sec = cred.get("secret", {})
        assert sec.get("attrs", {}).get("is_secret_modified") is False, (
            f"cred {cred.get('name')!r} has is_secret_modified != False"
        )
        # `value` must be absent (calm-dsl strip pops it).
        assert "value" not in sec, (
            f"cred {cred.get('name')!r} still carries a `value` field — "
            "would trigger passphrase decrypt on import"
        )


def test_profile_secret_vars_have_canonical_shape(compiled_bp: dict):
    """Same shape contract for SECRET-typed Profile variables."""
    profiles = (
        compiled_bp.get("spec", {}).get("resources", {}).get("app_profile_list", [])
    )
    secret_vars = [
        v
        for prof in profiles
        for v in prof.get("variable_list", [])
        if v.get("type") == "SECRET"
    ]
    assert secret_vars, "no SECRET-typed Profile vars found — unexpected"
    for v in secret_vars:
        assert v.get("attrs", {}).get("is_secret_modified") is False, (
            f"profile var {v.get('name')!r} has is_secret_modified != False"
        )
        assert "value" not in v, (
            f"profile var {v.get('name')!r} still carries a `value` — "
            "must be popped per canonical strip"
        )


# ─── packages: CUSTOM → DEB on services + sane shape ──────────────────────


def test_service_bearing_packages_retyped_to_deb(compiled_bp: dict):
    """A CUSTOM package with services attached triggers PC 7.5's
    auto-synthesized lifecycle actions and `Found cycles in tasks`. The
    rewrite_custom_packages_to_deb pass must convert it."""
    pkgs = (
        compiled_bp.get("spec", {})
        .get("resources", {})
        .get("package_definition_list", [])
    )
    for pkg in pkgs:
        if pkg.get("service_local_reference_list"):
            assert pkg["type"] != "CUSTOM", (
                f"package {pkg.get('name')!r} bears services + still typed "
                "CUSTOM — CUSTOM→DEB rewrite regressed"
            )


def test_install_runbook_has_at_least_10_tasks(compiled_bp: dict):
    """The shipped runbook is 15 install tasks; <10 means we lost half
    the install — almost certainly a regression in blueprint.py."""
    pkgs = (
        compiled_bp.get("spec", {})
        .get("resources", {})
        .get("package_definition_list", [])
    )
    install_tasks: list = []
    for pkg in pkgs:
        rb = pkg.get("options", {}).get("install_runbook")
        if isinstance(rb, dict):
            install_tasks.extend(
                t
                for t in rb.get("task_definition_list", [])
                if t.get("type") in ("EXEC", "SET_VARIABLE")
            )
    assert len(install_tasks) >= 10, (
        f"only {len(install_tasks)} install tasks (expected ≥10)"
    )


# ─── substrate: boot disk grown ───────────────────────────────────────────


def test_substrate_boot_disk_grown_to_40_gib(compiled_bp: dict):
    """`AhvVmDisk.Disk.Scsi.cloneFromVMDiskPackage()` emits 0 (=image
    native size, ~10 GiB on jammy cloudimg). Docker + game image needs
    more; the grow_substrate_boot_disk pass bumps to 40 GiB."""
    subs = (
        compiled_bp.get("spec", {})
        .get("resources", {})
        .get("substrate_definition_list", [])
    )
    ahv = [s for s in subs if s.get("type") == "AHV_VM"]
    assert ahv, "no AHV substrate found — unexpected"
    for s in ahv:
        disks = (
            s.get("create_spec", {}).get("resources", {}).get("disk_list", []) or []
        )
        if not disks:
            continue
        boot = disks[0]
        assert boot.get("disk_size_mib", 0) >= 40960, (
            f"substrate {s.get('name')!r} boot disk = {boot.get('disk_size_mib')} "
            "mib (expected ≥40960). Docker install would `dpkg disk full`."
        )


# ─── escripts: sandbox compatible ─────────────────────────────────────────


def test_no_banned_imports_in_escripts(compiled_bp: dict):
    """Calm 7.5 escript sandbox bans `sys`, `urllib3`, `time`, `json`. The
    `_patch_for_calm_escript` pass strips those imports + injects helpers.
    Walk every install/uninstall/upgrade runbook + every service / package /
    profile action and assert none of the static_py3 scripts has the
    forbidden imports at module level."""
    res = compiled_bp.get("spec", {}).get("resources", {})
    runbooks: list = []
    for c in (
        res.get("service_definition_list", [])
        + res.get("app_profile_list", [])
        + res.get("package_definition_list", [])
    ):
        for action in c.get("action_list", []):
            rb = action.get("runbook", {})
            if rb:
                runbooks.append(rb)
    for pkg in res.get("package_definition_list", []):
        for key in ("install_runbook", "uninstall_runbook", "upgrade_runbook"):
            rb = pkg.get("options", {}).get(key)
            if isinstance(rb, dict):
                runbooks.append(rb)
    banned_at_top = re.compile(
        r"^(import\s+(sys|urllib3|time|json)|from\s+(sys|urllib3|time|json))",
        re.MULTILINE,
    )
    leaks = []
    for rb in runbooks:
        for task in rb.get("task_definition_list", []):
            attrs = task.get("attrs", {})
            if attrs.get("script_type") not in ("static_py3", "static"):
                continue
            script = attrs.get("script", "")
            if not isinstance(script, str):
                continue
            for m in banned_at_top.finditer(script):
                leaks.append((task.get("name", "?"), m.group(0)))
    assert not leaks, (
        "sandbox-banned imports leaked through patcher:\n"
        + "\n".join(f"  task {n!r}: {imp!r}" for n, imp in leaks)
    )


def test_escripts_have_calm_exit_helper(compiled_bp: dict):
    """The sandbox patcher injects `_calm_exit` so scripts can exit-code
    out without importing `sys` or raising `SystemExit`. Every patched
    escript must carry the helper."""
    res = compiled_bp.get("spec", {}).get("resources", {})
    install_scripts = []
    for pkg in res.get("package_definition_list", []):
        for key in ("install_runbook", "uninstall_runbook", "upgrade_runbook"):
            rb = pkg.get("options", {}).get(key)
            if isinstance(rb, dict):
                install_scripts.extend(
                    t
                    for t in rb.get("task_definition_list", [])
                    if t.get("attrs", {}).get("script_type") in ("static_py3", "static")
                )
    assert install_scripts, "no escripts found — unexpected"
    for task in install_scripts:
        script = task["attrs"]["script"]
        # patcher injects helpers right after the #script header.
        assert "def _calm_exit" in script, (
            f"task {task.get('name')!r} missing _calm_exit helper — patcher pass 1 regressed"
        )
