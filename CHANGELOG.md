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
- Install runbook gained a `Disable erasure coding` step (hpoc-only) that runs
  before `Remove 4th host on HPoC`. A 4-node HPoC with Nutanix Files enables
  EC-X on the Files container, which needs 4 nodes and so blocked the node
  removal; the deploy now supports that pre-canned HPoC layout.

### Fixed

- `Remove 4th host on HPoC` no longer stalls when the cluster has Nutanix Files
  with EC-X. The remove-node precheck fails until erasure-coding strips are
  un-coded, so the step now retries that precheck (after `Disable erasure
  coding` flips EC off) until Curator has finished, instead of treating the
  first precheck failure as terminal.

- AD endpoint username now defaults to UPN (`administrator@ntnxlab.local`)
  instead of `NTNXLAB\administrator`. The endpoint dials WinRM Basic auth, which
  rejects the NetBIOS `DOMAIN\user` form, so `Add AD users` failed with a
  misleading "Authentication by password failed" even with valid credentials.

## [0.2.0]

Baseline release. See the git history for changes up to this point.

[Unreleased]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/r0w/ntnx-infiltration-game/releases/tag/v0.2.0
