/**
 * End-to-end smoke test of the full ntnx-infiltration pack against the mock
 * Nutanix adapter. Loads the real `packs/ntnx-infiltration` from disk
 * (39 stages, 25 check functions, ~24 acts, full locale + fixture set),
 * boots the Hono app, and fires the `/auto-play/:trigram` admin endpoint.
 *
 * What this catches that unit tests don't:
 *   - **Pack-level wiring** — `pack.json` order, `needs`/`captures` chain,
 *     stage→act registration, check→fixture key shape (mock-adapter throws
 *     `No mock fixture for "..."` if a check hits an unrecorded path).
 *   - **Cross-stage variable flow** — captured vars propagate through the
 *     auto-play context so downstream stages see them.
 *   - **Act idempotency** — re-firing the same act on a refreshed mock
 *     overlay state must not break the chain.
 *
 * Live cluster transports (`MODE=test|live`) are explicitly out of scope —
 * this test validates the offline fixture-backed path that CI runs on every
 * push. A live HPoC end-to-end remains a manual deploy.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockAdapter } from '@ntnx-game/nutanix';
import { buildApp } from '../src/app';
import { loadPack } from '../src/pack-loader';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(resolve(HERE, '../src/db/schema.sql'), 'utf8');
const PACKS_DIR = resolve(HERE, '../../../packs');

const ADMIN_PW = 'test-pw';
// Trigram chosen to avoid path-substring collisions with Nutanix v3/v4
// API segments (`auth`, `iam`, `vmm`, `api`, `vpcs`, …). The mock
// adapter's deinterpolatePath does a global string replace `<trigram>`
// → `{Trigram}` to match templated fixture keys; a trigram that's a
// substring of a real path word would break path resolution.
const TRIGRAM = 'xy9';

interface AutoPlaySummary {
  passed: number;
  failed: number;
  noCheck: number;
  skipped: number;
  actErrors: number;
}
interface AutoPlayResult {
  stage: string;
  acted: boolean;
  actError?: string;
  checkStatus: 'pass' | 'fail' | 'skipped' | 'no-check';
  checkDetail?: string;
  durationMs: number;
}
interface AutoPlayResponse {
  ok: boolean;
  trigram: string;
  summary: AutoPlaySummary;
  results: AutoPlayResult[];
}

async function bootApp() {
  const pack = await loadPack(PACKS_DIR, 'ntnx-infiltration');
  // Auto-play goes through `act.ts:makeContext` which wraps the boot
  // client with `withVariableInterpolation` per-call against its own
  // var store, so we don't need to wrap here. `withMockOverlay`
  // is session-scoped + only relevant on the in-game `<action/>`
  // dispatch path, not on auto-play.
  const baseClient = createMockAdapter(
    resolve(PACKS_DIR, 'ntnx-infiltration', 'fixtures.json'),
  );

  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const { app } = buildApp({
    db,
    pack,
    nutanix: baseClient,
    clusterEndpoint: '',
    clusterProfile: 'hpoc',
    capabilities: ['CalmDSL', 'NodeRemove', 'MultiNode', 'ApprovalPolicy'],
    adminPassword: ADMIN_PW,
    initialVariables: {
      // Same defaults the real boot wires for mock parity. Acts read
      // these off the ActContext; without them stage 6 / 11 / etc.
      // would fail constructing passwords / users / image URLs.
      PC: 'mock-pc',
      PCUser: 'admin',
      PCPassword: 'unused-in-mock',
      Vlanid: '42',
      ImageURL: 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img',
    },
    serverMode: 'mock',
  });
  return { app };
}

describe('e2e — mock auto-play (full pack)', () => {
  test('walks all 39 stages with no act errors and no check failures', async () => {
    const { app } = await bootApp();
    // Pre-populate the named-input vars that have no act (NodeSerial /
    // NumberUpdates / Runway) so their checks get exercised against the
    // recorded fixtures rather than skipped. Values match the canned
    // mock branches in `lookupRunway` + the rackable-units fixture.
    const r = await app.request(`/api/act/auto-play/${TRIGRAM}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Password': ADMIN_PW,
      },
      body: JSON.stringify({
        vars: {
          // PIN is normally captured via `<input/>` at stage 2 — the
          // standalone auto-play harness has no input source so the
          // operator pre-supplies. 4-digit format matches CheckTrigram.
          PIN: '4242',
          Username: 'AutoPlay',
          // Pure-input vars at stages 28 / 29 / 31 (NodeSerial /
          // NumberUpdates / Runway) — the player would type these.
          // Values match the canned mock-branch in `lookupRunway` +
          // the discover-unconfigured-nodes task-response fixture.
          NodeSerial: 'AB12345DEMO',
          NumberUpdates: '4',
          Runway: '120',
        },
        // Speed up the mock loop: no eventual-consistency lag in
        // fixture-backed mode, retries are pure waste.
        maxRetries: 0,
        retryDelayMs: 0,
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as AutoPlayResponse;
    expect(body.ok).toBe(true);
    expect(body.trigram).toBe(TRIGRAM);

    // Pin the stage count: regression triggers if we add/remove a stage
    // without realizing it. `STAGES.md` documents the canonical 39.
    expect(body.results.length).toBe(39);

    // Some acts reach for the player's HPoC over the network (SSH probe
    // for the microseg policy stage), which mock fixtures can't simulate
    // — they're allowed to ERR. The watermark below catches the case
    // where a real regression silently inflates this list.
    const KNOWN_MOCK_INCOMPAT = new Set([
      'allow-ssh-in-microseg', // act fires a real fetch() to confirm the policy blocks SSH; no cluster
    ]);

    const actFailures = body.results.filter(
      (r) => r.actError && !KNOWN_MOCK_INCOMPAT.has(r.stage),
    );
    const checkFailures = body.results.filter((r) => r.checkStatus === 'fail');

    if (actFailures.length > 0 || checkFailures.length > 0) {
      const lines = [
        ...actFailures.map(
          (r) => `  ${r.stage}: act ERR: ${r.actError}`,
        ),
        ...checkFailures.map(
          (r) =>
            `  ${r.stage}: check ${r.checkStatus}: ${r.checkDetail ?? '(no detail)'}`,
        ),
      ];
      throw new Error(
        `auto-play regressed: ${checkFailures.length} check fail(s) + ${actFailures.length} unexpected act error(s)\n` +
          lines.join('\n'),
      );
    }

    expect(checkFailures.length).toBe(0);
    expect(actFailures.length).toBe(0);

    // Sanity watermark: at least 20 check-bearing stages should pass on
    // a healthy mock walk. Below that, something's silently filtering
    // everything to `skipped` — likely a broken mock context wiring.
    if (body.summary.passed < 20) {
      const breakdown = body.results
        .map(
          (r) =>
            `  ${r.stage.padEnd(28)} ${r.checkStatus}${r.acted ? ' (acted)' : ''}`,
        )
        .join('\n');
      throw new Error(
        `only ${body.summary.passed}/39 stages passed check. Full breakdown:\n${breakdown}`,
      );
    }
    expect(body.summary.passed).toBeGreaterThanOrEqual(20);
  }, 120_000); // generous deadline — full walk is ~5-10 s in mock, retries can stretch
});
