# Tooling - Calm artifacts

The `tooling/` directory holds the two Calm artifacts the operator
uploads to Prism Self-Service to deploy the game on a fresh PC, plus
historical archives of earlier blueprint generations.

## What's here

```
tooling/
├── README.md                              ← you are here
├── runbook_prerequisites.json             ← Calm Runbook (one-off per PC)
├── blueprint/                             ← Calm Blueprint source + tooling
│   ├── blueprint.py                       (calm-dsl)
│   ├── patch_escript.py                   (post-compile passes)
│   ├── compile.sh / launch.py / monitor.py
│   ├── scripts/ prereqs/ specs/
│   ├── tests/                             (pytest)
│   └── docs/                              (historical phase notes)
└── archive/
    ├── v1/                                (calm-dsl decompile, archived)
    ├── v2/                                (direct JSON assembler, archived)
    └── blueprint-v3-tmp/                  (cycle bisection spike, archived)
```

Two release assets ship together - operator uploads both, in this
order, on every fresh PC:

| Asset | Source | Where to upload | Why |
|---|---|---|---|
| `nig-00-runbook-prerequisites.json` | [`runbook_prerequisites.json`](./runbook_prerequisites.json) | Self-Service > **Runbooks** | Creates the `AD` Calm endpoint the blueprint's `Add AD users` task uses. One-off per fresh PC. |
| `nig-01-blueprint.json` | [`blueprint/blueprint.py`](./blueprint/blueprint.py) → patched | Self-Service > **Blueprints** | The game itself: provisions the VM, deploys the Docker container, sets up the production world (project, prod VMs, prereq BPs). Once per game session. |

The runbook lives at the top level of `tooling/` because it's a
different Calm artifact type (Runbook, not Blueprint) - separate
upload form in Prism. It's tiny (one task: create the AD endpoint),
self-contained, no calm-dsl source.

For the operator-facing walkthrough see [`../OPERATOR.md`](../OPERATOR.md).
For the blueprint internals see [`blueprint/README.md`](./blueprint/README.md).

## Blueprint generations

| Dir                            | Role                              | Status                      |
|--------------------------------|-----------------------------------|-----------------------------|
| `blueprint/`                   | Active - calm-dsl + post-compile patcher | **Active (v0.3.0+)** |
| `archive/v1/`                  | v1 - calm-dsl + decompile legacy  | Archive                     |
| `archive/v2/`                  | v2 - direct JSON assembler        | Archive (shipped through v0.1.15) |
| `archive/blueprint-v3-tmp/`    | v3-tmp - cycle bisection spike    | Archive (root cause shipped in v2/v4) |

### Why so many

Quick chronology:

1. **v1 (calm-dsl + decompile)** - first cut. Decompile the legacy 3225-line
   JSON via calm-dsl's `decompile_bp_from_file()`, edit, recompile. PC 7.5
   rejected the recompiled output even though the original imported clean.
   Accumulated 10+ post-process scrubs in `postprocess_bp.py` chasing a
   moving target. Shelved.
2. **v2 (direct JSON)** - drop calm-dsl entirely. Read a Python `manifest.py`,
   glue scripts + prereq tgz, emit `blueprint.json` structurally copied
   from the known-working legacy `EG-Blueprint-Installation.json`. Zero
   dependencies, pure stdlib. First version to deploy live successfully.
3. **v3-tmp** - diagnostic spike when v2 hit `Found cycles in tasks` on
   import. Found the root cause: a SET_VAR that reads `@@{Game.X}@@`
   *and* writes a Service var via `eval_variables` creates a bidirectional
   Service↔Package edge interpreted as a back-edge by PC's lifecycle
   planner. Fix: vars on `Profile`, scripts use bare `@@{X}@@`. Ported back
   into v2.
4. **v4 (calm-dsl revival, shipped at v0.2.0)** - with the cycle fix
   understood and the escript sandbox patcher proven, retried calm-dsl as
   just a compiler. Authored `blueprint.py` natively in calm-dsl, moved
   the sandbox patcher to a post-compile pass (`patch_escript.py`) that
   also retypes CUSTOM→DEB and grows the boot disk. Validated end-to-end.
5. **Active (v0.3.0+)** - at v0.3.0 v4 was promoted to `tooling/blueprint/`,
   v1 + v2 moved to `archive/`. v4 inlined the imports it had from v2
   (`_patch_for_calm_escript`, `launch.py`, `push_prereq_bps.sh.template`)
   and copied the install scripts/prereqs/specs from v1. Single
   self-contained shipping directory; archives kept as historical reference.

## How to choose when iterating

- **Change the live BP** → edit `blueprint/blueprint.py` or scripts under
  `blueprint/scripts/`, `PATCH=1 ./compile.sh blueprint.py`, commit, tag.
  CI's `release.yml` pipeline ships the patched JSON as a release asset.
- **Test a launch before tagging** → `./.venv/bin/python launch.py` with PC
  creds in env (`PC_ENDPOINT`, `PC_USER`, `PC_PASSWORD`). Add
  `GHCR_TOKEN=<token>` only if testing against a private container image.
- **Understand a launch failure** → `blueprint/docs/HISTORY-SPIKE.md`
  (per-phase validated states + each task's role) and the `__install__`
  body of `blueprint/blueprint.py`. Cycle errors specifically →
  `archive/blueprint-v3-tmp/PROGRESS.md`.
- **Curious about the legacy game install** → `archive/v1/blueprint_legacy.py`
  + the `_legacy.json` artifact + `scripts_legacy/`.
- **Roll back to v2** → swap the `compile-blueprint` job in `release.yml`
  back to `python3 tooling/archive/v2/build_blueprint.py` + change the
  artifact path. The v2 source is preserved at `tooling/archive/v2/`.

## Why a runbook + a blueprint

Calm has two artifact types and they serve different scopes:

- **Runbook** - a one-shot sequence of tasks executed by the Calm
  runner. No app instance, no day-2 actions, no install/uninstall.
  Perfect for cluster-level setup like creating an endpoint.
- **Blueprint** - defines an *application* with services, substrates,
  packages, install/uninstall lifecycle, day-2 actions. What the game
  itself is.

The runbook creates the `AD` Calm endpoint (pointing at the lab Active
Directory) so the blueprint's `Add AD users` install task can resolve
`use_existing("AD")` at runtime. We could have rolled the endpoint
creation into the blueprint, but Calm rejects nested endpoint creation
inside blueprint install tasks - runbook is the only sanctioned path.
