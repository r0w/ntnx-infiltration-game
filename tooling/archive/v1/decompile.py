"""Offline-friendly decompile of EG-Blueprint-Installation.json into Calm DSL.

Why this script instead of `calm decompile bp -f …`:
- The CLI runs Version.sync() at boot, which hits the PC API even for `--help`.
- Two schema gaps in this blueprint vs the calm-dsl 4.3.1 schema (cred_class
  empty, profile.patch_list missing) are patched here so the decompile can
  actually run.

VPN to the HPoC must be up: the decompile pulls subnet / image / PE-account
metadata from the PC cache, populating it on first use.

Usage:
    .venv/bin/python decompile.py
"""
import os
import sys
from pathlib import Path

VENV = Path(__file__).parent / ".venv"
sys.path.insert(
    0, str(VENV / "lib" / "python3.9" / "site-packages")
)

# ── Patch render_credential_template: blueprint JSON has cred_class="static"
#    but the field is stripped by the CredentialType schema, so the decompile
#    sees an empty string and bails. Default to "static". ──
from calm.dsl.decompile import credential as _cred_mod
from calm.dsl.decompile.render import render_template
from calm.dsl.builtins import CredentialType, get_valid_identifier


def patched_render_cred(cls, context="BP"):
    if not isinstance(cls, CredentialType):
        raise TypeError(f"{cls} is not of type {CredentialType}")
    user_attrs = cls.get_user_attrs()
    user_attrs["description"] = cls.__doc__
    cred_type = user_attrs.get("cred_class") or "static"
    var_name = "{}_CRED_{}".format(context, get_valid_identifier(cls.__name__))
    user_attrs["var_name"] = var_name
    if user_attrs.get("editables", {}):
        user_attrs["editables"] = user_attrs["editables"].get_dict()
    _cred_mod.CRED_VAR_NAME_MAP[user_attrs["name"]] = var_name
    if cred_type == "static":
        file_name = "{}_{}".format(var_name, user_attrs["type"])
        _cred_mod.create_file_from_file_name(file_name)
        user_attrs["value"] = file_name
        text = render_template("basic_credential.py.jinja2", obj=user_attrs)
    elif cred_type == "dynamic":
        for var_obj in user_attrs.get("variable_list", []):
            if var_obj.type == "SECRET":
                file_name = "{}_VAR_{}_SECRET".format(
                    var_name, get_valid_identifier(var_obj.name)
                )
                _cred_mod.create_file_from_file_name(file_name)
                var_obj.value = file_name
        text = render_template("dynamic_credential.py.jinja2", obj=user_attrs)
    else:
        raise TypeError(f"{cred_type} is not a supported cred class")
    return text.strip()


_cred_mod.render_credential_template = patched_render_cred
from calm.dsl.decompile import bp_file_helper as _bp_helper

_bp_helper.render_credential_template = patched_render_cred


# ── Note: bp_file_helper.py and ahv_vm.py are also patched in-tree
#    (see venv/.../calm/dsl/decompile/{bp_file_helper,ahv_vm}.py) for missing
#    profile.patch_list and substrate.cluster attributes. Those edits survive
#    `pip install -e` re-runs but get blown away by `pip install --upgrade`. ──

from calm.dsl.cli.bps import decompile_bp_from_file

decompile_bp_from_file(
    # Path to the legacy ntnx-escape-game BP — set this to wherever you
    # checked out the upstream repo locally.
    filename=os.environ.get(
        "LEGACY_BP_JSON",
        str(Path(__file__).parent / "EG-Blueprint-Installation.json"),
    ),
    bp_dir=str(Path(__file__).parent / "decompiled"),
    no_format=True,
)
