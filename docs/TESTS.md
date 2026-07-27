# TESTS.md - what is tested, how, and how to run

**TL;DR** - 329 tests across 28 files, all unit + integration, no browser. `bun test` from the repo root runs the lot in ~9 s. CI-friendly: no network, no DB on disk (in-memory SQLite), no real Nutanix calls (mock adapter).

```bash
bun test                                       # everything
bun test packages/server                       # one package
bun test packages/server/test/e2e-gates.test.ts  # one file
bun test --filter "lunch lock"                 # by name pattern
```

Typecheck the same coverage with `bunx tsc --noEmit -p packages/<pkg>` per package.

## Coverage by package

### `packages/engine` - pure logic, no I/O

The engine has zero external dependencies (no DB, no fetch, no fs at runtime), so its tests are fast and exhaustive.

| File | Lines validated | What it pins |
|---|---|---|
| `message-parser.test.ts` | JSX-like tag grammar | `{Var}` substitution, `<pause/>`, `<input var=…/>`, `<a href=…/>`, color/style stacking, escaping rules |
| `stage-runner.test.ts` | Stage rendering + ordering | next-stage gating, locale fallback, double-newline avoidance, await-input index |
| `capability-gate.test.ts` | Per-stage gate verdicts | inactive / already-passed / missing-capability / destructive-on-shared / missing-upstream - all four `disabled` reasons |
| `variables.test.ts` | The `Variables` store | get/set/delete, listener notifications, snapshot shape, missing-key behaviour |
| `lcm-updates.test.ts` | LCM update counting | `dedupedUpdateCount` + `isReadingSettled` - the stage-29 counting rules |

### `packages/nutanix` - transport adapters

Mocks vs. live REST, capability probing.

| File | What it pins |
|---|---|
| `mock-adapter.test.ts` | Fixture matching (method + path), error message on miss, the SDK envelope shim, the per-session overlay filter (`<action name='deleteVM'/>` removes the entity from subsequent GETs) |
| `rest-adapter.test.ts` | Basic auth + JSON headers, TLS toggle (`NUTANIX_VERIFY_SSL`), non-2xx → typed `NutanixHttpError`, GET-only 5xx retry, transport error wrapping |
| `capability-probe.test.ts` | All four capability flags (NCM / IO / CalmDSL / NodeRemove) detected on healthy responses; reachability failures degrade gracefully (probe never throws) |

### `packages/server` - HTTP + DB + service layer

The bulk of the suite. Each test file boots an in-memory SQLite + Hono router for the routes under test, then drives via `app.fetch()` (= same path the browser hits in production).

| File | What it pins |
|---|---|
| `session-service.test.ts` | The whole gameplay state machine - advance, awaiting input, capture+substitute, destructive gating, `skipTo`, `sentences.{ok,ko,retry}-*` cheers, `<action/>` dispatch + mock overlay, retry-from-variable rewind, `computeGreeting`, `switchTo` re-auth path, `invalidates`, **adminGate** (4 tests), **lunch lock** (2 tests, DB-backed persistence covered) |
| `admin.test.ts` | `/api/admin/*` - login, users (with PIN, scoped to packId), delete cascade, gates list + unlock/lock, pack editor toggles, lunch status |
| `check-trigram.test.ts` | Shape validation (length, charset) + collision logic via `SessionDirectory` (returning-agent re-auth path) |
| `dep-analysis.test.ts` | The cascade-disable preview: which downstream stages break when an upstream producer is turned off (env-seeded vars treated as always-available) |
| `scoreboard.test.ts` | Sort, anonymous pre-stage filtering, anti-leak of placeholder UUIDs, packId scoping, duplicate trigrams |
| `cluster-profile.test.ts` | Auto-detection (10.x → dedicated, generic → shared) + explicit override |
| `ssh.test.ts` | `/api/ssh/ping` argv validation (no shell, no leading dash) + tcp probe error remapping |
| `auto-fill-current.test.ts` | `POST /auto-fill-current` in mock - auto-fillable vars (NodeSerial, NumberUpdates, Runway…) resolve instead of submitting a placeholder |
| `cluster-config-probe.test.ts` | The cached LCM update count stage 29 judges against - refreshed when LCM is quiet, never while an inventory rebuilds the list |
| `pack-helpers.test.ts` | Stage-29 verdict deferral window after an LCM inventory (PC clock vs ours drift) |
| `pack-integrity.test.ts` | Pack invariants that silently rotted before - dependency-audit orphan detection, fixture placeholders resolving without removed captured vars |
| `recovery-point-action.test.ts` | Recovery-point `<action/>` wiring - the POST actually fires |
| `effective-locales.test.ts` | `effectiveSupportedLocales` - WIP-locale filtering per mode + operator override |
| `languages-gating.test.ts` | e2e WIP-locale gate - hidden from `live` players unless operator-enabled, always visible in `mock`/`test` |
| `telemetry.test.ts` | Anonymous usage stats - stage wall-time aggregation, fire-and-forget send path |
| `e2e-gates.test.ts` | Full-stack admin gate + lunch lock flows - see below |
| `e2e-mock-autoplay.test.ts` | Full 39-stage auto-play run in mock - every stage advances end-to-end |
| `e2e-mock-forward-goto.test.ts` | DevPanel forward goto - jumping ahead preserves captures + cluster cache |
| `e2e-mock-press-enter.test.ts` | Press-Enter-to-continue stages advance without input |

### `packages/frontend` - pure utilities

Frontend tests are intentionally narrow: only the pure helpers that don't need a DOM.

| File | What it pins |
|---|---|
| `ssh-console.test.ts` | Tab-completion against the command registry + `classifyPingLine` (`Request timed out` → fail, `0% packet loss` → pass) - drives the SSH console's color decisions |

React components, the typewriter, the auto-play toggle, the polling loop - **not unit-tested**. The end-to-end path is covered indirectly: the full HTTP contract these components rely on is exercised in `e2e-gates.test.ts` and the admin/session route tests.

## End-to-end gate tests *(`packages/server/test/e2e-gates.test.ts`)*

These are full-stack integration tests: they boot the **complete Hono app** via `buildApp()`, then drive both the player session and the operator with `app.fetch()` - the same code path the browser hits. They validate the contract that `useSession`'s polling loop and `AdminPage`'s gates panel rely on.

### Admin gate on a stage *(2 tests)*

Pack: 3 stages, middle one has `adminGate: true`.

1. **player hits gated stage → admin unlocks → player flows through**
   - First advance plays the intro narrative (`kind: 'units'`).
   - Second advance returns `kind: 'gated', gatedReason: 'stage', stageName: 'checkpoint'` - the discriminator the frontend banner reads.
   - Admin GETs `/api/admin/gates` → sees the locked entry with `arrivedCount: 1`.
   - Repeated advances stay gated (the polling loop is safe to spam - no `currentStage` mutation).
   - Admin POSTs `/gates/checkpoint/unlock` → 200.
   - Next advance flows into `checkpoint`, the one after into `finale`.

2. **admin re-locking after unlock parks subsequent sessions at the same gate**
   - Session A passes through after admin unlocks.
   - Admin re-locks; a fresh session B hits the gate.
   - Session A's `currentStage` is unaffected - re-locking can't drag a session backward.

### Lunch lock (pack-wide pause) *(2 tests)*

3. **admin locks → all sessions gate global → admin unlocks → flow resumes**
   - Two players in flight, both advancing normally.
   - Admin POSTs `/api/admin/lunch/lock`. Status endpoint reports `paused: true, affectedCount ≥ 2`.
   - Both sessions' next advance returns `kind: 'gated', gatedReason: 'global', stageName: undefined` - the frontend banner swaps copy/icon based on the `'global'` discriminator.
   - Admin POSTs `/lunch/unlock`. Sessions resume - but session A then parks at the per-stage gate (lunch lock doesn't override stage gates).

4. **lunch lock survives a process restart**
   - Confirms `/api/admin/lunch` returns `paused: true` after engagement (DB-backed persistence - the cross-process side is covered separately by `session-service.test.ts:927+` using a shared db).

## What is NOT tested

Deliberate gaps, listed so reviewers don't expect them:

- **Browser UI** - no Playwright / no JSDOM React-component tests. The faux-terminal typewriter, the auto-play toggle, the admin pages render correctly *in our hands* but aren't pinned in CI. Risk is low because the components are thin views over well-tested state (the contract they bind to IS covered).
- **Live Nutanix API** - every test runs against the mock adapter. Live validation is exercised manually via the auto-play harness (`POST /api/act/auto-play/:trigram`) against a real Prism Central.
- **Prompt/locale wording** - the parser and substitution machinery is tested, but specific stage prose isn't asserted character-for-character. Pack edits are caught at the next live validation pass, not in CI.
- **The frontend's polling loop timing** - `useSession`'s 3 s `setInterval` while gated is logic that could in theory be unit-tested with fake timers; it isn't, because the cost (mocking `useEffect` + timers + fetch) outweighs the value (the loop is six lines, the contract it's polling against IS pinned by `e2e-gates.test.ts`).
- **Auto-play act-current end-to-end** - the act handlers are exercised by the live auto-play harness against a real cluster. Not in CI because acts are intrinsically I/O against Prism Central.
