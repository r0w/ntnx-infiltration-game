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

### Changed

- The prerequisites runbook now asks which project to use instead of assuming
  one named `lab`, and says so plainly when that project does not exist.

### Fixed

## [1.0.0] - 2026-07-28

### Fixed

- The email roster now flags malformed addresses instantly and ignores
  duplicates in a single paste, instead of counting them as skips.

## [0.5.0] - 2026-07-27

### Added

- Spanish (`es`) and Italian (`it`) locale resources, flagged as
  work-in-progress in `pack.json`. WIP locales are always visible in `mock` /
  `test` for translators + QA; in `live` they are hidden from the player
  language selector unless the operator explicitly enables them from the new
  Languages panel in `/admin` (persisted in `cluster_config`).
- Full Spanish and Italian translations of the game (all 238 lines).

### Changed

- The language picker now marks work-in-progress languages with a "(WIP)"
  suffix so players know they are not fully translated yet.

## [0.4.3] - 2026-07-12

### Changed

- Stage 29 validates against the cached update count that /admin shows, which an
  operator can refresh or correct, instead of querying LCM on every attempt.
- Stage 29 tells players to read the LCM list without running an inventory, and
  a check it cannot judge (an inventory is rebuilding that list) now says so and
  asks for the number again, instead of counting as a failure.

## [0.4.2] - 2026-07-11

### Fixed

- Stage 29 no longer rejects a correct update count while an LCM inventory is
  running: the count is left unverified for those few minutes instead of
  compared against a list LCM is still rebuilding.

## [0.4.1] - 2026-07-11

### Changed

- Wiring the Mailtrap sender takes a single save, and a stored token can no
  longer be revealed from the page.

## [0.4.0] - 2026-07-11

### Added

- Optional anonymous usage stats: set `NIG_CENTRAL_URL` to send session and
  stage-timing events to a NIG Central instance; unset means nothing is ever
  sent, and an unreachable Central never affects the game.
- Blueprint deployments report those usage stats to the team's NIG Central
  by default (endpoint baked into the blueprint, not an operator field).
- Per-stage wall-clock timing (time the player actually spent on each stage).

### Changed

- Stages now carry a durable `id` (`eg-NNN`, from the original escape-game
  lineage) that survives renames and pack restructuring.

### Fixed

- An agent code that has already completed the game can no longer be reused by
  another player; retyping it with the right PIN reopens the finished session.
- The invitation email's password field now defaults to the Prism Central admin
  password instead of the cluster name.

## [0.3.1] - 2026-07-05

### Added

- `/admin` shows a red banner on every tab while Intelligent Operations is
  disabled on the cluster (it blocks the create-report stage), with a Prism
  deep-link and a re-check button.

### Fixed

- The changelog dialog no longer breaks long release-note bullets into stray
  paragraphs.
- The session API returns the player's actual trigram (or none before login)
  instead of an internal placeholder id.

## [0.3.0] - 2026-07-04

### Added

- Participant emails are back: invite and thank your agents from the new `/admin` Emails tab.
- The `/admin` Cluster tab shows the software versions the cluster actually runs (PC, AOS, Files, …).
- Operator QoL: `/admin` shows each player's last failed check, plus a Logs tab of all attempts.
- Admin footer showing the running version, branch, and commit, with a changelog
  modal listing the latest GitHub Releases.
- `GET /api/version` endpoint exposing the build-stamped version, git sha, branch,
  and build time.
- `CHANGELOG.md`, a branching workflow (`docs/BRANCHING.md`), a contributor guide
  (`CONTRIBUTING.md`), and a PR template requiring a changelog entry.

### Changed

- Every `/admin` tab now uses the same card layout with clearer section headers.
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

- Checks no longer false-fail after a player re-creates a resource (image,
  subnet, project, category, user, policies, app): entities are re-resolved
  by name at check time instead of trusting a UUID remembered earlier.
- The install's node-shrink step only runs on a 4+ node cluster, so a smaller
  cluster no longer fails the deploy on a doomed node removal.
- Deployment is resilient to transient Prism API blips: a single hiccup during
  install no longer fails the whole deploy.
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

[Unreleased]: https://github.com/r0w/ntnx-infiltration-game/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.5.0...v1.0.0
[0.5.0]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.2.1...v0.3.0
[0.2.0]: https://github.com/r0w/ntnx-infiltration-game/releases/tag/v0.2.0
