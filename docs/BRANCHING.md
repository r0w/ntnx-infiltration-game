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

## Maintaining an older release (`release/X.Y.x`)

Sometimes `develop` has moved on to the next minor (say `0.3.0`) but an operator
is still deployed on the previous one (`0.2.x`) and needs a fix without taking
the newer, larger release. `main` now tracks the newer line, so you can't tag a
`v0.2.2` from it. Cut a **maintenance branch** instead.

First, know what you actually need:

- **Just running the old version** needs no branch. A release is a `vX.Y.Z`
  *tag*, which builds a frozen image `ghcr.io/…:vX.Y.Z`. Deploy that image by
  setting the blueprint's `IMAGE_TAG` runtime variable (e.g. `v0.2.1`). The tag
  and image already exist; nothing to maintain.
  ⚠ `:latest` follows the newest `v*` tag, so a default install jumps to the new
  release — pin `IMAGE_TAG` explicitly to stay on the old line.
- **Shipping *new* fixes on the old line** (a `v0.2.2`) is the only reason to
  keep a branch, because you need somewhere to commit and re-tag from.

The maintenance branch:

1. Branch it from the last tag on that line and name it for the line, not a
   point release: `git checkout -b release/0.2.x v0.2.1 && git push -u origin release/0.2.x`.
2. Land the fix on it, roll `CHANGELOG.md`, tag `v0.2.2` **from this branch**
   (not from `main`) and push the tag to build `:v0.2.2`.
3. If the same bug also affects the current line, fix it **once here**, then
   **cherry-pick** the commit onto `develop` (`git cherry-pick <sha>`). Do *not*
   merge `release/0.2.x` into `develop` or `main` — that would drag the whole
   old base back in.

Rule of thumb: maintenance branches only ever **emit tags and donate
cherry-picks**; they never merge back. Delete the branch once no one runs that
line anymore (the tags/images stay regardless).

## Changelog

Update `CHANGELOG.md` under `[Unreleased]` in the same PR as your change
(`Added` / `Changed` / `Fixed`). At release time the matching version section
becomes the GitHub Release notes, which the `/admin` footer surfaces live.
