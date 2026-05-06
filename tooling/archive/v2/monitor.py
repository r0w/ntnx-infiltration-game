#!/usr/bin/env python3
"""Tail the install runbook for a Calm app: recursively walks runlogs from
the latest top-level action_runlog and emits one line per task transition.

Usage:  python3 monitor.py <app_uuid>
"""
from __future__ import annotations

import os
import sys
import time

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

PC = os.environ.get("PC_ENDPOINT", "https://<pc-ip>:9440").rstrip("/")
AUTH = (
    os.environ.get("PC_USER", "admin"),
    os.environ.get("PC_PASSWORD", ""),
)

S = requests.Session()
S.auth = AUTH
S.verify = False
S.headers.update({"Content-Type": "application/json", "Accept": "application/json"})


def api(method: str, path: str, **kw):
    return S.request(method, PC + path, timeout=60, **kw)


def list_runlogs(app_uuid: str) -> list[dict]:
    r = api(
        "POST",
        f"/api/nutanix/v3/apps/{app_uuid}/app_runlogs/list",
        json={"length": 200, "offset": 0},
    )
    return r.json().get("entities", []) if r.ok else []


def find_root(rls: list[dict]) -> dict | None:
    """Pick the latest action_runlog (action_create or any user action) that's
    either RUNNING or just finished. Calm sorts results newest-first."""
    for e in rls:
        s = e.get("status", {})
        if s.get("type") != "action_runlog":
            continue
        action = (s.get("action_reference") or {}).get("name", "")
        # action_create is the install runbook; named actions are day-2
        if action == "action_create" or action.startswith("Update") or action == "VerifyState":
            return e
    return None


def walk(parent_uuid: str, rls: list[dict], by_parent: dict[str, list[dict]]):
    for child in by_parent.get(parent_uuid, []):
        yield child
        yield from walk(child["metadata"]["uuid"], rls, by_parent)


BADGES = {
    "WAITING": "⏳",
    "PENDING": "⏳",
    "POLICY_EXEC_PENDING": "⏳",
    "RUNNING": "▶ ",
    "SUCCESS": "✓ ",
    "FAILURE": "✗ ",
    "ERROR": "✗ ",
    "ABORTED": "⊘ ",
    "SKIPPED": "↷ ",
}


def label(rl: dict) -> str:
    s = rl["status"]
    n = (s.get("task_reference") or {}).get("name") or (
        s.get("action_reference") or {}
    ).get("name") or s.get("type", "?")
    return n


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: monitor.py <app_uuid>")
    app_uuid = sys.argv[1]
    seen: dict[str, str] = {}
    deadline = time.time() + 60 * 60  # 60 min

    root_uuid: str | None = None
    final_states = {"SUCCESS", "FAILURE", "ERROR", "ABORTED"}

    while time.time() < deadline:
        rls = list_runlogs(app_uuid)
        if not rls:
            time.sleep(10)
            continue

        if root_uuid is None:
            root = find_root(rls)
            if root is None:
                time.sleep(10)
                continue
            root_uuid = root["metadata"]["uuid"]
            r_action = (root["status"].get("action_reference") or {}).get("name")
            print(f"[root] action={r_action} uuid={root_uuid}")

        # Build parent → children map
        by_parent: dict[str, list[dict]] = {}
        root_obj = None
        for e in rls:
            p = (e["status"].get("parent_reference") or {}).get("uuid")
            if p:
                by_parent.setdefault(p, []).append(e)
            if e["metadata"]["uuid"] == root_uuid:
                root_obj = e

        # Walk descendants of our root and emit transitions
        for rl in walk(root_uuid, rls, by_parent):
            s = rl["status"]
            tname = label(rl)
            if tname in {"-", "?"} or s.get("type") == "runbook_runlog":
                continue
            tstate = s.get("state", "")
            key = rl["metadata"]["uuid"]
            if seen.get(key) == tstate:
                continue
            seen[key] = tstate
            badge = BADGES.get(tstate, "? ")
            print(f"  {badge} {tname:<40} {tstate}", flush=True)

        root_state = (root_obj or {}).get("status", {}).get("state", "")
        if root_state in final_states:
            print(f"[root] done: {root_state}")
            return 0 if root_state == "SUCCESS" else 1

        time.sleep(15)

    print("[timeout]")
    return 2


if __name__ == "__main__":
    sys.exit(main())
