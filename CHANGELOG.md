# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

How to maintain it: add your change under `[Unreleased]` in the matching
`Added` / `Changed` / `Fixed` section as part of the same PR. When cutting a
release, rename `[Unreleased]` to the new version with the date, then start a
fresh empty `[Unreleased]` on top. The release workflow lifts the version's
section verbatim into the GitHub Release notes, which the admin footer shows.

## [Unreleased]

### Added

- Admin footer showing the running version, branch, and commit, with a changelog
  modal listing the latest GitHub Releases.
- `GET /api/version` endpoint exposing the build-stamped version, git sha, branch,
  and build time.
- `CHANGELOG.md`, a branching workflow (`docs/BRANCHING.md`), a contributor guide
  (`CONTRIBUTING.md`), and a PR template requiring a changelog entry.

### Changed

- Install runbook sets the `CloneProd` `pcUser` credential at deploy time, so
  stage 35 no longer asks the player to enter it (and can't lock the admin
  account on a typo).
- Install runbook disables erasure coding (hpoc-only) before removing the 4th
  node, supporting the pre-canned 4-node Files + EC-X HPoC layout.
- Install runbook runs `Add AD users` as a fail-fast gate before the destructive
  node shrink, so a bad AD credential can't leave the cluster half-shrunk.
- Release workflow uses the matching `CHANGELOG.md` section as the GitHub Release
  notes, and stamps the Docker image with version metadata.
- Moved the headless launcher into the maintainer's private deploy kit; external
  operators use the Prism UI flow in `OPERATOR.md`.

### Fixed

- Install tasks no longer fail the whole deploy on a transient API blip (issue
  #28: a `ReadTimeout` mid-task). Idempotent lookups across the deploy scripts
  (`get_cluster`, `setup_subnets`, `setup_production_project`,
  `setup_jumphost_endpoint`, `create_local_users`, `clone_fake_bps`) now retry on
  network errors and 5xx, and the project-create POST recovers from a
  timed-out-but-succeeded create by adopting the existing project instead of
  erroring on the duplicate name.
- Stage 12 (`create-vm`) auto-play now builds the 2-NIC VM on HPoCs whose
  routable subnet is named `secondary-<cluster>` (e.g. `secondary-DM3-POC013`)
  rather than bare `secondary`. The act matched the name strictly, so it found
  no secondary subnet and created a 1-NIC VM that failed CheckVM; a tolerant
  `isSecondarySubnet` matcher (same as the blueprint's) fixes it.
- Stage 8 (`create-project`) auto-play now actually adds `theprojectmanager` as
  Project Admin, so stage 12's Manage Ownership can set the VM owner. The act
  put the user straight into the plain `/projects` POST, which PC rejects with
  "Users/User groups not found" (the project lands in ERROR and the member is
  never added) — leaving stage 12 unpassable on a real cluster. It now registers
  the member via `/projects_internal` + a Project Admin ACP (the same recipe the
  blueprint uses for `thebadguy`), and the VM-owner PUT retries on the transient
  409 edit-conflict that follows the membership change.
- `Remove 4th host on HPoC` no longer stalls on a Files + EC-X cluster: it retries
  the remove-node precheck until Curator finishes un-coding the strips, instead of
  giving up on the first failure.
- AD endpoint username defaults to UPN (`administrator@ntnxlab.local`); WinRM Basic
  auth rejects the `DOMAIN\user` form, which made `Add AD users` fail with a
  misleading authentication error.

## [0.2.0]

Baseline release. See the git history for changes up to this point.

[Unreleased]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/r0w/ntnx-infiltration-game/releases/tag/v0.2.0
