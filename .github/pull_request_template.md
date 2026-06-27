<!-- Keep the title human-readable and in English. -->

## What & why

<!-- One or two sentences: what changed and the reason. -->

## Checklist

- [ ] **`CHANGELOG.md` updated** under `[Unreleased]` in the right section
      (`Added` / `Changed` / `Fixed`). Skip only for pure chore/CI/docs PRs.
- [ ] Targets `develop` (features) — not `main`. Hotfixes branch off `main`;
      see `docs/BRANCHING.md`.
- [ ] Tests pass (`bun test`) and typecheck is clean (`bun run typecheck`).
- [ ] Restarted the backend if I touched `packages/engine`, `packages/server`,
      or `packs/` (Bun caches at boot).
