# Tests

**329 tests across 28 files**, all unit + integration, no browser. `bun test` from the repo root runs the lot in ~9 s. CI-friendly: no network, in-memory SQLite, mock Nutanix adapter.

```bash
bun test                                          # everything
bun test packages/server                          # one package
bun test packages/server/test/e2e-gates.test.ts   # one file
bun test -t "lunch lock"                           # by name
```

## Coverage by package

**`packages/engine`** - pure logic, zero I/O, so fast and exhaustive.

| File | What it pins |
|---|---|
| `message-parser.test.ts` | The JSX-like grammar: `{Var}` substitution, `<pause/>`, `<input/>`, links, color/style stacking, escaping |
| `stage-runner.test.ts` | Stage rendering + ordering, gating, locale fallback, await-input index |
| `capability-gate.test.ts` | The gate verdicts: inactive, passed, missing capability, destructive-off-hpoc, missing upstream, admin gate |
| `variables.test.ts` | The `Variables` store: get/set/delete, listeners, snapshot shape |
| `lcm-updates.test.ts` | Stage-29 update counting (`dedupedUpdateCount`, `isReadingSettled`) |

**`packages/nutanix`** - transport adapters.

| File | What it pins |
|---|---|
| `mock-adapter.test.ts` | Fixture matching, miss errors, SDK envelope shim, per-session overlay (`<action name='deleteVM'/>` hides the entity) |
| `rest-adapter.test.ts` | Auth + headers, TLS toggle, non-2xx → typed error, GET 5xx retry |
| `capability-probe.test.ts` | The four capability flags on healthy responses; degrades gracefully (never throws) |

**`packages/server`** - HTTP + DB + service layer, the bulk of the suite. Each file boots an in-memory SQLite + Hono router and drives it via `app.fetch()`, the same path the browser hits.

| File | What it pins |
|---|---|
| `session-service.test.ts` | The gameplay state machine: advance, input, capture + substitute, destructive gating, `skipTo`, cheers, `<action/>` dispatch, retry rewind, re-auth, admin gates, lunch lock |
| `admin.test.ts` | `/api/admin/*`: login, users, delete cascade, gates, pack toggles, lunch status |
| `check-trigram.test.ts` | Trigram shape + collision (returning-agent re-auth) |
| `dep-analysis.test.ts` | Cascade-disable preview: which downstream stages break when an upstream producer is off |
| `scoreboard.test.ts` | Sort, anonymous filtering, UUID anti-leak, packId scoping |
| `cluster-profile.test.ts` | Explicit `hpoc`/`other`, fallback to `other` when unset |
| `ssh.test.ts` | `/api/ssh/ping` argv validation + probe error remapping |
| `auto-fill-current.test.ts` | Auto-fillable vars (NodeSerial, NumberUpdates, Runway…) resolve in mock |
| `cluster-config-probe.test.ts` | The cached LCM count stage 29 judges against |
| `pack-helpers.test.ts` | Stage-29 verdict deferral window after an LCM inventory |
| `pack-integrity.test.ts` | Pack invariants: dependency-audit orphans, fixture placeholders |
| `recovery-point-action.test.ts` | Recovery-point `<action/>` actually fires |
| `effective-locales.test.ts` | WIP-locale filtering per mode + operator override |
| `languages-gating.test.ts` | e2e WIP-locale gate (hidden in `live` unless enabled) |
| `telemetry.test.ts` | Anonymous stats: wall-time aggregation, fire-and-forget send |
| `e2e-gates.test.ts` | Full-stack admin gate + lunch lock flows |
| `e2e-mock-autoplay.test.ts` | Full 39-stage auto-play run in mock |
| `e2e-mock-forward-goto.test.ts` | DevPanel goto preserves captures + cache |
| `e2e-mock-press-enter.test.ts` | Press-Enter-to-continue stages advance |

**`packages/frontend`** - only the pure helpers that don't need a DOM.

| File | What it pins |
|---|---|
| `ssh-console.test.ts` | Tab-completion + `classifyPingLine` (timeout → fail, 0% loss → pass) |

The React components, typewriter, and polling loop aren't unit-tested; they're thin views over state whose HTTP contract is covered by the route + e2e tests.

## End-to-end (`e2e-gates.test.ts`)

Boots the complete app via `buildApp()` and drives both the player and the operator with `app.fetch()`. Covers the admin gate (player parks at a gated stage, admin unlocks, player flows through; re-locking can't drag a session backward) and the lunch lock (admin pauses all sessions global, unlocks, flow resumes; lunch lock survives a restart via DB-backed persistence).

## Not tested (on purpose)

- **Browser UI** - no Playwright / JSDOM. The components are thin views over tested state.
- **Live Nutanix API** - everything runs on the mock adapter. Live validation is manual via the auto-play harness (`POST /api/act/auto-play/:trigram`).
- **Stage prose** - the parser is tested, specific wording isn't; pack edits are caught at the next live pass.
