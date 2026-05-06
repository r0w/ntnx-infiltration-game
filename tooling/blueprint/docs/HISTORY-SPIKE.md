# v4 spike - journal

Outcome: **all 4 phases of [`PLAN.md`](./PLAN.md) green; v4 ships from
v0.2.0 onwards.** This file is the lessons-learned + per-phase live
results. For the artifact-facing operator doc see
[`README.md`](./README.md). For the tree of generations see
[`../BLUEPRINTS.md`](../BLUEPRINTS.md).

## Phase 1 - viability gate (offline + 1 PC visit)

Question: does calm-dsl 4.3.1 from-scratch emit JSON PC 7.5 accepts,
*including* the v2 cycle-fix shape (Profile vars + SET_VAR
target=Service)?

Two spike BPs, both still in this dir as historical reference:

- **`hello_world.py`** - minimum-viable: 1 Service + 1 EXEC + 1
  Profile + 2 vars. Compiled to 491 lines JSON, imported clean as
  DRAFT on PC 7.5 with only minimal-substrate validation errors (no
  cred / no disk / no image - irrelevant to the question).
- **`cycle_check.py`** - the real test: SET_VARIABLE escript reads
  `@@{INPUT}@@` (Profile var) and writes `COMPUTED` (Profile var).
  Compiled to 527 lines, imported clean as DRAFT on PC 7.5 with
  **zero** `Found cycles in tasks`. The "Eval variable not defined
  on the Service" warning is the cosmetic non-blocking signal v2
  documents (commit `5d65f95`) - it's the price of the cycle-fix
  shape, not an actual cycle.

**Verdict: green.** The v1 scrub treadmill was driven by **decompile
round-trip drift**, not compile output. Calm-dsl from-scratch is
viable; the cycle fix is expressible natively.

## Phase 2 - port v2.manifest → blueprint.py (1 day live, 9 launches)

Authored `blueprint.py` natively in calm-dsl, mapping v2's
`build_blueprint.py` 1:1: same Service / Substrate / Package /
Profile / 23 vars / 2 day-2 actions / install task list.

### What the patcher absorbs

calm-dsl emits a structurally-correct BP, but PC 7.5 + the deployed
AHV need 3 fixes that go in `patch_escript.py`:

1. **Sandbox quirks** - Calm 7.5 escript runtime bans `sys`,
   `urllib3`, `time`, `json`, `io`. We import v2's
   `_patch_for_calm_escript()` and apply it to every escript task's
   `attrs.script` (banned-import rewrites + helper-block injection
   for `_calm_exit` / `_sleep_secs` / `_req_id` / etc.).
2. **CUSTOM → DEB on service-bearing packages** - calm-dsl emits
   `Package(type=CUSTOM)` by default; PC 7.5 auto-synthesizes
   lifecycle actions on that shape and closes 9 back-edges that
   block launch. v2 hand-authored DEB. We retype post-compile.
3. **Boot disk size** - `cloneFromVMDiskPackage()` emits
   `disk_size_mib: 0` (image-native ~10 GB on jammy cloudimg). Docker
   install + game image pull needs more - `dpkg` failed with
   `disk full` mid-`docker-ce` install on the first launch. v2
   hand-authored 40960. We grow to 40 GiB post-compile.

### Tasks added incrementally + the gotchas that surfaced

Live on DM3-POC037, one launch per increment. Each task added went
SUCCESS first try, except where noted:

- Cloud-init mismatch: v1's `users: [{name: nutanix, …}]` block
  doesn't match Calm's substrate readiness probe (which SSHes in as
  the cred username). v2's inline shape - `password:
  @@{NUTANIX.secret}@@` for the default `ubuntu` user - works.
  Replaced `specs/cloud_init_data.yaml` accordingly + cred username
  flipped from `nutanix` to `ubuntu`.
- Disk full during Install Docker: hit the boot-disk patch above.
- Activate policy engine stuck at :4202 polling: known unstable on
  this AHV build - Calm's Policy VM image (`4.3.1-CalmPolicyVM.qcow2`)
  doesn't deploy reliably. Memory: `project_calm_policy_vm_unstable`.
  Operator workaround: reset via Prism UI Settings → Calm.
- Upload prereq BPs (v1 escript path): `/import_file` rejects raw
  .tgz. v1's claim it worked was empirically false. v2's working
  pattern: sh on the deployed VM (no escript sandbox) +
  `ntnx/calm-dsl:latest` docker container running `calm create bp`.
  Ported as `Push prereq BPs` task in v4.

## Phase 3 - wire CI

`.github/workflows/release.yml` `compile-blueprint` job: setup Python
3.9 → `pip install ntnx-ncm-dsl==4.3.1` → `calm init dsl` →
`seed_ci_cache.py` → `calm compile bp` → `patch_escript.py`. Output
is uploaded to the GitHub release as `nig-01-blueprint.json`.

v2's job stays in `tooling/blueprint-v2/` as quick rollback target;
its `_patch_for_calm_escript()` is still the single source of truth
for sandbox rewrites.

## Phase 4 - ship

Tagged `v0.2.0` on 2026-05-01 (initial v4 ship, 12 install tasks)
then `v0.2.1` (re-added Push prereq BPs + Clone fake BPs after
porting v2's sh+docker pattern).

`tooling/blueprint-v2/README.md` flipped to ARCHIVE banner;
`BLUEPRINTS.md` overview updated.

## What's still imperfect (known + accepted)

- **Activate policy engine** depends on Calm Policy VM being healthy.
  When the VM image is broken on the cluster's AHV build, the script
  polls 30 min × 2 retries before failing. Same risk as v2 always
  had. Operator can reset via Prism UI Settings → Calm.
- **calm-dsl 4.3.1** is pinned. Newer versions might emit a different
  shape; need re-validation if upgraded.
- **`_patch_for_calm_escript()`** lives in `../blueprint-v2/` and is
  imported via `importlib`. Cross-dir dependency. Vendoring into v4
  would simplify but means maintaining two copies.
- **Symlinks** (`scripts/`, `prereqs/`, `.local/`) work on Linux/
  macOS but not Windows checkouts.

## Don't reopen

- v1's escript-with-`/import_file` path for prereq BPs - empirically
  rejected by Calm.
- `calm-dsl` decompile round-trip - drives the v1 scrub treadmill.
- DAG hex-renaming as a cycle fix - not the cause; the fix is
  Profile-scoped vars.
- DEB vs CUSTOM package type as a meaningful choice - both work
  hand-authored, calm-dsl forces CUSTOM, we patch.
