# Branching & release workflow

Two long-lived branches:

- **`main`** — always deployable. Protected (no force-push, PR-only). Every
  `v*` tag is cut from here and triggers a release (Docker image + GitHub
  Release + blueprint assets).
- **`develop`** — integration branch. Feature work lands here first; every push
  builds a `:develop` / `:develop-<sha7>` image for staging.

## Day-to-day

1. Branch a feature off `develop`.
2. Open a PR into `develop`. It is **squash-merged** (one commit per feature).
3. When `develop` is release-ready, merge it into `main` with a **merge commit**
   (not squash, not rebase). Tag `main` with `vX.Y.Z` and push the tag to ship.

## Hotfixes: keeping `main` and `develop` in sync

The classic two-branch trap is a fix that lands on `main` but never reaches
`develop`, so it silently regresses on the next release. We handle this by
**discipline, not automation**: every change to `main` is back-merged into
`develop` immediately.

A hotfix:

1. Branch off **`main`** (not develop): `git checkout main && git pull && git checkout -b hotfix-xyz`.
2. PR into `main`, merge, tag + release if it warrants a version bump.
3. **Immediately back-merge `main` into `develop`:**

   ```sh
   git checkout develop
   git pull
   git merge origin/main      # merge commit; resolve conflicts here if any
   git push
   ```

Do the back-merge the same day, every time. The merge commit keeps the two
branches' histories connected, so the next `develop → main` merge stays clean
(no re-application of the hotfix, no duplicate-commit conflicts).

Rule of thumb: **never let `main` contain a commit that isn't also reachable
from `develop`.** If you ever wonder "is this fix in develop too?", run
`git branch --contains <sha>` — both branches should appear.

## Changelog

Update `CHANGELOG.md` under `[Unreleased]` in the same PR as your change
(`Added` / `Changed` / `Fixed`). At release time the matching version section
becomes the GitHub Release notes, which the `/admin` footer surfaces live.
