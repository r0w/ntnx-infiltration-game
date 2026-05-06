# Blueprint v4 - calm-dsl revival *(SHIPPED, zero-touch since v0.2.30)*

> **Status: shipped 2026-05-01, fully zero-touch since 2026-05-03 (v0.2.30).**
> All phases green. v4 is the active BP since v0.2.0; UI-uploadable
> since v0.2.17 (10 stub-trap strips); cloud-init bootstraps the
> Calm `python_remote` venv since v0.2.30 so stage 35 / CloneProd's
> `Clone the Environment` task runs without manual intervention.
> 15-task install runbook, 2 day-2 actions, full feature parity with v2.
> For per-phase live results + lessons learned, see [`SPIKE.md`](./SPIKE.md).
> For operator-facing build/launch/ship doc, see [`README.md`](./README.md).
> For the overview of all blueprint generations, see
> [`../BLUEPRINTS.md`](../BLUEPRINTS.md).

## Goal

Re-author the blueprint in calm-dsl Python so it aligns with Nutanix's
official tooling and standards, **using calm-dsl as a compiler only** - no
decompile round-trip, no post-process scrubs. Treat the v2 `blueprint.json`
as the structural target: v4 must emit something equivalent (modulo trivial
ordering) and import + launch with the same outcome.

## Why we're considering this now

When we abandoned calm-dsl in v2, we didn't fully understand why it was
producing rejectable JSON. With hindsight (cf.
[`../archive/blueprint-v3-tmp/PROGRESS.md`](../archive/blueprint-v3-tmp/PROGRESS.md)) we
know:

1. **The cycle bug was structural, not a calm-dsl emit issue.** Service↔Package
   back-edge from SET_VAR + `eval_variables`. Expressible directly in calm-dsl
   as `Profile.variables = [...]` instead of `Service.variables`. We just
   modelled it wrong the first time.
2. **The escript sandbox patcher works on any JSON.** `_patch_for_calm_escript()`
   in `../blueprint-v2/build_blueprint.py` rewrites `attrs.script` strings;
   it doesn't care whether the JSON came from `build_blueprint.py` or
   `calm compile bp`. Same patcher, applied post-compile, gives v4 the same
   sandbox compatibility v2 has.
3. **The CI compile path is already proven.** `seed_ci_cache.py` + 4
   in-tree calm-dsl patches let `calm compile bp` resolve refs without a
   live PC. Worked through v0.1.10. We never tested whether
   *compile-from-scratch* (no decompile round-trip) emits JSON PC 7.5
   accepts - the post-process treadmill was driven by **decompile** drift.

## Open questions to resolve in a spike

These are the unknowns that decide whether v4 is viable:

1. **Does `calm compile bp` (from-scratch) emit JSON PC 7.5 accepts?**
   The v1 scrub treadmill was reactive to decompile output; we never
   verified a from-scratch compile in isolation. **This is the hinge.**
2. **Which calm-dsl version to target?** 4.3.1 is what we used in v1.
   Newer versions may emit a shape closer to what PC 7.5 expects. Check
   `pip index versions ntnx-ncm-dsl` and pick the latest with a
   reasonable changelog.
3. **Does the cycle fix express cleanly in calm-dsl?** Profile vars +
   bare `@@{X}@@` should be straightforward (`Profile.variables = [...]`).
   But `eval_variables` SET_VAR semantics may not have a 1:1 calm-dsl
   construct - confirm with a minimal test BP before scaling.
4. **Can we keep v2 byte-for-byte equivalent?** Probably not - calm-dsl
   has its own ordering, naming conventions (it likes UUIDs everywhere,
   we use hex DAG names), and metadata defaults. The acceptance criterion
   is **structural equivalence** + **same launch behavior**, not
   byte-equality.

## Attack plan

### Phase 1 - viability spike (½ day, no PC required for first 2 steps)

**Goal:** prove or disprove that calm-dsl 4.3.x compile-from-scratch
emits PC-7.5-acceptable JSON.

1. **Setup** - fresh venv, `pip install ntnx-ncm-dsl` (latest), apply the 4
   in-tree patches from `../blueprint/decompile.py` notes (or check if
   newer calm-dsl removed the need). Run `seed_ci_cache.py` to populate
   `~/.calm/dsl.db` with stub project/cluster/subnet refs.
2. **Hello-world BP** - a 10-line `blueprint.py` with: 1 Service, 1 Profile
   var, 1 EXEC task, 1 Substrate, 1 Package. `calm compile bp` → minimal
   `blueprint.json`. Check it's valid JSON, well-formed, no obvious
   weirdness vs v2's shape.
3. **Upload to PC** *(needs HPoC)* - when a cluster's available, upload
   the hello-world BP to PC 7.5 via `import_file` (the path v2 uses).
   Expect: clean import as DRAFT, no `Found cycles in tasks`, no schema
   violations. **If this passes, v4 is viable. If it fails, document what
   PC complained about and decide whether the gap is patchable
   post-compile or fatal.**
4. **Express the cycle fix** - extend hello-world to add a SET_VAR task
   that reads a Profile var and writes another Profile var via
   `eval_variables`. Compile, upload, confirm no cycle. Validates that
   calm-dsl can express the structural fix without us fighting it.

**Decision gate:** if Phase 1 step 3 passes, proceed to Phase 2. If not,
document why in this PLAN.md, archive the spike, stay on v2.

### Phase 2 - port v2.manifest 1:1 (1 day)

**Goal:** re-author v2's `manifest.py` (declarative spec) as a calm-dsl
`blueprint.py` with the same install runbook, vars, day-2 actions.

1. **Vars** - port the 23 Profile vars from v2.manifest verbatim. Keep
   the same names, defaults, hidden flags. Use `Variable.Simple` /
   `CalmVariable.Simple.Secret` / `CalmVariable.WithOptions` for the
   `MODE` enum. No Service vars - Profile only (cycle fix).
2. **Credentials** - `NUTANIX` cred (username `ubuntu`, password from
   secret var) + `PLAYER` cred. Same shape v2 uses.
3. **Substrate** - AHV provider_spec, cloud-init from v2's `cloud_config.yml`
   verbatim, NIC bound to subnet runtime_editable. `editables` block lists
   the runtime overrides (cluster, subnet, IP).
4. **Package** - CUSTOM with `options.install` runbook listing the install
   tasks in order. v2's 14-task install (Activate policy, Get Cluster,
   Setup subnets, Setup project, Create users, Create VMs, Setup jumphost,
   Trigger LCM, Install Docker, Run container, Verify state, …). Each task
   = `EXEC` referring to a script file in `scripts/`.
5. **Profile** - the only Profile, holds the day-2 actions
   (`UpdateGame`, `VerifyState`).
6. **Compile + upload** - `calm compile bp` → `blueprint.json`. Apply the
   sandbox patcher post-compile (script step below). Upload to PC. If it
   imports clean, run the install runbook end-to-end on a real cluster.

### Phase 3 - sandbox patcher integration (½ day)

The patcher already exists in `../blueprint-v2/build_blueprint.py` as
`_patch_for_calm_escript()`. It walks the JSON, finds `attrs.script`
strings, and rewrites banned imports + callsites + injects helpers.

**Plan:**

1. Extract the patcher into a standalone module
   `tooling/blueprint-v4/patch_escript.py` (copy + minimal cleanup, no
   logic changes - proven code, don't disturb it).
2. Add a `make compile` target that runs `calm compile bp` then pipes the
   JSON through `patch_escript.py` (read JSON, walk tasks, rewrite scripts,
   write back).
3. Diff v4's patched `blueprint.json` against v2's `blueprint.json`.
   Expected diffs: ordering, UUIDs, calm-dsl-ish metadata. **Not expected:**
   different task graph, different var scoping, different runtime
   editables. If unexpected diffs surface, investigate before shipping.

### Phase 4 - CI integration + ship (½ day)

1. New job `compile-blueprint-v4` in `.github/workflows/release.yml` that:
   a. Sets up Python + ntnx-ncm-dsl
   b. Runs `seed_ci_cache.py` to populate `~/.calm/dsl.db` (already exists).
   c. `calm compile bp -f tooling/blueprint-v4/blueprint.py -o tooling/blueprint-v4/blueprint.raw.json`
   d. `python3 tooling/blueprint-v4/patch_escript.py tooling/blueprint-v4/blueprint.raw.json tooling/blueprint-v4/blueprint.json`
   e. Upload `nig-01-blueprint.json` from v4's output (replace v2's job).
2. Tag a `v0.2.0` release once an end-to-end live launch validates v4.
3. **Move v2 to archive** - add a banner to `../blueprint-v2/README.md`
   pointing at v4 as the new active.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `calm compile bp` from-scratch emits PC-7.5-incompatible JSON | medium | Phase 1 step 3 gates everything; if it fails, stay on v2 |
| calm-dsl can't express the cycle fix cleanly | low (Profile vars are standard) | Phase 1 step 4 tests this before porting v2 |
| Reintroducing schema drift via newer calm-dsl version | medium | Pin a version, treat it like a dependency upgrade with regression tests |
| Sandbox patcher diverges from v2 over time | low | Single source of truth - v2 keeps using it too, or we extract to a shared module |
| Effort balloons past the 2-day budget | medium | Hard timebox - if Phase 2 isn't done in 1 day, retreat to v2 |

## Acceptance criteria

v4 ships when **all** of:

1. `calm compile bp` produces a `blueprint.json` that imports clean on PC 7.5
   (no cycles, no schema violations, no warnings beyond the calm-7.5-known
   benign ones).
2. `simple_launch` provisions the VM and runs the install runbook end-to-end,
   with the same install tasks succeeding as v2's last validated run.
3. The game container comes up at `http://<vm>:3000` with all 39 stages
   loaded and the `mode=live` capability probe passing.
4. The day-2 actions `UpdateGame` + `VerifyState` work the same as v2.
5. Diff vs v2 is reviewed and any structural divergence is documented or
   intentional.

## Don't do

- **Don't decompile a v2 BP into v4.** That's the v1 trap. Author from
  `manifest.py` source directly.
- **Don't try to keep v2 + v4 in lockstep edit-by-edit.** Pick one as the
  source of truth. Plan: keep v2 frozen during Phase 2 + 3, switch over
  at Phase 4 ship.
- **Don't reopen the post-process scrub treadmill.** If calm-dsl emits
  garbage, Phase 1 step 3 will tell us; we either patch the *source* (the
  Python BP) to avoid the bad construct, or accept v4 isn't viable. No
  scrub layers.

## When to start

Either:
- **Now offline** - Phase 1 steps 1, 2, 4 don't need a PC. Steps 3 + Phase 2+ need
  a cluster. Useful prep work even without an HPoC available.
- **When an HPoC reappears** - start cold from Phase 1 step 1, run all
  phases against the live cluster.

## Backout

If v4 fails any acceptance criterion, archive this directory (rename to
`blueprint-v4-archive/`), document the gap in this PLAN.md (replace this
section with a "what we learned" postmortem), and stay on v2.
