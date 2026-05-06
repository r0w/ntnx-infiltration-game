"""
Post-compile patcher for the Calm blueprint.

Why this file exists
====================

`calm compile bp` (calm-dsl 4.3.1) emits a `blueprint.json` that
*almost* works on Prism Central 7.5 — six structural quirks block
import or launch. This patcher applies them in one auditable place,
after compile, so the source files (`blueprint.py`, `scripts/*.py`)
stay readable as plain Python.

Two families of fixes
=====================

A. Sandbox compatibility (pass 1 — `_patch_for_calm_escript`)
   Calm 7.5's `escript.py3` runtime sandboxes Python: imports of
   `sys`, `json`, `time`, `urllib3`, `os`, `tarfile`, `io`, `shutil`,
   `tempfile` are rejected at runtime with
   `Syntax Error: import of "X" not allowed`. We write the source
   scripts in normal Python (readable, locally debuggable, unit
   tests can `import` them) and the patcher rewrites them into
   sandbox dialect just before they ship:
     - strips banned imports
     - `time.sleep(N)`     → `_sleep_secs(N)` (TCP-timeout trick on
                              non-routable 192.0.2.1 — RFC 5737)
     - `time.time()`       → `_fake_time()` (incrementing counter)
     - `sys.exit(N)`       → `_calm_exit(N)` (raises generic Exception)
     - `data=json.dumps(X)`→ `json=X` (requests' native serialization)
     - `headers=HEADERS`   → `headers=_req_headers(HEADERS)` (injects
                              a fresh NTNX-Request-Id per v4 mutation —
                              required header on PC 7.5 POST/PUT/DELETE)
   The helper functions (~25 lines) are injected at the top of each
   script. Per-script duplication is intentional: each escript runs
   in isolation, no shared imports across tasks.

   This pass also rewrites `@@{Game.X}@@` → `@@{X}@@` for three vars
   (CLUSTERNAME / CLUSTERUUID / ProjectUUID). PC 7.5's lifecycle
   planner detects a back-edge cycle when a SET_VARIABLE task reads
   AND writes a Service-scoped var; rescoping to Profile breaks the
   cycle. The rewrite emulates "as if these were declared at Profile
   level in blueprint.py" — ports the val without restructuring the
   DSL source.

B. Structural mismatches (passes 2-6)
   Five bugs in the calm-dsl 4.3.1 ⇄ PC 7.5 contract that calm-dsl
   doesn't address itself:

     2. `rewrite_custom_packages_to_deb` — service-bearing packages
        compile to `type=CUSTOM`. PC 7.5 auto-synthesizes lifecycle
        actions on CUSTOM packages that close back-edges →
        "Found cycles in tasks" → launch refused. Force `type=DEB`
        (same payload, just a hint to PC's lifecycle planner that
        skips the synthesis).

     3. `grow_substrate_boot_disk` — `cloneFromVMDiskPackage()`
        emits `disk_size_mib: 0`, which means "image native size"
        (jammy cloudimg ~10 GiB virtual). Docker install + game
        image pull blow that out (validated live: dpkg failed
        "disk full" mid-`docker-ce` install). Bump to 40 GiB.

     4. `strip_owner_reference` — calm-dsl bakes the seeded
        pc_username's UUID (our CI stub `00000000-...-000000000007`)
        into `metadata.owner_reference`. PC 7.5 enforces
        `owner_uuid == auth_user_uuid` at upload, rejecting any
        pre-set value. Strip the field; PC assigns the uploader.

     5. `strip_project_reference` — same story for the seeded
        project UUID. On UI import the stub silently falls back to
        the system project `_internal`, which has no
        accounts/envs/subnets, and clicking Launch crashes Prism's
        `onAutoProjectPick` handler with `Cannot read properties of
        undefined`. Strip the field; UI forces a real picker.

     6. `normalize_secrets_for_import` — SECRET vars are compiled
        with `value=<plaintext>` set. PC 7.5's UI import treats any
        non-empty `value` as ciphertext and prompts for a passphrase
        to decrypt; with plaintext the decrypt fails. Normalize to
        calm-dsl's own canonical no-secret shape: pop `value`, set
        `attrs={is_secret_modified: False, secret_reference: None}`.
        Operator fills the real secrets in Prism UI at Activate.

Why centralized rather than dispersed
=====================================

Each fix could in theory live elsewhere — sandbox rewrites in the
source scripts directly, CUSTOM→DEB declared in `blueprint.py`,
owner/project refs stripped at the seed step, secrets normalized via
calm-dsl's own helpers (`api.util.strip_credentials` /
`strip_entity_secret_variables`). That redistribution moves the same
lines around without reducing total LoC — and hides the fact that
"calm-dsl + Calm 7.5 disagree" behind innocent-looking source files.

Keeping the patches in one auditable file makes the seam visible:
when calm-dsl 5.x ships, or PC 8.x relaxes the sandbox, this is the
first place to revisit. Each pass is independently disable-able and
covered by targeted unit tests, so confirming "we no longer need
pass N" is a one-line change + a green test run.

Tested by `tests/test_patch_escript.py` (16 unit tests covering each
pass independently) and `tests/test_compile_output_shape.py` (9
shape-regression tests on the shipped `blueprint.patched.json` —
no banned imports, secrets canonical, ≥10 install tasks, etc).

Usage:
    python3 patch_escript.py <input.json> <output.json>

If input == output, patches in-place. The compile step in
`compile.sh` chains it after `calm compile bp`; CI does the same.
"""

from __future__ import annotations
import pathlib
import re
import sys
import json


def _patch_for_calm_escript(s: str) -> str:
    """Apply build-time rewrites that adapt source scripts to Calm 7.5's
    escript sandbox + the v3-tmp cycle fix:

    1. Profile-scope hidden state vars: rewrite `@@{Game.X}@@` → `@@{X}@@`
       for CLUSTERNAME, CLUSTERUUID, ProjectUUID (cycle root cause —
       SET_VARIABLE that reads + writes Service vars trips PC 7.5's
       lifecycle planner into back-edge detection).
    2. Banned imports: Calm escript.py3 sandbox rejects `import sys` with
       'Syntax Error: import of "sys" not allowed'. Strip the import +
       rewrite `sys.exit(N)` → `_calm_exit(N)` (helper, no import).
    """
    for var in ("CLUSTERNAME", "CLUSTERUUID", "ProjectUUID"):
        s = s.replace(f"@@{{Game.{var}}}@@", f"@@{{{var}}}@@")
    # Strip banned imports. Calm escript sandbox bans: sys, urllib3, time, json.
    s = re.sub(r"^import sys\s*\n", "", s, flags=re.MULTILINE)
    s = re.sub(r"^import urllib3\s*\n", "", s, flags=re.MULTILINE)
    s = re.sub(r"^urllib3\.disable_warnings\([^)]*\)\s*\n", "", s, flags=re.MULTILINE)
    s = re.sub(r"^import time\s*\n", "", s, flags=re.MULTILINE)
    s = re.sub(r"\btime\.sleep\(([^)]*)\)", r"_sleep_secs(\1)", s)
    s = re.sub(r"\btime\.time\(\)", "_fake_time()", s)
    s = re.sub(r"^import json\s*\n", "", s, flags=re.MULTILINE)
    s = re.sub(r"data=json\.dumps\(", "json=(", s)
    # SystemExit is banned at runtime — rewrite both styles to _calm_exit.
    s = re.sub(r"\bsys\.exit\(", "_calm_exit(", s)
    s = re.sub(r"\braise\s+SystemExit\(", "_calm_exit(", s)
    # NTNX-Request-Id idempotency header is required on PC 7.5 v4 API
    # mutations. Wrap `headers=HEADERS` with a per-call fresh-id helper.
    s = re.sub(r"headers=HEADERS\b", "headers=_req_headers(HEADERS)", s)
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
    if s.startswith("#script"):
        # Insert helper after the leading "#script" marker + optional docstring.
        lines = s.split("\n")
        i = 1
        while i < len(lines) and not lines[i].strip():
            i += 1
        if i < len(lines) and lines[i].lstrip().startswith('"""'):
            j = i + 1
            while j < len(lines) and '"""' not in lines[j]:
                j += 1
            i = j + 1
        s = "\n".join(lines[:i] + ["", helper.rstrip()] + lines[i:])
    else:
        s = helper + s
    return s


def _patch_runbook(runbook: dict, patcher) -> int:
    """Walk a single runbook's task_definition_list and patch escripts
    in-place. Returns the number of scripts patched."""
    count = 0
    for task in runbook.get("task_definition_list", []):
        attrs = task.get("attrs", {})
        script = attrs.get("script")
        # Only patch escripts (type=EXEC|SET_VARIABLE, script_type=static_py3).
        # Shell + PowerShell scripts go through the same field but the
        # patcher semantics don't apply — skip.
        if not isinstance(script, str):
            continue
        if attrs.get("script_type") not in ("static_py3", "static"):
            continue
        attrs["script"] = patcher(script)
        count += 1
    return count


def walk_tasks(blueprint: dict, patcher) -> int:
    """Walk every task_definition_list across services, profiles, and
    packages, apply the patcher to escript content. Returns the number
    of scripts patched.

    calm-dsl emits scripts under three patterns we need to cover:
      - service.action_list[].runbook.task_definition_list[]
        (e.g. action_create / action_start hooks on a Service)
      - app_profile_list[].action_list[].runbook.task_definition_list[]
        (Profile day-2 actions like UpdateGame / VerifyState)
      - package_definition_list[].options.{install,uninstall,upgrade}_runbook
        .task_definition_list[]
        (the Package install runbook — the BIG one with all 14+ install tasks)

    Walking via known keys (rather than blanket "find any .script field")
    keeps the traversal explicit and audit-able.
    """
    count = 0
    res = blueprint.get("spec", {}).get("resources", {})
    containers = (
        res.get("service_definition_list", [])
        + res.get("app_profile_list", [])
        + res.get("package_definition_list", [])
    )
    for c in containers:
        for action in c.get("action_list", []):
            count += _patch_runbook(action.get("runbook", {}), patcher)
    # Package install / uninstall / upgrade runbooks live under options,
    # not action_list. Walk those separately.
    for pkg in res.get("package_definition_list", []):
        opts = pkg.get("options", {})
        for key in ("install_runbook", "uninstall_runbook", "upgrade_runbook"):
            rb = opts.get(key)
            if isinstance(rb, dict):
                count += _patch_runbook(rb, patcher)
    return count


def grow_substrate_boot_disk(blueprint: dict, target_mib: int = 40960) -> int:
    """Set boot disk size on AHV substrates to `target_mib`.

    Why: calm-dsl's `AhvVmDisk.Disk.Scsi.cloneFromVMDiskPackage()` emits
    `disk_size_mib: 0` which means "image native size" (jammy cloudimg
    is ~10 GB virtual). Docker install + game image pull + container
    needs more — Phase 2.6 step 8 confirmed live: dpkg failed with
    "disk full" mid-docker-ce install on 10 GB. v2 hand-authored
    `disk_size_mib: 40960` (40 GB) for the same reason.

    Walks every substrate's first disk (the boot disk per
    `AhvVmDisk.Disk.Scsi.cloneFromVMDiskPackage(..., bootable=True)`)
    and bumps `disk_size_mib` if it's currently 0. Skips disks that
    already have a size set so explicit overrides aren't clobbered.
    """
    count = 0
    for sub in blueprint.get("spec", {}).get("resources", {}).get(
        "substrate_definition_list", []
    ):
        if sub.get("type") != "AHV_VM":
            continue
        disks = (
            sub.get("create_spec", {})
            .get("resources", {})
            .get("disk_list", [])
        )
        for d in disks:
            if d.get("disk_size_mib", 0) == 0:
                d["disk_size_mib"] = target_mib
                count += 1
                break  # only the first (boot) disk
    return count


def rewrite_custom_packages_to_deb(blueprint: dict) -> int:
    """Force CUSTOM packages with services attached to type=DEB.

    Why: calm-dsl 4.3.1 emits Package(type=CUSTOM) by default. PC 7.5
    auto-synthesizes lifecycle actions (action_create / action_delete /
    action_soft_delete) on CUSTOM packages, AND on the parent Profile +
    Deployment, that close back-edges → `Found cycles in tasks` errors
    that BLOCK launch (validated 2026-05-01 on DM3-POC037: the warnings
    visible in DRAFT state surface as launch-time errors).

    The legacy ntnx-escape-game BP + v2 (manual JSON assembler) use
    type=DEB which avoids the synthesis. Same payload otherwise — DEB
    is purely a hint to PC's lifecycle planner. We rewrite here as a
    single targeted structural fix (NOT a scrub-warnings treadmill —
    the v2 README documents this as a known structural choice).

    Skips SUBSTRATE_IMAGE packages (Ubuntu2204) — those legitimately
    stay CUSTOM-shaped underneath; the synthesis only affects packages
    with `service_local_reference_list` populated.
    """
    count = 0
    for pkg in blueprint.get("spec", {}).get("resources", {}).get(
        "package_definition_list", []
    ):
        if pkg.get("type") != "CUSTOM":
            continue
        if not pkg.get("service_local_reference_list"):
            continue
        pkg["type"] = "DEB"
        count += 1
    return count


def strip_owner_reference(blueprint: dict) -> int:
    """Drop metadata.owner_reference so the BP imports cleanly on any PC.

    Why: calm-dsl bakes the seeded pc_username's UUID (our CI stub user
    `00000000-...-000000000007`) into metadata.owner_reference. Calm 7.5
    enforces `owner_uuid == auth_user_uuid` at upload, rejecting any
    pre-set value with:
        "owner reference user uuid is not matched with auth user uuid
         and existing owner uuid if any"
    Without the field, Calm assigns the uploader as owner. Same fix as
    v2's postprocess_bp.py.
    """
    if blueprint.get("metadata", {}).pop("owner_reference", None) is not None:
        return 1
    return 0


def normalize_secrets_for_import(blueprint: dict) -> int:
    """Strip secrets to calm-dsl's canonical shape so UI import doesn't
    trigger the passphrase-decrypt flow.

    Calm 7.5 import flow: when a SECRET-typed field has any non-empty
    `value`, PC treats it as ciphertext and tries to decrypt with the
    operator-provided BP passphrase. With our plaintext values the
    decrypt fails:
        "Provided passphrase is wrong. Please enter correct passphrase"

    The fix is to match exactly what calm-dsl's own `strip_credentials`
    + `strip_entity_secret_variables` produce when uploading via the
    `calm create bp` CLI: POP the `value` field entirely (NOT set to "")
    and replace `attrs` with the canonical pair
    `{"is_secret_modified": False, "secret_reference": None}`.

    See site-packages/calm/dsl/api/util.py:223-234 + 539-549.

    Operator fills the genuinely-secret values (PC_PASSWORD, GHCR_TOKEN,
    ADMIN_PASSWORD) at Activate via Prism UI; PC encrypts them with the
    session key at that point. launch.py path is unaffected — its own
    strip_secrets() produces the same shape.

    Game-deterministic values that need to ship pre-filled
    (e.g. GAME_PROD_PASSWORD pinned to add_ad_users.ps1) should be
    declared as `CalmVariable.Simple` (non-secret) in blueprint.py
    instead — those bypass this strip entirely.
    """
    count = 0
    res = blueprint.get("spec", {}).get("resources", {})
    # Credentials.
    for cred in res.get("credential_definition_list", []):
        cred["secret"] = {
            "attrs": {"is_secret_modified": False, "secret_reference": None},
        }
        count += 1
    # Profile secret variables.
    for prof in res.get("app_profile_list", []):
        for v in prof.get("variable_list", []):
            if v.get("type") != "SECRET":
                continue
            v.pop("value", None)
            v["attrs"] = {"is_secret_modified": False, "secret_reference": None}
            count += 1
    return count


def strip_project_reference(blueprint: dict) -> int:
    """Drop metadata.project_reference so Prism UI forces a valid project pick.

    Why: calm-dsl bakes the seeded project's UUID (our CI stub project
    `00000000-...-000000000001`) into metadata.project_reference.
    On import via Prism UI, Calm tries to resolve the UUID against
    real projects; if it doesn't match (always the case off our compile
    cluster), it silently falls back to the system project `_internal`.
    `_internal` has zero accounts/environments/subnets, so when the
    operator clicks Launch, Prism's `onAutoProjectPick` handler crashes:
        TypeError: Cannot read properties of undefined (reading 'set')
    and shows "Looks like something went wrong here".

    With the field stripped, Prism's upload form forces the operator to
    pick a project from a dropdown of valid ones — same UX as a brand
    new BP. The picked project's UUID is then written into
    project_reference at import time. Launch via API (launch.py) is
    unaffected because it sets project explicitly via runtime_editables.
    """
    if blueprint.get("metadata", {}).pop("project_reference", None) is not None:
        return 1
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    src, dst = argv[1], argv[2]
    blueprint = json.loads(pathlib.Path(src).read_text())
    patcher = _patch_for_calm_escript
    n_scripts = walk_tasks(blueprint, patcher)
    n_pkgs = rewrite_custom_packages_to_deb(blueprint)
    n_disks = grow_substrate_boot_disk(blueprint)
    n_owner = strip_owner_reference(blueprint)
    n_proj = strip_project_reference(blueprint)
    n_secrets = normalize_secrets_for_import(blueprint)
    pathlib.Path(dst).write_text(json.dumps(blueprint, indent=4))
    print(
        f"patched {n_scripts} escript(s) + retyped {n_pkgs} CUSTOM→DEB pkg(s) "
        f"+ grew {n_disks} boot disk(s) to 40 GiB + stripped {n_owner} owner_reference + "
        f"stripped {n_proj} project_reference + normalized {n_secrets} secret(s): {src} -> {dst}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
