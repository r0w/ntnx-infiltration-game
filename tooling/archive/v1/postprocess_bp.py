"""Post-compile scrub for the blueprint.json calm-dsl 4.3.1 emits, to
make it digestible by Calm 7.5's stricter API validators.

Each transform documents the symptom it fixes (the exact PC error
text), so future drift between calm-dsl and Calm server can be
diagnosed without hunting through commit history.

Usage: python postprocess_bp.py blueprint.json
"""

import json
import sys


def scrub(bp: dict) -> dict:
    res = bp.setdefault("spec", {}).setdefault("resources", {})

    # 1. metadata.owner_reference
    # calm-dsl bakes the cached pc_username uuid here. Calm 7.5 enforces
    # owner_uuid == auth_user_uuid at upload, rejecting any pre-set value:
    #   "owner reference user uuid is not matched with auth user uuid"
    # Without the field, Calm assigns the uploader as owner.
    bp.get("metadata", {}).pop("owner_reference", None)

    # 2a. service_definition_list[].container_spec
    # calm-dsl 4.3.1 emits {} unconditionally; legacy omits the key
    # entirely. PC 7.5 interprets a present (even empty) container_spec
    # as "this is a container service" and wires container lifecycle
    # (Create → Start → Install → ...) which generates the cycle
    # visible in Profile.Create's system-defined action.
    for svc in res.get("service_definition_list", []):
        if svc.get("container_spec") in ({}, None):
            svc.pop("container_spec", None)

    # 2. spec.resources.global_variable_reference_list
    # calm-dsl emits `[]` unconditionally; the upload schema in 7.5 lists
    # this as an unknown property:
    #   "Additional properties are not allowed ('global_variable_reference_list' was unexpected)"
    # The legacy ntnx-escape-game BP also has it but went through a path
    # that 7.5 still accepts (.tgz import?); JSON paste rejects it.
    res.pop("global_variable_reference_list", None)

    # 3. Per-package shape: missing fields that 7.5 requires even when
    # empty. Symptom: "Package options are invalid" (the error text is
    # vague — these three fields are what the legacy supplies and we
    # don't, and adding them makes the rejection go away).
    # Also flip type CUSTOM → DEB: empirically 2026-04-28, PC 7.5
    # synthesizes Create/Delete/SoftDelete lifecycle actions on CUSTOM
    # packages and detects cycles in them. Legacy ntnx-escape-game BP
    # uses type=DEB with the same install_runbook structure and
    # imports cleanly across HPoC instances. calm-dsl 4.3.1 only emits
    # CUSTOM (validate_package_dict whitelists [SUBSTRATE_IMAGE,
    # CUSTOM, K8S_IMAGE]) so we flip it post-compile to match legacy.
    for pkg in res.get("package_definition_list", []):
        if pkg.get("type") != "CUSTOM":
            continue  # SUBSTRATE_IMAGE etc. don't need this scrub
        opts = pkg.setdefault("options", {})
        opts.setdefault("type", "")
        opts.setdefault("upgrade_runbook", {})
        pkg.setdefault("action_list", [])
        pkg["type"] = "DEB"

    # 4. Per-task field shape that 7.5 expects but calm-dsl 4.3.1 omits:
    #   - retries / timeout_secs: legacy uses "0" strings, dsl emits "".
    #   - DAG attrs.type: legacy has "" (empty string), dsl omits it.
    #   - Edge type+edge_type: legacy tags every edge with type="" and
    #     edge_type="user_defined"; dsl emits only from/to refs.
    # Combined symptom: "Found cycles in tasks" on every auto-scaffolded
    # Create/Delete/SoftDelete action across Package/Profile/Deployment.
    # Calm 7.5 treats edges without edge_type as system-generated and
    # bolts on lifecycle wiring (Service.create → Package.install →
    # Service.start → Service.create) that closes a cycle. Tagging
    # everything explicitly as authored shuts that auto-wiring off.
    # Walk the whole JSON since DAG tasks live in multiple places
    # (package install/uninstall, service action_list, profile
    # action_list, deployment action_list).
    def fix_task(t):
        if t.get("retries") in ("", None):
            t["retries"] = "0"
        if t.get("timeout_secs") in ("", None):
            t["timeout_secs"] = "0"
        ttype = t.get("type")
        if ttype == "DAG":
            attrs = t.setdefault("attrs", {})
            attrs.setdefault("type", "")
            for e in attrs.get("edges", []) or []:
                e.setdefault("type", "")
                e.setdefault("edge_type", "user_defined")
        elif ttype == "EXEC":
            # Legacy ntnx-escape-game BP carries these on every EXEC.
            # Symptom when missing: "Linux os cannot have script type
            # as powershell" on Add AD users (validator falls back to
            # checking target OS instead of honoring inherit_target=False
            # + exec_target_reference=AD when it can't determine task
            # context — the missing type/command_line_args/exit_status
            # are how legacy declares the task as user-authored).
            attrs = t.setdefault("attrs", {})
            attrs.setdefault("type", "")
            attrs.setdefault("command_line_args", "")
            attrs.setdefault("exit_status", [])
        elif ttype == "SET_VARIABLE":
            attrs = t.setdefault("attrs", {})
            attrs.setdefault("type", "")
            attrs.setdefault("exit_status", [])
            attrs.setdefault("eval_scope", "local")

    def walk_tasks(o):
        if isinstance(o, dict):
            if o.get("type") in ("DAG", "EXEC", "SET_VARIABLE", "DELAY", "DECISION"):
                fix_task(o)
            for v in o.values():
                walk_tasks(v)
        elif isinstance(o, list):
            for x in o:
                walk_tasks(x)
    walk_tasks(bp)

    return bp


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: postprocess_bp.py <blueprint.json>", file=sys.stderr)
        return 2
    path = argv[1]
    with open(path) as f:
        bp = json.load(f)
    bp = scrub(bp)
    with open(path, "w") as f:
        json.dump(bp, f, indent=2)
    print(f"[ok] post-processed {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
