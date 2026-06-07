# Roadmap

Short status-only view. For deeper architecture context see [ARCHITECTURE.md](./ARCHITECTURE.md); for the stage map see [STAGES.md](./STAGES.md); for what's tested see [TESTS.md](./TESTS.md).

## Status

The game is **playable end-to-end**: 39 stages, 25 live check functions hitting Nutanix v4, deployable zero-touch via the Calm blueprint at [`tooling/blueprint/`](../tooling/blueprint/). Validated against PC 7.5 - install runbook SUCCESS, auto-play 39/39 stages SUCCESS. Re-validated on a fresh HPoC on 2026-06-07 (full deploy + auto-play + a manual player run through the resource-creation stages), then merged develop into main. UI-uploadable on any PC 7.5. Test suite green (237 tests across engine + server + nutanix + frontend).

## Open paths

Priority decreasing.

- **Real human session in `live` mode.** A manual run through the resource-creation stages (login through create-vm) on a live HPoC passed on 2026-06-07; a full 39-stage human walkthrough is still the last validation before declaring the player UX done.
- **Multi-player on the same deploy.** Sessions are isolated in the DB but share the cluster. Conflicts on non-trigram-scoped resources (`secondary` subnet, `production` project, jumphost endpoint, fake BPs) haven't been stress-tested.
- **Operator resilience.** VM reboot → container restart? HPoC expires mid-session, what's the migration story? Operator dropping a session via `/admin` - clean cluster-side teardown of what the player created?
- **Content polish.** Typos, confusing prompts, image asset coverage parity en/fr, system hints. Needs a human-driven walkthrough to surface. Auto-play vs prompt fidelity items tracked in [#23](https://github.com/r0w/ntnx-infiltration-game/issues/23).

## Nice-to-have

- Migrate the 13 v4 checks still on `ctx.nutanix.request()` to the typed `sdk.*` surface (mechanical polish, not blocking).
- Re-render narrative units on resume so a player who closed the tab mid-typewriter on a narrative-only stage doesn't lose the prose.
- SSE streaming on `/advance` (current REST + typewriter UX is fluid; bonus, not a need).
- `/ssh` console extensions: IPv6, `nslookup`, `traceroute`, `curl -I`, server-side abort.

## Contributor tools

Authoring affordances planned at the start of the project but not yet built. Not blocking gameplay; would lower the friction of adding stages or starting a second pack.

- **Fixture recorder** - a script that hits a real Prism Central and writes its responses into `packs/<pack>/fixtures.json` keyed by `"METHOD path"`. Today fixtures are hand-maintained when a new check function lands; recording would make the loop one-shot.
- **Empty pack template** (`packs/example-empty-pack/`) - a minimal scaffold (manifest + one narrative stage + one input stage + one stub check) that a contributor can copy-rename to start a second game on another product. The engine already supports `GAME_PACK=<name>` per-container; only the template is missing.
