# Blueprint v1 — calm-dsl decompile / recompile *(ARCHIVE)*

> **Status: archive — not the shipping BP.** The active blueprint is in
> [`../v2/`](../v2/README.md) (direct JSON assembler).
> See [`../README.md`](../README.md) for the overview of all
> generations and why we stopped using calm-dsl. **A v4 revival of
> calm-dsl-as-compiler is planned** — see
> [`../blueprint/PLAN.md`](../blueprint/PLAN.md).
>
> What's kept here:
> - **`blueprint_legacy.py` / `blueprint_legacy.json` / `scripts_legacy/`** —
>   decompile of the legacy `ntnx-escape-game` Python game's BP. Useful as a
>   reference for what the original install runbook did.
> - **`scripts/`** — install scripts (still **referenced** by v2 via symlinks
>   in `../v2/scripts/`, so edits propagate). The scripts themselves
>   are not v1-specific.
> - **`prereqs/`** — `CloneProd.tgz` + `NewblankVM.tgz`, also consumed by v2.
> - **`runbook_prerequisites.json`** — Calm runbook that creates the `AD`
>   endpoint on a fresh PC. Run once per fresh PC, regardless of which
>   blueprint version you launch afterward.
> - **`decompile.py`** — one-shot helper that bypasses calm-dsl's
>   `Version.sync()` to decompile a JSON BP offline. Useful if you ever need
>   to round-trip a third-party BP into Python.
> - **`postprocess_bp.py`** — the v1 scrub treadmill. Dead-end documented in
>   commit `9864683` (archived). Kept for forensics, not as a workflow.
>
> Below is the v1 README as it stood when calm-dsl was the active path. Read
> as historical context, not as a how-to.

---

# Calm DSL blueprints

Two Calm Self-Service blueprints written in Python via [`ntnx-ncm-dsl`](https://github.com/nutanix/calm-dsl) (the renamed `calm.dsl`).

| File                                       | What it is                                       | Notes |
|--------------------------------------------|--------------------------------------------------|---|
| `blueprint.py` / `.json`                   | **Primary blueprint — `ntnx-infiltration-game`** | 17 install tasks, Docker-based. **Auto-uploads** the 2 prereq BPs (CloneProd + BlankVM-source) on launch — no manual upload step. |
| `prereqs/CloneProd.tgz`                    | Source for `CloneProd` BP referenced by stage 35 | Bundled in `blueprint.json` as base64 (see `inject_prereq_tgz.py` + `scripts/upload_prereq_bps.py.template`). **Not a release asset.** |
| `prereqs/NewblankVM.tgz`                   | Source for `BlankVM-source` BP referenced by stage 37 | Same bundling pattern. The `Upload prereq BPs` install task posts both to `/api/nutanix/v3/blueprints/import_file` after sed-substituting the legacy `{X}` placeholders to Calm `@@{X}@@` tokens. |
| `runbook_prerequisites.json`               | Calm runbook — creates the `AD` endpoint on Prism Central | **Required prereq for the v3 blueprint.** Run once per fresh PC. |
| `blueprint_legacy.py` / `.json`            | Archive: legacy `ntnx-escape-game` Python game   | Decompiled from the original 3225-line JSON. Kept for reference, not a release asset. |

The release exposes exactly **2 artifacts**: `nig-00-runbook-prerequisites.json` + `nig-01-blueprint.json`. Same UX as the legacy `ntnx-escape-game` — run the runbook, run the blueprint, c'est bon.

## What it does, in order

On a fresh Ubuntu 24.04 VM provisioned by Calm:

1. **Activate policy engine** — one-shot, idempotent.
2. **Get Cluster** — set `CLUSTERNAME` / `CLUSTERUUID` from the AOS cluster.

Then **two parallel branches** fork from `Get Cluster` (saves ~5 min wall-clock vs sequential):

After `Get Cluster`, the install fans out into **6 parallel branches**. Wall-clock ≈ longest branch (cluster path, ~10 min) instead of the sum.

**Branch 1 — cluster + production world** (~10 min, the bottleneck)
- **Ensure host 4 removed** — idempotent and gated. Skip cleanly if `CLUSTER_PROFILE='other'` (community cluster, never touch hardware) or if no `-4` host present.
- **Wait for cluster health** — polls hosts every 30 s until 3 stable snapshots all `nodeStatus=NORMAL`. Replaces the legacy 15-min flat sleep. Cap 20 min.
- **Setup subnets** — 1:1 port of legacy RenameNetworkifNeeded + Migrate-secondary-to-advanced + CreateSubnetTestNetwork: ensures `secondary` subnet exists + is advanced-networking, creates `TestNetwork` (used by stage 35).
- **Setup production project** — creates the global `production` Calm project + ACP that grants `thebadguy` Project Admin (stage 13 isolation check needs this binding). Sets the `ProjectUUID` Calm variable for downstream tasks.
- **Create Prod VMs** — 7 hardcoded VMs (`prd-ransom-probe-1`, `beta-ransom-engine-v2.2`, `prd-mail`, …) in the `production` project, tagged `Environment=Production`. Stage 13 tells the player to log in as `thebadguy` and look at the VM list — without these, the list is empty and the immersion breaks.
- **Setup jumphost endpoint** — Calm endpoint named `jumphost` pointing at the deployed Game VM (used by CloneProd's day-2 actions, also surfaces a realistic-looking endpoint in Prism).
- **Verify final state** — best-effort convergence check: PC reachable, all hosts NORMAL, free chassis slot. By the time the cluster path finishes (longest in practice), the other branches are usually done too.

**Branch 2 — local IAM users** (~30 s, independent)
- **Create local users** — POST IAM v4 to create the 3 stock approvers (`charlie`, `thom`, `william`) referenced by stage 21 `actCreateApprovalPolicy`.

**Branch 3 — AD users on the AD endpoint** (~30 s, independent)
- **Add AD users** — PowerShell `New-ADUser` against the AD endpoint to create `thebadguy` (stage 13 isolation) + `theprojectmanager` (stage 9 project admin).

**Branch 4 — immersion BPs** (~1 min, skips if CloneProd absent)
- **Clone fake BPs** — 10 fake-named BPs (`ApacheServer`, `PrimaryAD`, `Wordpress`, …) cloned from `CloneProd` so Prism Self-Service shows a realistic catalog.

**Branch 5 — LCM inventory** (~5 s, async on PC)
- **Trigger LCM inventory** — POSTs a fresh inventory scan so stage 29 `lcm-check-updates` finds non-stale update entities.

**Branch 6 — game container deploy** (~3 min, on the Calm-provisioned VM)
- **Install Docker** — `curl get.docker.com` (idempotent).
- **Run game container** — `docker login ghcr.io` + `docker pull` + `docker run -d` with all PC creds and game config injected via `-e`.

> **Why doesn't `Verify final state` sit AFTER the parallel block as a true convergence point?** `calm.dsl 4.3.1` rejects tasks-after-parallel in runbooks (the parallel must be terminal). It lives at the end of Branch 1 instead — the longest branch in practice (cluster_health is the wall-clock bottleneck) so the other branches are usually done by then. The day-2 `VerifyState` action below is the operator-driven full check.

**Branch B — container deploy** (ssh on the deployed VM)
- **Install Docker** — `curl get.docker.com | sh` then enable + start the daemon. Idempotent (skips if already installed).
- **Run game container** — `docker login ghcr.io` (when `GHCR_TOKEN` is set), `docker pull <IMAGE_REPO>:<IMAGE_TAG>`, then `docker run -d` with all PC creds + game config injected via `-e`. Idempotent: stops + removes any prior container before re-running.

### Launch parameters

The operator picks 12 runtime variables in the Prism Central launch UI. Highlights:

- **`IMAGE_REPO` / `IMAGE_TAG`** *(mandatory)* — `ghcr.io/<owner>/ntnx-infiltration-game` and a tag (`latest` or pinned `v0.1.0`). Image is built + pushed by the GitHub Actions release workflow.
- **`GHCR_USERNAME` / `GHCR_TOKEN`** *(optional)* — GitHub credentials for `docker login ghcr.io`. Required while the repo / package is private; clear them once it's public. Default username `x-access-token` works with both classic PATs and fine-grained tokens.
- **`CLUSTER_PROFILE`** *(mandatory, default `other`)* — single switch that controls all destructive actions, both at install (blueprint's node-remove) and during gameplay (game stages 21 `create-approval-policy` + 28 `expand-cluster`).
  - `hpoc` — recognized HPoC reserved for the event. Destructives run.
  - `other` — community / shared / unknown cluster. Destructives are skipped at install AND filtered at gameplay; the rest of the game plays through normally. Default is fail-safe.
- **`PC_IP` / `PC_USERNAME` / `PC_PASSWORD`** — credentials the running game uses to drive the cluster.
- **`ADMIN_PASSWORD`** — game's `/admin` page password (default `nutanix/4u`).
- **`MODE` / `LOG_LEVEL` / `TIMEZONE`** — app config.

Day-2 actions:
- **UpdateGame** — `docker pull` the latest image at `IMAGE_TAG`, stop the running container, re-run with the same env. Use to roll a freshly pushed tag without touching the rest of the install.
- **VerifyState** — full convergence check on demand: PC reachable, all hosts NORMAL, chassis has a free node-slot (scans `rackable_units[].nodes[].position` gaps for 4-node-chassis hardware like NX-3060). Validated live HPoC.

> **Why no single "Verify final state" task in the install runbook?** `calm.dsl 4.3.1` rejects `tasks-after-parallel` in runbooks (the parallel block must be the terminal construct). Each branch's last task does its own end-state validation; the operator-visible Day-2 `VerifyState` action is the single-pass full check.

## Cutting a release

```bash
# 1. Tag and push — that's it. The GitHub Actions release workflow
#    handles compile + image build + asset upload.
git tag v0.1.0
git push origin v0.1.0
```

The `release.yml` workflow:
- Builds + pushes the Docker image to `ghcr.io/<owner>/ntnx-infiltration-game:vX.Y.Z` + `:latest`.
- Runs `inject_prereq_tgz.py` to base64-encode the prereq `.tgz` files into `scripts/upload_prereq_bps.py`.
- Seeds `~/.calm/dsl.db` with stub project/cluster/subnet refs (see `seed_ci_cache.py`) so `calm compile bp` resolves without a live PC.
- Compiles `blueprint.py` → `blueprint.json` (~177 KB; the 22 KB of base64-encoded `.tgz` blobs are inline in the install task's script string).
- Attaches `nig-00-runbook-prerequisites.json` + `nig-01-blueprint.json` to the GitHub Release.

**Operator flow on a fresh PC** — 2 clicks, same UX as the legacy `ntnx-escape-game`:

1. Download `nig-00-runbook-prerequisites.json` → Prism Central → Self-Service → Runbooks → Upload → Run. Creates the `AD` endpoint.
2. Download `nig-01-blueprint.json` → Self-Service → Blueprints → Upload → fill 12 runtime vars (PC creds, `IMAGE_TAG=v0.1.X`, GHCR token while private, `CLUSTER_PROFILE: hpoc|other`, etc.) → Launch.

The blueprint then auto-uploads the prereq `CloneProd` + `BlankVM-source` BPs (decoded from inline base64), creates the local PC users + AD users + production project + ProdVMs + jumphost + fake BPs + triggers an LCM inventory scan, and provisions the game VM with the Docker container.

> **Why bundle the `.tgz` files inline as base64 instead of as separate release assets?** Two reasons: (a) keeps the release artifact list to 2 items so consumers don't have to wonder what to download in which order; (b) avoids GitHub asset auth issues for private repos — the `.tgz` would need a token with `repo` scope to download from `releases/download/...`, but our `GHCR_TOKEN` only carries `read:packages`. The base64 inline path is self-contained and works regardless of repo visibility.

## Setup

```bash
make install                      # creates .venv, pip-installs ntnx-ncm-dsl
.venv/bin/calm init dsl \
    -i <PC_IP> -P 9440 \
    -u admin -p '<password>' \
    -pj production               # any project name that exists on the PC works
```

The `init dsl` step writes `~/.calm/config.ini` and pulls a first cache from the PC. Once that's done, compile is offline-ish (some entity refs still go through the cache but no live API).

## Compile / launch

```bash
make compile                      # blueprint.py → blueprint.json (~22 KB)
make compile-legacy               # blueprint_legacy.py → blueprint_legacy.json

make upload                       # calm create bp on the configured PC
make upload-legacy
```

After upload, launch via Prism Central UI (or `calm launch bp ntnx-infiltration-game --app_name <yours> --launch_params <json>`). The 9 runtime vars (PC creds, GIT_URL, GIT_BRANCH, ADMIN_PASSWORD, MODE, LOG_LEVEL, TIMEZONE) are filled in the launch UI; subnet / cluster / VPC / IPs are picked from the editables.

## Distributing the JSON

`blueprint.json` is the artifact other operators upload via Prism Central UI without needing the Python toolchain. Re-run `make compile` after every `blueprint.py` edit and commit both files together.

## Re-decompile a JSON blueprint

`decompile.py` turns any Calm JSON export back into Python DSL. It bypasses the `calm` CLI's boot-time `Version.sync()` by calling `decompile_bp_from_file()` directly. Used once to bootstrap `blueprint_legacy.py` from the original 3225-line JSON.

Four in-tree edits in `.venv/lib/python3.9/site-packages/calm/dsl/decompile/` make older blueprint schemas palatable to the 4.3.1 decompiler:

- `bp_file_helper.py` — `getattr(profile, "patch_list", []) or []` instead of bare `profile.patch_list` (lines 126 + 182). Older blueprints don't carry patch_configs.
- `ahv_vm.py` — `getattr(cls, "cluster", None)` instead of bare `cls.cluster` (line 20).
- `ahv_vm_nic.py` — falls back to `TODO_SUBNET_<prefix>` placeholder when the subnet UUID is absent from the PC cache (instead of `sys.exit(-1)`).
- `variable.py` — `options.pop("exec_target_reference", None)` (the bare pop crashed on vars without an exec target).

These edits get blown away by `pip install --upgrade ntnx-ncm-dsl`. Re-apply if you upgrade.

## Layout

```
tooling/blueprint/
├── README.md                   ← this file
├── Makefile                    ← compile / upload / clean targets
├── decompile.py                ← one-shot helper to re-decompile a JSON export
│
├── blueprint.py                ← v2: deploys ntnx-infiltration-game
├── blueprint.json              ← compiled artifact (committed for distribution)
├── scripts/                    ← v2 install + day-2 task scripts
├── specs/                      ← v2 cloud-init + VM editables YAML
│
├── blueprint_legacy.py         ← v1 archive: deploys ntnx-escape-game
├── blueprint_legacy.json       ← (compile on demand: `make compile-legacy`)
├── scripts_legacy/             ← v1 install scripts (30+, mostly seed tasks)
├── specs_legacy/               ← v1 specs
│
└── .local/                     ← gitignored — secret placeholders
```

## Open follow-ups

### Needs a live HPoC to validate
The blueprint compiles cleanly and uploads (the upload flow was validated through v0.1.5 against DM3-POC037 before the cluster went away), but a true end-to-end `calm launch bp` run hasn't been executed yet. Items below are best-effort blind ports; the first live run will surface fixes.

- **`Trigger LCM inventory` API path.** `scripts/trigger_lcm_inventory.py` tries 3 v4 paths in order (`/api/lifecycle/v4.0.b1/operations/$actions/perform-inventory`, then `/v4.0/operations/...`, then `/v4.0/resources/...`). One of them should match the running PC version; the others fall through. First live run will tell us which is correct, then we drop the fallbacks.
- **`Create Prod VMs` v4 schema.** `scripts/create_prod_vms.py` uses what the legacy SDK emits as the VMM v4 body shape (`backingInfo.$objectType: "vmm.v4.ahv.config.EmulatedNic"`, etc.). The `$objectType` discriminators sometimes shift between PC versions; if the create returns 4xx with a schema complaint, the body needs alignment with the live schema.
- **`setup_production_project` ACP block.** The 200-line PUT v3 ACP is verbatim from the legacy `create-project.py`. If a PC version rejects it, the project gets created but `thebadguy` won't be Project Admin — stage 13 narrative degrades silently. Operator can re-add via Prism UI.

### "Found cycles in tasks" warnings
Calm validator emits `Found cycles in tasks` on every auto-generated system action (`action_create`, `action_delete`, `action_soft_delete` at Package / Profile / Deployment levels — 9 warnings total). The legacy blueprint emits the same warnings; they do not block upload (BP lands in DRAFT) and historically don't block launch either. We're treating them as benign false positives until proven otherwise. If a launch is rejected because of them, root-cause is to define explicit `__delete__` / `__soft_delete__` actions on each entity so Calm doesn't auto-generate empty-but-cyclic ones.

### True convergence verify (Calm DSL 4.3.1 limitation)
`calm.dsl 4.3.1` rejects tasks-after-parallel in runbooks. So `Verify final state` can't sit as a true convergence point after the 6 parallel branches. Current best-effort: it lives at the end of Branch 1 (the cluster path, longest in practice — cluster_health is the wall-clock bottleneck). The day-2 `VerifyState` action on the Profile is the operator-driven full check. A future calm.dsl version may relax this; for now it's accepted limitation.

### Stage 28 gating
Currently handled via `CLUSTER_PROFILE` switch (set at launch by the operator: `hpoc` runs node-remove + destructive game stages, `other` skips them). What's NOT yet wired: an automatic capability flag derived from `rackable_units > host_count` so the gate flips even on `hpoc` if the chassis happens to be already trimmed. Marginal — the manual `CLUSTER_PROFILE` covers the realistic cases.

### Auto-upload of CloneProd + BlankVM-source *(done 2026-04-27 fin de journée)*
Implemented via the bundle-inline-as-base64 pattern: `tooling/blueprint/inject_prereq_tgz.py` reads the `.tgz` files from `prereqs/`, base64-encodes them, and fills placeholders in `scripts/upload_prereq_bps.py.template` before `calm compile bp`. The resulting BP install task `Upload prereq BPs` decodes the base64 in memory, sed-substitutes the legacy `{X}` placeholders to Calm `@@{X}@@` interpolation tokens (1:1 with `Push BP on Calm.sh`), repacks, and multipart-POSTs to `/api/nutanix/v3/blueprints/import_file`. Idempotent — skips if the BP is already on the PC. The `import_file` multipart contract is reverse-engineered from `calm-dsl`'s `endpoint.import_file()` shape; first live HPoC run will validate.

### Compile blueprint.json in CI *(done 2026-04-27)*
The `release.yml` workflow now compiles `blueprint.json` from `blueprint.py` in CI via the `compile-blueprint` job (between `build-and-push` and `upload-blueprint`). It pre-seeds `~/.calm/dsl.db` with stub entries via `seed_ci_cache.py` (project, account, cluster, subnet, directory_service) so `calm compile bp` resolves without a live PC. Stub UUIDs in the resulting JSON are placeholders — the substrate's editables.yaml marks the relevant fields as runtime-overridable, so the operator picks the real entities at launch via Prism Central UI. **Contributors no longer need `make compile` before tagging.**

### Substrate `__pre_create__` sanity checks
Legacy had two: `Check AD connection` (PowerShell `dir C:\` against AD endpoint) + `Check Capa planing User` (escript ping against the OLD PC). Both fast-fail pre-flight checks. v3 dropped them — failures surface inside the install action proper (`Add AD users` task fails if AD endpoint unreachable, stage 31 fails at runtime if OLD PC is down). Re-adding them as pre_create tasks would shift the failure earlier and save provisioning a doomed VM. Optional UX improvement.
