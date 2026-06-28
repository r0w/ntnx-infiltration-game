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

- Admin footer showing the running version, branch, and commit, with a
  changelog modal that lists the latest GitHub Releases.
- `GET /api/version` endpoint exposing the build-stamped version, git sha,
  branch, and build time.
- `CHANGELOG.md` (this file) and a documented branching workflow in
  `docs/BRANCHING.md`.
- Contributor guide (`CONTRIBUTING.md`) and a pull-request template requiring a
  changelog entry.

### Changed

- Install runbook now sets the `CloneProd` blueprint's `pcUser` credential to
  the real PC admin account at deploy time, instead of asking the player to do
  it by hand in stage 35. The shipped blueprint baked a placeholder credential
  that 401'd the clone runbook; the manual fix also risked locking the admin
  account on a typo. Now injected once from the PC creds Calm already provides.
- Stage 35 (`clone-app-blueprint`) no longer asks the player to update the
  `CloneProd` credentials before launching, now that the deploy step sets them.
- Release workflow now uses the matching `CHANGELOG.md` section as the GitHub
  Release notes when present (falling back to auto-generated notes), and stamps
  the Docker image with version metadata via build args.
- Moved the headless launcher out of `tooling/blueprint/` into the maintainer's
  private deploy kit. External operators continue to use the Prism UI flow in
  `OPERATOR.md`; the public docs now point there for headless launches.
- Install runbook now runs `Add AD users` as a sequential fail-fast gate right
  after `Get Cluster`, before the parallel block. An AD failure can no longer
  abort the install after the destructive node shrink has started, so the
  cluster is never left half-shrunk; the operator just re-launches.

### Fixed

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
- AD endpoint username now defaults to UPN (`administrator@ntnxlab.local`)
  instead of `NTNXLAB\administrator`. The endpoint dials WinRM Basic auth, which
  rejects the NetBIOS `DOMAIN\user` form, so `Add AD users` failed with a
  misleading "Authentication by password failed" even with valid credentials.

## [0.2.0]

Baseline release. See the git history for changes up to this point.

[Unreleased]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/r0w/ntnx-infiltration-game/releases/tag/v0.2.0
