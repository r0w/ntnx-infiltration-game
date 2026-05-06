# Pack scripts

Authoring helpers for the `ntnx-infiltration` pack. None of these are needed
to run the game - they exist for contributors who edit stages or locales.

## `audit-stage-deps.ts`

Static dependency audit across the pack. Builds a producer/consumer graph of
the session variables referenced by stage prose and check captures, then
flags:

- **Orphans** - variables a stage's prose substitutes (`{Foo}`) but no
  upstream stage produces (no `<input/>`, no check capture, not seeded from
  env).
- **Unrehydratable producers** - stages whose captures come from user input
  rather than an API query, so skipping them silently breaks downstream
  stages that depend on the captured value.

Run from the repo root:

```bash
bun packs/ntnx-infiltration/scripts/audit-stage-deps.ts             # human report
bun packs/ntnx-infiltration/scripts/audit-stage-deps.ts --json      # full graph as JSON
bun packs/ntnx-infiltration/scripts/audit-stage-deps.ts --apply     # write derived `needs` + `captures` into each stage JSON
```

`--apply` is the canonical way to refresh the `needs` and `captures` fields
on every stage after adding or editing a stage - the runtime gate reads
those fields to decide whether an upstream is missing.
