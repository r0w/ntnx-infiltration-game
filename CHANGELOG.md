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

- A second game: the NKP Fundamentals bootcamp, 26 stages from multi-tenancy
  through persistent storage, observability and GitOps.
- Click any screenshot in the terminal to open it full size.
- Screenshots can carry their description as a visible caption, and the run can
  pause on each one so it is not scrolled away while you read it.
- The NKP tour and the NDK lab open their interactive demo in the game instead
  of sending players off to the bootcamp site.
- A collapsible contents menu down the left of the NKP bootcamp, with the
  chapters of the original. It shows where you are, and opens any step you have
  already reached so you can read it again without leaving your place.
- Each game names its own operator: Tank still speaks in the infiltration game,
  the bootcamp is narrated by the instructor.
- Auto-play can now walk the whole NKP bootcamp on a real fleet: every lab step
  it validates, it can also perform.
- Wiping a bootcamp learner's work is one call: `/api/act/cleanup-all/user01`
  removes their project and everything in it, ready for another run.
- Operator act, auto-play and cleanup endpoints accept a bootcamp learner
  (`user01`, or just `01`) the same way they accept an agent code.
- The blueprint launch screen now asks which game to install, NCP or NKP.
- The Pack tab can export the stage setup as one string, import it on another
  instance, and reset every stage back to the pack defaults.
- The Pack tab says at a glance how many stages differ from the pack defaults.

### Changed

- The bootcamp now prints the real ingress addresses of the cluster you are on,
  so a step reads `wordpress07.10.54.93.18.sslip.io` instead of asking you to
  substitute a placeholder. If an address cannot be read, the original wording
  is used.
- The contents menu now opens folded and unfolds only as far as where you are,
  so a bootcamp does not greet a learner with every step at once.
- The contents menu no longer carries a "back to where you are" button: reading
  a step opens a panel, so the run behind it never moves.
- The two games are called NCP and NKP in `/admin` and on the launch screen.
- The blueprint's two application profiles now carry the games' names, `NCP` and
  `NKPFundamentals`, instead of `DefaultProfile` and `NkpProfile`.
- Installing the NKP bootcamp no longer asks for the console URL or the
  bootstrap VM address: the install finds the `nkp-boot` VM on Prism Central,
  and the game builds the console link from the address it already reads off the
  fleet. Both fields stay on the screen for anyone who wants to pin them.
- The game's name in the browser tab and header now comes from the pack, so each
  game carries its own.
- Screenshots in the terminal are wider and centred, so the detail a step points
  at is readable without enlarging.
- Each game now carries its own settings, its own cluster questions and its own
  Kubernetes access instead of the server holding both games' at once; the
  kubeconfig setting is named `KUBECONFIG_PATH`, with the old `NKP_KUBECONFIG`
  still accepted.
- The bootcamp no longer serves the infiltration game's ops console at `/ssh`.
- The operator guide now covers both games, including what the NKP bootcamp
  needs on the cluster and what changes in `/admin`.
- The Pack tab now opens with the whole run in play order, colour-coded by what
  each stage will do, and the stage list can be filtered and searched.
- The prerequisites runbook now asks which project to use instead of assuming
  one named `lab`, and says so plainly when that project does not exist.

### Fixed

- Turning off a stage in the Pack tab now also turns off the stages whose
  cluster resources it creates, in the infiltration game too: disabling the VM
  stage takes the six stages that act on that VM with it.
- Asking to switch player in the bootcamp no longer jumps straight to the end
  screen: it puts you back at the question, with the previous answer cleared.
- The terminal now offers to switch player in the words of the game you are
  playing, "user" in the bootcamp rather than "agent".
- The NKP app you deploy from the terminal now lands on the cluster whose
  address its Ingress carries, so `https://user09.<ingress>.sslip.io` really
  serves NGINX instead of returning a 404.
- Running the whole bootcamp from the operator endpoints no longer reports every
  step as failed on a cluster where every step actually worked.
- Replaying the bootcamp for a learner who already reached the dynamic
  assignment lab no longer sends the second cluster back out of their project.
- Usage stats now identify a deployment by the machine it runs on, instead of
  reporting the same container address from every install.
- Usage stats say which game they come from, so the two are no longer counted
  as one.
- The bootcamp's learners now appear in `/admin` Users: each pack says which
  captured value names a player, so a user number counts as an identity.
- When a bootcamp check fails, `/admin` now says what it found, like the
  infiltration game does.
- Turning off a bootcamp stage in the Pack tab now also turns off the stages
  whose cluster resources it creates.
- Placeholders such as `<any_node_IP>` now show as written, in the text and in
  the YAML you copy, instead of appearing as `&lt;`.
- The NKP NodePort step now follows the bootcamp's own wording and its full
  command sequence, including the `NODE_PORT` variable it relies on.
- The NKP contents menu now nests like the bootcamp's own: one Optional Labs
  chapter, with Expose app on production inside Deploy and expose an app.
- The NKP bootcamp's takeaways, both chapter recaps and the conclusion, now
  carry the wording of the original instead of a summary of it.
- The NKP bootcamp puts back ten steps and notes that had been summarised away,
  including the warning not to break a shared environment, and how to find the
  MetalLB pool, the node IPs and the Traefik address.
- A screenshot with a long caption no longer sits off to the left of it.
- The install no longer stops when the cluster serves an older v4 API than
  expected, or when erasure coding has to be turned off on an Objects container.
- The install no longer stops on clusters running NCM Self-Service 4.4.0, which
  rejected one of the two blueprints the game uploads for later stages.

## [1.0.2] - 2026-09-06

### Fixed

- Installation now stops with the Nutanix error when network or VM creation fails.

## [1.0.1] - 2026-09-06

### Fixed

- Pin Calm DSL to 4.3.1 so prerequisite blueprints deploy reliably.

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

[Unreleased]: https://github.com/r0w/ntnx-infiltration-game/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/r0w/ntnx-infiltration-game/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/r0w/ntnx-infiltration-game/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.5.0...v1.0.0
[0.5.0]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/r0w/ntnx-infiltration-game/compare/v0.2.1...v0.3.0
[0.2.0]: https://github.com/r0w/ntnx-infiltration-game/releases/tag/v0.2.0
