# Blueprint v3-tmp — cycle bisection spike *(ARCHIVED 2026-05-03)*

> **Status: archived.** This directory is a diagnostic spike, not a shipping
> blueprint. The root cause it isolated is now fixed in
> [`../../v2/`](../../v2/README.md) and inherited by v4.
> For the overview of all blueprint generations, see
> [`../../README.md`](../../README.md).

## What this directory is

A scratch area used 2026-04-28 to bisect the `Found cycles in tasks` error
that v2 was hitting on import. We started from a confirmed-launchable
minimal BP (1 service + 1 EXEC task + 0 vars) and added one feature at a
time, rebuilding `blueprint.json` and uploading to PC after each step,
until the cycle reappeared. Each commit in the bisection is named
`A1`, `A2`, …, `B1`, `C1`, … so the binary search trail is git-grep-able.

## Outcome

**Root cause found** — a SET_VARIABLE task that reads `@@{Game.X}@@` (i.e.
references a Service-scoped var) AND writes a Service var via
`eval_variables` creates a bidirectional edge Service↔Package that PC's
lifecycle planner interprets as a back-edge.

**Fix applied to v2** (commit `cb15941`):
- Move runtime vars from `Service Game.variables` to `Profile Default.variables`.
- Patch all `@@{Game.X}@@` references in install scripts to bare `@@{X}@@`.

After the fix, v2 imports clean and launches end-to-end. Live deploy
validated 2026-04-29 (cf. memory `project_bp_v2_zero_touch.md`).

## What's in here

| File | Role |
|---|---|
| `PROGRESS.md`     | Full diagnostic log: each phase A1..C4, what was tested, what was learned, when the root cause crystallized. **Read this if you ever need to redo a bisection.** |
| `build_minimal.py`| Stripped-down assembler the spike used. Parametric: takes flags for which features to enable so each commit only flips one knob. |
| `blueprint.json`  | Last build emitted by the spike. Frozen — don't regenerate. |
| `scripts/`        | Minimal escript set the spike exercised. |

## Don't reopen these (already determined dead-ends)

- calm-dsl 4.3.1 + post-process scrubs (commit `9864683` archives the path).
- DAG hex-renaming hypothesis (`4c64493b_dag` etc. — not the cause).
- Substrate fragment actions as a workaround.
- DEB vs CUSTOM package type (both work hand-authored).

If you need to re-bisect a NEW cycle (not the one fixed here), the
methodology in `PROGRESS.md` is reusable: branch from a known-good build,
add ONE feature, rebuild, upload, observe — bisect like git bisect.
