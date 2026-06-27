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

### Changed

- Release workflow now uses the matching `CHANGELOG.md` section as the GitHub
  Release notes when present (falling back to auto-generated notes), and stamps
  the Docker image with version metadata via build args.

## [0.2.0]

Baseline release. See the git history for changes up to this point.

[Unreleased]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/r0w/ntnx-infiltration-game/releases/tag/v0.2.0
