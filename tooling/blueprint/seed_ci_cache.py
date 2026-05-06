"""
Pre-seed ~/.calm/dsl.db with stub entries so `calm compile bp` resolves
the entity references in blueprint.py without a live PC connection.

Used by the CI release workflow to compile blueprint.json without
exposing HPoC credentials to GH Actions runners. The resulting JSON has
stub UUIDs in the substrate's cluster/subnet/project references — but
those fields are marked `editable: true` in VM_create_spec_editables.yaml
and the operator picks the real entities at launch time via the Prism
Central UI.

What it seeds:
  - versiontable      : Calm + PC version stamps (calm-dsl boots OK)
  - projectcache      : `production` project (BP's project_reference)
  - accountcache      : NTNX_LOCAL_AZ nutanix_pc account
  - ahvclusterscache  : stub cluster matching the BP's `cluster=` default
  - ahvsubnetscache   : stub subnet matching the BP's NIC default
  - directoryservicecache : stub for `Endpoint.use_existing("AD")`

Usage:
    .venv/bin/calm init dsl --ip 127.0.0.1 -P 9440 -u admin -p stub -pj production
    .venv/bin/python seed_ci_cache.py
    .venv/bin/calm compile bp -f blueprint.py --out json > blueprint.json
"""

from __future__ import annotations
import datetime as _dt
import os
import pathlib
import sqlite3
import sys
import uuid

CACHE_DB = pathlib.Path.home() / ".calm" / "dsl.db"
NOW = _dt.datetime.utcnow().isoformat(sep=" ")

# Stub UUIDs — chosen to be obviously fake so anyone reading the resulting
# blueprint.json sees they're placeholders. Operator must override at launch.
STUB_PROJECT_UUID    = "00000000-0000-0000-0000-000000000001"
STUB_ACCOUNT_UUID    = "00000000-0000-0000-0000-000000000002"  # NTNX_LOCAL_AZ
STUB_PE_ACCOUNT_UUID = "00000000-0000-0000-0000-000000000003"  # the PE account behind the cluster
STUB_CLUSTER_UUID    = "00000000-0000-0000-0000-000000000004"
STUB_SUBNET_UUID     = "00000000-0000-0000-0000-000000000005"
STUB_DIR_SERVICE_UUID = "00000000-0000-0000-0000-000000000006"
STUB_USER_UUID        = "00000000-0000-0000-0000-000000000007"


def upsert(cur: sqlite3.Cursor, table: str, columns: list[str], values: list) -> None:
    placeholders = ", ".join("?" for _ in columns)
    cols = ", ".join(columns)
    cur.execute(f"INSERT OR REPLACE INTO {table} ({cols}) VALUES ({placeholders})", values)


def main() -> int:
    if not CACHE_DB.exists():
        # Bootstrap an empty DB with the full calm-dsl schema. Importing
        # calm.dsl.db.get_db_handle triggers the Database() singleton's
        # constructor, which calls peewee's `create_tables` for every
        # registered model. No PC contact required — schema creation is
        # purely local sqlite. Used in CI so we can skip `calm init dsl`
        # (which would probe the PC for NCM + Calm enablement and fail).
        print(f"[bootstrap] no cache at {CACHE_DB} — creating schema via calm.dsl.db", file=sys.stderr)
        from calm.dsl.db import get_db_handle  # noqa: WPS433 (lazy on purpose)
        get_db_handle()
        if not CACHE_DB.exists():
            print(f"FAIL: schema bootstrap did not create {CACHE_DB}", file=sys.stderr)
            return 1

    db = sqlite3.connect(str(CACHE_DB))
    cur = db.cursor()

    # 1. Calm + PC version stamps. calm-dsl's validate_version() reads these
    # at every command boot. Use 4.3.1 / 7.5.1 to match the real lab versions.
    upsert(cur, "versiontable",
        ["name", "version", "pc_ip", "last_update_time"],
        ["Calm", "4.3.1", "127.0.0.1", NOW])
    upsert(cur, "versiontable",
        ["name", "version", "pc_ip", "last_update_time"],
        ["PC", "ganges-7.5.1-stable-pc", "127.0.0.1", NOW])

    # 2. NTNX_LOCAL_AZ account — referenced by setup_production_project.py
    # at runtime + needed for cluster ↔ account mapping. The Calm compile
    # joins clusters with their PE account via accountcache.
    # NTNX_LOCAL_AZ.data must carry the {clusters: {<pe-uuid>: <cluster-name>}}
    # mapping or substrate.compile() bails with KeyError 'clusters'.
    nutanix_pc_data = '{"clusters": {"%s": "StubPE"}}' % STUB_PE_ACCOUNT_UUID
    pe_account_data = '{"pc_account_uuid": "%s"}' % STUB_ACCOUNT_UUID
    upsert(cur, "accountcache",
        ["name", "uuid", "provider_type", "state", "is_host", "data", "last_update_time"],
        ["NTNX_LOCAL_AZ", STUB_ACCOUNT_UUID, "nutanix_pc", "VERIFIED", 1, nutanix_pc_data, NOW])
    upsert(cur, "accountcache",
        ["name", "uuid", "provider_type", "state", "is_host", "data", "last_update_time"],
        ["StubPE", STUB_PE_ACCOUNT_UUID, "nutanix", "VERIFIED", 0, pe_account_data, NOW])

    # 3. project named `production` — the calm config_handle.project_name
    # default. Without this, create_blueprint_payload bails with
    # "Project default not found".
    accounts_data         = '{"nutanix_pc": ["%s"]}' % STUB_ACCOUNT_UUID
    whitelisted_subnets   = '{"%s": ["%s"]}' % (STUB_ACCOUNT_UUID, STUB_SUBNET_UUID)
    whitelisted_clusters  = '{"%s": ["%s"]}' % (STUB_ACCOUNT_UUID, STUB_CLUSTER_UUID)
    whitelisted_vpcs      = '{"%s": []}' % STUB_ACCOUNT_UUID
    upsert(cur, "projectcache",
        ["name", "uuid", "accounts_data", "whitelisted_subnets", "whitelisted_clusters", "whitelisted_vpcs", "last_update_time"],
        ["production", STUB_PROJECT_UUID, accounts_data,
         whitelisted_subnets, whitelisted_clusters, whitelisted_vpcs, NOW])

    # 4. cluster matching the BP's NIC default (`cluster="default"`).
    # blueprint.py:106 has this as a hardcoded default; operator overrides
    # at launch via the editable substrate spec.
    upsert(cur, "ahvclusterscache",
        ["name", "uuid", "pe_account_uuid", "account_uuid", "last_update_time"],
        ["default", STUB_CLUSTER_UUID, STUB_PE_ACCOUNT_UUID, STUB_ACCOUNT_UUID, NOW])

    # 5. subnet matching the BP's NIC default (`"primary"`).
    upsert(cur, "ahvsubnetscache",
        ["name", "uuid", "account_uuid", "last_update_time", "subnet_type", "cluster_id", "vpc_id"],
        ["primary", STUB_SUBNET_UUID, STUB_ACCOUNT_UUID, NOW, "VLAN", STUB_CLUSTER_UUID, ""])

    # 6. AD directory service — referenced by Endpoint.use_existing("AD").
    # Compile resolves the endpoint to a directory service UUID via this.
    upsert(cur, "directoryservicecache",
        ["name", "uuid", "last_update_time"],
        ["AD", STUB_DIR_SERVICE_UUID, NOW])

    # 7. owner user — calm-dsl's blueprint_payload.create_blueprint_payload
    # auto-fills metadata.owner_reference from config.pc_username via
    # Ref.User(name), which queries userscache. Stub `admin` matching the
    # CI config.ini.
    upsert(cur, "userscache",
        ["name", "uuid", "display_name", "directory", "last_update_time"],
        ["admin", STUB_USER_UUID, "admin", "LOCAL", NOW])

    db.commit()
    db.close()
    print(f"[ok] cache seeded with stubs at {CACHE_DB}")
    return 0


sys.exit(main())
