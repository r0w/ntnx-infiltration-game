# Blueprint - calm-dsl source + post-compile patcher

The single shipping blueprint, self-contained in this directory.
Authored in calm-dsl 4.2.1 (`blueprint.py`); a 6-pass post-compile
patcher (`patch_escript.py`) adapts the JSON to PC 7.5's quirks.

For the operator-facing "host the game in 2 clicks" guide, see
[`../../OPERATOR.md`](../../OPERATOR.md). For the overview of all
generations (this active dir + 3 archives), see
[`../README.md`](../README.md). For the historical phase notes
that produced this code, see [`docs/`](./docs/).

## What's in here

| File / dir | Role |
|---|---|
| `blueprint.py`     | Calm DSL source - Service / Substrate / Package + 15-task install runbook + 2 day-2 actions. Edit this to change the BP. |
| `patch_escript.py` | Post-compile passes on the JSON: rewrites banned-import escripts (sandbox), retypes service-bearing CUSTOM packages → DEB, grows boot disk to 40 GiB, strips `metadata.owner_reference` + `metadata.project_reference` (UI-import portable across PCs), normalizes secrets to canonical no-secret shape. Always run via `compile.sh`. |
| `compile.sh`       | One-liner build: bootstraps `.venv` if missing, regenerates `scripts/push_prereq_bps.sh` (template + base64 .tgz blobs), `calm compile bp`, optional patcher (`PATCH=1`). |
| `monitor.py`       | Tail the install runbook of a launched app - prints task transitions until `done: SUCCESS|FAILURE`. |
| `seed_ci_cache.py` | Pre-seeds `~/.calm/dsl.db` with stub project/cluster/subnet refs so CI can `calm compile bp` offline. |
| `scripts/`         | Install-task source files (escripts + sh). All the tasks the install runbook fires. |
| `prereqs/`         | `CloneProd.tgz` + `NewblankVM.tgz` - the two prereq BPs uploaded by the runbook to the player's PC. Base64-inlined into `push_prereq_bps.sh` at compile time. |
| `specs/`           | `cloud_init_data.yaml` + `VM_create_spec_editables.yaml` consumed by `blueprint.py`. |
| `docs/`            | Historical phase notes. Not load-bearing for operation. |

The Calm Runbook the operator uploads + runs once per fresh PC to create the
`AD` endpoint lives next door at [`../runbook_prerequisites.json`](../runbook_prerequisites.json) - sibling to this directory because it's a different
Calm artifact type (Runbook, not Blueprint), even though both ship in the
same GitHub Release (as `nig-00-runbook-prerequisites.json` + `nig-01-blueprint.json`).

## Build

```bash
PATCH=1 ./compile.sh blueprint.py     # → blueprint.json + blueprint.patched.json
```

The first run bootstraps `.venv` (calm-dsl 4.2.1) if missing. Re-runs
are fast.

## Launch (headless)

The headless launcher (import + activate + simple_launch over the Calm
API) is maintainer tooling and lives in the private docs repo
(`ntnx-infiltration-game-docs/tooling/deploy/`), driven by the
`deploy-game` skill. It consumes the `blueprint.patched.json` compiled
here. External operators use the Prism UI path below.

## Launch (Prism UI)

Download `nig-00-runbook-prerequisites.json` + `nig-01-blueprint.json`
from the [latest GitHub Release](https://github.com/r0w/ntnx-infiltration-game/releases/latest).
See [`../../OPERATOR.md`](../../OPERATOR.md) for the operator
walk-through.

## Why a patcher

calm-dsl 4.2.1 emits JSON that PC 7.5 mostly accepts - but a few
structural choices need correcting before the BP imports clean and
launches without `Found cycles in tasks`:

1. **Sandbox banned imports** in escripts (`sys`, `urllib3`, `time`,
   `json`) get rewritten + helpers injected so scripts run inside
   PC's escript sandbox.
2. **CUSTOM → DEB** on service-bearing packages - calm-dsl emits
   CUSTOM, PC 7.5 auto-synthesizes lifecycle actions on those that
   close back-edges, DEB skips the synthesis (matches the legacy BP
   shape).
3. **Boot disk size 0 → 40 GiB** - `cloneFromVMDiskPackage()` emits
   0 (use image native size); cloudimg's ~10 GiB is too small for
   Docker install + game image pull.
4. **Strip `metadata.owner_reference`** - calm-dsl bakes the seed
   user's UUID; PC 7.5 rejects "owner uuid mismatch" at upload on a
   different PC.
5. **Strip `metadata.project_reference`** - calm-dsl bakes the seed
   project's UUID; on UI upload, PC silently auto-binds to the system
   `_internal` project (zero accounts/envs/subnets) and the Launch
   button crashes. Stripping forces the upload form to show a project
   picker.
6. **Normalize secrets** - `pop value` + `attrs={is_secret_modified:
   False, secret_reference: None}`, exactly what calm-dsl's own
   `strip_credentials` produces. Without this PC's import asks for a
   passphrase and fails on plaintext defaults.

The first pass is sandbox compatibility; passes 2-6 are needed for the
shipped JSON to be UI-uploadable on any PC 7.5, not just the cluster
that compiled it.

## Cycle fix shape

Vars on `Profile`, scripts use bare `@@{X}@@` (not `@@{Game.X}@@`).
Reading + writing a Service-scoped var via SET_VARIABLE +
`eval_variables` creates a Service↔Package back-edge that PC's
lifecycle planner reads as a cycle. Profile-scoped state sidesteps it.
Diagnosed in `../archive/blueprint-v3-tmp/PROGRESS.md`.

## CI pipeline

`.github/workflows/release.yml` on `git push --tags v*` does:

1. Build + push the Docker image to `ghcr.io/<owner>/<repo>:v*` + `:latest`.
2. Compile + patch the BP offline (stub `dsl.db` via `seed_ci_cache.py`).
3. Publish a GitHub Release with `nig-00-runbook-prerequisites.json`
   + `nig-01-blueprint.json` as assets.

Operators consume the release; the source repo is for development.
