# Historical phase docs

These two files cover the calm-dsl revival spike (2026-04-30 → 2026-05-01)
that produced the active `blueprint.py`. Kept as archive - the structural
choices they document (cycle root cause, sandbox patcher, CUSTOM→DEB,
disk-grow) still apply to the shipped BP, but the per-phase narrative
isn't load-bearing for current operation.

- [`HISTORY-PLAN.md`](./HISTORY-PLAN.md) - the original 4-phase attack plan
  before any code landed. Risk register, acceptance criteria, backout.
- [`HISTORY-SPIKE.md`](./HISTORY-SPIKE.md) - phase-by-phase running notes
  with each step's live outcome on HPoC.

For the current operator-facing runbook see [`../README.md`](../README.md)
and the top-level [`OPERATOR.md`](../../../OPERATOR.md).
