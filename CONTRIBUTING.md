# Contributing

Thanks for helping out. This project is a Bun monorepo (engine / server /
frontend / nutanix / kube-transport / shared packages) plus the game packs under
`packs/` - one directory per game, and a deployment runs one of them.

One rule that only breaks in production: a pack may **type**-import a workspace
package, never value-import one. The runtime image ships no `node_modules`, so a
value import resolves locally and kills the container on deploy. Runtime helpers
live in the pack, or arrive on a context. A test enforces it.

## Workflow

- Branch features off **`develop`** and open your PR against `develop`.
- Hotfixes branch off **`main`**; the maintainer back-merges `main` into
  `develop` afterwards. The full branch/release model is in
  [`docs/BRANCHING.md`](docs/BRANCHING.md).
- Keep commits to a short one-line subject (e.g. `Fix copy button scroll`).
- PR titles and descriptions: legible English prose.

## Changelog (required)

Every change updates [`CHANGELOG.md`](CHANGELOG.md) in the same PR. Add a bullet
under `## [Unreleased]` in the matching section:

- **Added** — new features.
- **Changed** — changes to existing behavior.
- **Fixed** — bug fixes.

Example:

```markdown
## [Unreleased]

### Fixed

- Copy button no longer scrolls the terminal to the top.
```

We follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/). At release time the maintainer
renames `[Unreleased]` to the new version; the workflow then uses that section
as the GitHub Release notes (surfaced in the in-app `/admin` footer).

Pure chore/CI/docs-only PRs may skip the changelog entry — say so in the PR.

## Before you push

```sh
bun install
bun test            # full suite
bun run typecheck   # all packages
```

If you touched `packages/engine`, `packages/server`, or `packs/`, restart the
backend — Bun caches the engine/pack at boot. The frontend (Vite) hot-reloads.
