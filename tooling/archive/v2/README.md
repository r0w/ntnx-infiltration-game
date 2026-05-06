# Blueprint v2 — direct JSON, no calm-dsl *(ARCHIVE — superseded by v4 at v0.2.0)*

> **Status: archive.** v2 shipped through v0.1.15. From v0.2.0 onwards,
> [`../blueprint/`](../blueprint/README.md) is the active BP — calm-dsl
> native + post-compile patcher. Kept here as quick rollback target if v4
> breaks: swap the `compile-blueprint` job in `.github/workflows/release.yml`
> back to `python3 tooling/archive/v2/build_blueprint.py`.
>
> The patcher in `build_blueprint.py:_patch_for_calm_escript()` is still
> load-bearing — v4's `patch_escript.py` imports it via `importlib`. Don't
> delete this file without porting the patcher into v4 first.
>
> Validated zero-touch on HPoC 2026-04-29 (cf. memory
> `project_bp_v2_zero_touch.md`). For the overview of all blueprint
> generations and the rationale, see [`../README.md`](../README.md).

After 10+ rounds of post-process scrubs against PC 7.5's stricter
schema (see `tooling/blueprint/postprocess_bp.py` and TASKS.md
2026-04-27 + 2026-04-28), calm-dsl 4.3.1 emit format is
empirically incompatible with PC 7.5 — even legacy BPs that
import clean from raw JSON get rejected after a calm-dsl
round-trip. So we drop calm-dsl entirely and assemble the JSON
ourselves.

## Approach

`build_blueprint.py` reads `manifest.py` (declarative spec) +
`scripts/*` (the v3 install scripts, copied from
`tooling/blueprint/scripts/`) + `prereqs/*.tgz` (base64-inlined
into `upload_prereq_bps.py`) and emits `blueprint.json` directly.
The output shape is copied structurally from the legacy
`~/repos/ntnx-escape-game/materials/EG-Blueprint-Installation.json`
which imports clean across all PCs we've tested:

- Service Game with `action_create` / `action_start` populated
  (real content, not no-op markers) + 4 empty system actions
- Package CUSTOM with `options.install_runbook` (sequential
  install, no parallel block — re-introduce later if needed)
- Substrate AHV VM with `provider_spec` + `cloud_init`
- Deployment + Profile with day-2 `UpdateGame` + `VerifyState`
- Hex DAG names like `4c64493b_dag` (matches legacy idiom)
- All `attrs.type=""`, edge `edge_type="user_defined"`,
  `retries="0"` / `timeout_secs="0"` populated

Zero external dependencies. Pure stdlib Python.

## Files

- `manifest.py` — single source of truth for runtime vars,
  credentials, install task ordering, day-2 actions, substrate
  shape. Edit this to change anything about the BP.
- `build_blueprint.py` — assembler. Reads manifest + scripts
  + prereqs, emits `blueprint.json`. Run with `python3
  build_blueprint.py`.
- `scripts/` — copies of the v3 install scripts. Symlinked to
  `../blueprint/scripts/` so edits propagate.
- `prereqs/` — `CloneProd.tgz` + `NewblankVM.tgz`,
  base64-inlined into the `upload_prereq_bps.py` install task
  via the same trick as v1 (`inject_prereq_tgz.py`).

## Build

```bash
cd tooling/archive/v2
python3 build_blueprint.py
# → blueprint.json (~150 KB)
```

No venv, no calm-dsl, no `make compile`, no scrub.

## Sandbox patcher — `_patch_for_calm_escript()`

Calm 7.5's escript runtime sandboxes Python aggressively: `sys`, `urllib3`,
`time`, `json`, `io` (and probably `tarfile`, `tempfile`, `os`, `shutil`)
are banned by the import gate. The patcher in `build_blueprint.py` rewrites
script source at build time to side-step these bans. Catalogued in detail
in memory `project_calm_escript_sandbox.md`. Highlights:

- Strips banned imports (`sys`, `urllib3`, `time`, `json`).
- Rewrites callsites: `sys.exit(N)` → `_calm_exit(N)`,
  `time.sleep(N)` → `_sleep_secs(N)` (TCP-based block via RFC 5737),
  `time.time()` → `_fake_time()`, `data=json.dumps(X)` → `json=X`.
- Prepends helpers: `_calm_exit`, `_req_id` (UUID for `NTNX-Request-Id`),
  `_req_headers`, `_fake_time` counter, `_sleep_secs`.
- Rewrites `headers=HEADERS` → `headers=_req_headers(HEADERS)` so every
  v4 mutation carries a valid request-id (PC 7.5 rejects opaque tokens —
  must be RFC 4122 UUID).
- Gated to `.py` / `.py3` / `.template` files; never touches `.sh` / `.ps1`.

## Launch flow — `launch.py` + `monitor.py`

`tooling/archive/v2/launch.py` is the headless launch path. It does
import_json → activate (PUT cred + secret vars) → simple_launch with
runtime_editables filled (cluster + subnet from project's whitelist, all
secrets). `monitor.py` walks the parent_reference tree from the
`action_create` root to log task transitions live as they fire. Both can
be re-run idempotently — `import_json` 409s if the BP already exists, in
which case launch.py just GETs the existing extId and proceeds.

```bash
cd tooling/archive/v2
python3 launch.py                   # uses .env in repo root for PC creds
python3 monitor.py <app_uuid>       # streams task status
```

## Cycle root cause — Profile vars + `@@{X}@@`

A SET_VARIABLE that reads `@@{Game.X}@@` AND writes a Service var via
`eval_variables` creates a bidirectional Service↔Package edge that PC 7.5's
lifecycle planner interprets as a back-edge → `Found cycles in tasks` on
import. Fix (commit `cb15941`): all runtime vars live on the **Profile**,
scripts use bare `@@{X}@@` (no `Game.` prefix). Don't reintroduce
`Service.variables` for runtime values without verifying the cycle stays
absent — bisection methodology in `../archive/blueprint-v3-tmp/PROGRESS.md`.
