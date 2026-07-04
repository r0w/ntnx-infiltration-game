import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRegistry,
  CheckRegistry,
  StageRunner,
  makeBundle,
  type LocaleBundle,
  type NutanixClient,
  type StageDefinition,
} from '@ntnx-game/engine';
import {
  AttemptQueries,
  ClusterCacheQueries,
  HistoryQueries,
  MockOverlayQueries,
  VariableQueries,
} from '../src/db/queries';
import {
  buildAdminRoutes,
  type AdminGateEntry,
  type AdminLunchStatus,
  type AdminPackPayload,
  type AdminPackTogglePreview,
  type AdminUserEntry,
} from '../src/routes/admin';
import { SessionService } from '../src/session-service';
import type { LoadedPack } from '../src/pack-loader';

const SCHEMA = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql'),
  'utf8',
);

const PACK_ID = 'test-pack';
const ADMIN_PW = 'test-pw';

// Ids are 0-based to mirror what pack-loader assigns in production
// (parsed.id = i). Several admin route paths key arrival/positional math off
// `stage.id` directly, so the fixtures need to be consistent with that.
const stages: StageDefinition[] = [
  { id: 0, name: 'login', active: true, messages: ['s1'], saveScore: false },
  { id: 1, name: 'intro', active: true, messages: ['s2'], saveScore: false },
  { id: 2, name: 'outro', active: true, messages: ['s3'], saveScore: false },
];

const bundle: LocaleBundle = makeBundle('en', {
  en: { s1: 'one', s2: 'two', s3: 'three' },
});

function fakePack(stageOverride?: StageDefinition[]): LoadedPack {
  return {
    manifest: {
      id: PACK_ID,
      name: 'Test pack',
      version: '0.0.0',
      checks: './checks',
      stages: './stages',
      defaultLocale: 'en',
      supportedLocales: ['en'],
    },
    dir: '/tmp/fake-pack',
    stages: stageOverride ?? stages,
    checks: new CheckRegistry(),
    actions: new ActionRegistry(),
    bundle,
  };
}

const noopNutanix: NutanixClient = {
  mode: 'mock',
  async request() {
    throw new Error('noop client — not used in these tests');
  },
};
const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};

function makeService(db: Database, pack: LoadedPack): SessionService {
  return new SessionService({
    db,
    runner: new StageRunner(pack.stages, pack.checks),
    nutanix: noopNutanix,
    logger: silentLogger,
    packId: pack.manifest.id,
    bundle: pack.bundle,
  });
}

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function seedSession(db: Database, input: {
  id: string;
  trigram?: string;
  username?: string;
  pin?: string;
  /** Last-completed stage name; `null`/undefined = pre-game. */
  currentStage?: string | null;
  finishedAt?: number | null;
  startedAt?: number;
  packId?: string;
}): void {
  db.prepare(
    `INSERT INTO sessions (id, trigram, pin_hash, pack_id, current_stage, started_at, finished_at, locale, cluster_endpoint, cluster_profile, capabilities_json)
     VALUES ($id, $id, '', $pack, $stage, $started, $finished, 'en', '', 'other', '[]')`,
  ).run({
    $id: input.id,
    $pack: input.packId ?? PACK_ID,
    $stage: input.currentStage ?? null,
    $started: input.startedAt ?? Date.now(),
    $finished: input.finishedAt ?? null,
  });
  const vars = new VariableQueries(db);
  if (input.trigram !== undefined) vars.upsert(input.id, 'Trigram', input.trigram, 'seed');
  if (input.username !== undefined) vars.upsert(input.id, 'Username', input.username, 'seed');
  if (input.pin !== undefined) vars.upsert(input.id, 'PIN', input.pin, 'seed');
}

function router(db: Database, pack: LoadedPack = fakePack()) {
  const service = makeService(db, pack);
  return buildAdminRoutes({ db, pack, adminPassword: ADMIN_PW, service, nutanix: noopNutanix, clusterProfile: 'hpoc', pcEndpoint: '' });
}

describe('POST /api/admin/login', () => {
  test('wrong password → 401', async () => {
    const r = await router(freshDb()).request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    });
    expect(r.status).toBe(401);
  });

  test('correct password → 200 ok', async () => {
    const r = await router(freshDb()).request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PW }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test('missing body → 401 (no TypeError leak)', async () => {
    // onError middleware in app.ts wraps HttpError; here we just hit the
    // router directly so we expect the thrown 401 to surface via Hono's
    // default handling. What matters is we don't 500 on an empty JSON body.
    const r = await router(freshDb()).request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    expect([400, 401]).toContain(r.status);
  });
});

describe('GET /api/admin/users', () => {
  test('without header → 401', async () => {
    const r = await router(freshDb()).request('/users');
    expect(r.status).toBe(401);
  });

  test('with wrong header → 401', async () => {
    const r = await router(freshDb()).request('/users', {
      headers: { 'X-Admin-Password': 'wrong' },
    });
    expect(r.status).toBe(401);
  });

  test('with correct header → entries include PIN (unlike scoreboard)', async () => {
    const db = freshDb();
    seedSession(db, {
      id: 'sess-1', trigram: 'RBO', username: 'Rowien', pin: '1234', currentStage: 'intro',
    });
    const r = await router(db).request('/users', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: AdminUserEntry[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].trigram).toBe('RBO');
    expect(body.entries[0].username).toBe('Rowien');
    expect(body.entries[0].pin).toBe('1234');
    // currentStage = 'intro' → next stage is 'outro'.
    expect(body.entries[0].nextStageName).toBe('outro');
  });

  test('scopes to packId (other pack sessions invisible)', async () => {
    const db = freshDb();
    seedSession(db, {
      id: 'sess-mine', trigram: 'MIN', pin: '1111', packId: PACK_ID,
    });
    seedSession(db, {
      id: 'sess-other', trigram: 'OTH', pin: '2222', packId: 'some-other-pack',
    });
    const r = await router(db).request('/users', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    const body = (await r.json()) as { entries: AdminUserEntry[] };
    expect(body.entries.map((e) => e.sessionId)).toEqual(['sess-mine']);
  });

  test('failed check on the stage being played → lastFail surfaced', async () => {
    const db = freshDb();
    seedSession(db, { id: 'sess-f', trigram: 'FAI', pin: '1234', currentStage: 'login' });
    // Player is playing 'intro' (login done) and just failed its check.
    new HistoryQueries(db).record('sess-f', 'intro', 'failed', 120, "VM 'fai-vm' has 1 NIC(s) (expected 2).");
    const r = await router(db).request('/users', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    const body = (await r.json()) as { entries: AdminUserEntry[] };
    expect(body.entries[0].lastFail).toEqual({
      stage: 'intro',
      detail: "VM 'fai-vm' has 1 NIC(s) (expected 2).",
      at: expect.any(Number),
    });
  });

  test('stage passes → lastFail clears (history row flips to passed)', async () => {
    const db = freshDb();
    seedSession(db, { id: 'sess-p', trigram: 'PAS', pin: '1234', currentStage: 'login' });
    const history = new HistoryQueries(db);
    history.record('sess-p', 'intro', 'failed', 120, 'missing NIC');
    history.record('sess-p', 'intro', 'passed', 80, 'all good');
    const r = await router(db).request('/users', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    const body = (await r.json()) as { entries: AdminUserEntry[] };
    expect(body.entries[0].lastFail).toBeNull();
  });

  test('fail past a per-session disabled stage → lastFail still surfaced', async () => {
    const db = freshDb();
    // 'intro' was disabled for this session (missing vars / capability), so
    // the player is actually playing 'outro' even though nextStageName says
    // 'intro'. The fail on 'outro' must still show.
    seedSession(db, { id: 'sess-d', trigram: 'DIS', pin: '1234', currentStage: 'login' });
    const history = new HistoryQueries(db);
    history.record('sess-d', 'intro', 'disabled', null, 'missing upstream vars: Username');
    history.record('sess-d', 'outro', 'failed', 90, 'Subnet not found.');
    const r = await router(db).request('/users', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    const body = (await r.json()) as { entries: AdminUserEntry[] };
    expect(body.entries[0].lastFail?.stage).toBe('outro');
  });

  test('fail on a stage the player moved past (admin skip) → lastFail null', async () => {
    const db = freshDb();
    // Failed 'intro', then the operator skipped it: currentStage jumps to
    // 'intro' (playing 'outro') but the 'failed' row is never rewritten.
    seedSession(db, { id: 'sess-s', trigram: 'SKP', pin: '1234', currentStage: 'intro' });
    new HistoryQueries(db).record('sess-s', 'intro', 'failed', 120, 'missing NIC');
    const r = await router(db).request('/users', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    const body = (await r.json()) as { entries: AdminUserEntry[] };
    expect(body.entries[0].nextStageName).toBe('outro');
    expect(body.entries[0].lastFail).toBeNull();
  });

  test('finished session → nextStageName null, pin preserved', async () => {
    const db = freshDb();
    seedSession(db, {
      id: 'sess-done', trigram: 'DON', pin: '9999',
      currentStage: 'outro', finishedAt: Date.now(),
    });
    const r = await router(db).request('/users', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    const body = (await r.json()) as { entries: AdminUserEntry[] };
    expect(body.entries[0].finishedAt).not.toBeNull();
    expect(body.entries[0].nextStageName).toBeNull();
    expect(body.entries[0].pin).toBe('9999');
  });
});

describe('GET /api/admin/attempts', () => {
  test('without header → 401', async () => {
    const r = await router(freshDb()).request('/attempts');
    expect(r.status).toBe(401);
  });

  test('returns attempts newest-first with trigram joined, scoped to pack', async () => {
    const db = freshDb();
    seedSession(db, { id: 'sess-a', trigram: 'AAA', pin: '1111', currentStage: 'login' });
    seedSession(db, { id: 'sess-x', trigram: 'XXX', pin: '2222', packId: 'other-pack' });
    const attempts = new AttemptQueries(db);
    attempts.record('sess-a', 'intro', 'failed', 120, 'missing NIC');
    attempts.record('sess-a', 'intro', 'passed', 90, 'all good');
    attempts.record('sess-x', 'intro', 'failed', 50, 'invisible (other pack)');
    const r = await router(db).request('/attempts', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: Array<{ trigram: string | null; status: string; detail: string | null }> };
    expect(body.entries).toHaveLength(2);
    // Same-millisecond inserts fall back to id DESC — newest insert first.
    expect(body.entries[0].status).toBe('passed');
    expect(body.entries[1].status).toBe('failed');
    expect(body.entries.every((e) => e.trigram === 'AAA')).toBe(true);
  });

  test('respects ?limit=', async () => {
    const db = freshDb();
    seedSession(db, { id: 'sess-l', trigram: 'LIM', pin: '1111' });
    const attempts = new AttemptQueries(db);
    for (let i = 0; i < 5; i++) attempts.record('sess-l', 'intro', 'failed', 10, `try ${i}`);
    const r = await router(db).request('/attempts?limit=2', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    const body = (await r.json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(2);
  });

  test('session delete cascades its attempts', async () => {
    const db = freshDb();
    seedSession(db, { id: 'sess-c', trigram: 'CAS', pin: '1111' });
    new AttemptQueries(db).record('sess-c', 'intro', 'failed', 10, 'x');
    await router(db).request('/users/sess-c', {
      method: 'DELETE',
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    const left = db.prepare('SELECT COUNT(*) AS n FROM check_attempts').get() as { n: number };
    expect(left.n).toBe(0);
  });
});

describe('DELETE /api/admin/users/:id', () => {
  test('without header → 401', async () => {
    const r = await router(freshDb()).request('/users/any', { method: 'DELETE' });
    expect(r.status).toBe(401);
  });

  test('unknown sessionId → 404', async () => {
    const r = await router(freshDb()).request('/users/nope', {
      method: 'DELETE',
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(r.status).toBe(404);
  });

  test('cascades: deletes session + variables + history + cache + overlay', async () => {
    const db = freshDb();
    seedSession(db, {
      id: 'sess-victim', trigram: 'VIC', username: 'Victim', pin: '1234',
      currentStage: 'login',
    });
    // Seed some child rows explicitly so cascade can be observed.
    new HistoryQueries(db).record('sess-victim', 'login', 'passed', 42, null);
    new ClusterCacheQueries(db).set('sess-victim', {
      kind: 'vm', logicalName: 'vic-vm', uuid: 'uuid-1',
    });
    new MockOverlayQueries(db).mark('sess-victim', 'vm', 'vic-vm', 'deleted');

    const r = await router(db).request('/users/sess-victim', {
      method: 'DELETE',
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(r.status).toBe(200);

    // Session gone:
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get('sess-victim'),
    ).toEqual({ n: 0 });
    // Cascades gone:
    for (const table of [
      'session_variables',
      'stage_history',
      'cluster_cache',
      'session_mock_overlay',
    ]) {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`)
        .get('sess-victim') as { n: number };
      expect(row.n).toBe(0);
    }
  });

  test('does not affect sibling sessions', async () => {
    const db = freshDb();
    seedSession(db, { id: 'sess-keep', trigram: 'KEP', pin: '1111' });
    seedSession(db, { id: 'sess-gone', trigram: 'GON', pin: '2222' });
    await router(db).request('/users/sess-gone', {
      method: 'DELETE',
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    const r = await router(db).request('/users', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    const body = (await r.json()) as { entries: AdminUserEntry[] };
    expect(body.entries.map((e) => e.sessionId)).toEqual(['sess-keep']);
  });
});

describe('GET /api/admin/gates', () => {
  // Use a pack where stages 2 and 3 are gated; stage 1 is the entry point
  // (player has currentStage = null or 'login' after lore). 0-based ids
  // mirror pack-loader.
  const gatedStages: StageDefinition[] = [
    { id: 0, name: 'login', active: true, messages: ['s1'], saveScore: false },
    { id: 1, name: 'first-task', active: true, adminGate: true, messages: ['s2'], saveScore: false },
    { id: 2, name: 'incident', active: true, adminGate: true, messages: ['s3'], saveScore: false },
  ];

  test('lists only stages with adminGate=true; both unlocked=false initially with empty arrival data', async () => {
    const db = freshDb();
    const r = await router(db, fakePack(gatedStages)).request('/gates', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: AdminGateEntry[] };
    expect(body.entries.map((e) => e.stageName)).toEqual(['first-task', 'incident']);
    expect(body.entries.every((e) => !e.unlocked)).toBe(true);
    expect(body.entries.every((e) => e.unlockedAt === null)).toBe(true);
    expect(body.entries.every((e) => e.totalActive === 0)).toBe(true);
    expect(body.entries.every((e) => e.arrivedCount === 0)).toBe(true);
    expect(body.entries.every((e) => e.arrivedTrigrams.length === 0)).toBe(true);
  });

  test('arrivedCount = sessions past the preceding stage (includes awaiting and past), excludes finished', async () => {
    const db = freshDb();
    // 4 active sessions at varying progression + 1 finished one we should ignore.
    seedSession(db, { id: 's-A', trigram: 'aaa', currentStage: 'login' }); // about to hit gate 'first-task'
    seedSession(db, { id: 's-B', trigram: 'bbb', currentStage: 'login' });
    seedSession(db, { id: 's-C', trigram: 'ccc', currentStage: 'first-task' }); // past 'first-task', about to hit 'incident'
    seedSession(db, { id: 's-D', trigram: 'ddd', currentStage: 'incident' }); // past 'incident'
    seedSession(db, { id: 's-fin', trigram: 'fff', currentStage: 'incident', finishedAt: 1 });
    // Awaiting state on s-B — does NOT exclude from "arrived" semantic.
    db.prepare(
      `UPDATE sessions SET awaiting_variable='X', awaiting_stage='login', awaiting_render_offset=0 WHERE id='s-B'`,
    ).run();
    const r = await router(db, fakePack(gatedStages)).request('/gates', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    const body = (await r.json()) as { entries: AdminGateEntry[] };
    const byName = new Map(body.entries.map((e) => [e.stageName, e]));
    // Gate 'first-task' (index 1) needs position >= 0 → A, B, C, D all qualify (4 of 4 active).
    expect(byName.get('first-task')?.totalActive).toBe(4);
    expect(byName.get('first-task')?.arrivedCount).toBe(4);
    expect(byName.get('first-task')?.arrivedTrigrams).toEqual(['aaa', 'bbb', 'ccc', 'ddd']);
    // Gate 'incident' (index 2) needs position >= 1 → C, D only (2 of 4).
    expect(byName.get('incident')?.arrivedCount).toBe(2);
    expect(byName.get('incident')?.arrivedTrigrams).toEqual(['ccc', 'ddd']);
  });

  test('unlock flips state; lock reverts; non-gated stage rejected with 400', async () => {
    const db = freshDb();
    const pack = fakePack(gatedStages);
    const buildRouter = () => {
      // Reuse the same router (and thus the same SessionService instance) so
      // the in-memory unlock set is consistent across requests within this
      // test. Spinning a fresh router would also re-read the DB so behaviour
      // is identical, but a single instance mirrors production wiring better.
      const service = makeService(db, pack);
      return buildAdminRoutes({ db, pack, adminPassword: ADMIN_PW, service, nutanix: noopNutanix, clusterProfile: 'hpoc', pcEndpoint: '' });
    };
    const r1 = buildRouter();
    let res = await r1.request('/gates/first-task/unlock', {
      method: 'POST',
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stageName: 'first-task', unlocked: true });

    res = await r1.request('/gates', { headers: { 'X-Admin-Password': ADMIN_PW } });
    let body = (await res.json()) as { entries: AdminGateEntry[] };
    const g2 = body.entries.find((e) => e.stageName === 'first-task');
    expect(g2?.unlocked).toBe(true);
    expect(typeof g2?.unlockedAt).toBe('number');

    res = await r1.request('/gates/first-task/lock', {
      method: 'POST',
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(200);
    res = await r1.request('/gates', { headers: { 'X-Admin-Password': ADMIN_PW } });
    body = (await res.json()) as { entries: AdminGateEntry[] };
    expect(body.entries.find((e) => e.stageName === 'first-task')?.unlocked).toBe(false);

    // Stage 'login' has no adminGate → 400.
    res = await r1.request('/gates/login/unlock', {
      method: 'POST',
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(400);

    // Unknown stage → 404.
    res = await r1.request('/gates/nope-nope/unlock', {
      method: 'POST',
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(404);
  });

  test('gates ordered by tier: locked+all-arrived → locked+partial → locked+none → unlocked', async () => {
    const db = freshDb();
    // 0-based ids to mirror pack-loader. Gates at positions 1, 3, 5, 7.
    const fourGates: StageDefinition[] = [
      { id: 0, name: 'login', active: true, messages: ['s1'], saveScore: false },
      { id: 1, name: 'pre',   active: true, adminGate: true, messages: ['s2'], saveScore: false },
      { id: 2, name: 'mid-A', active: true, messages: ['s3a'], saveScore: false },
      { id: 3, name: 'all',   active: true, adminGate: true, messages: ['s4'], saveScore: false },
      { id: 4, name: 'mid-B', active: true, messages: ['s5b'], saveScore: false },
      { id: 5, name: 'some',  active: true, adminGate: true, messages: ['s6'], saveScore: false },
      { id: 6, name: 'mid-C', active: true, messages: ['s7c'], saveScore: false },
      { id: 7, name: 'none',  active: true, adminGate: true, messages: ['s8'], saveScore: false },
    ];
    // 2 sessions: A advanced further than B.
    // positionOf(currentStage) must be >= gateIdx - 1.
    // For gate 'pre' (id 1): need pos >= 0 — both A and B qualify.
    // For gate 'all' (id 3): need pos >= 2 — both qualify.
    // For gate 'some' (id 5): need pos >= 4 — only A qualifies.
    // For gate 'none' (id 7): need pos >= 6 — neither qualifies.
    seedSession(db, { id: 's-A', trigram: 'aaa', currentStage: 'mid-B' }); // pos 4
    seedSession(db, { id: 's-B', trigram: 'bbb', currentStage: 'mid-A' }); // pos 2
    const pack = fakePack(fourGates);
    const service = makeService(db, pack);
    service.setGateUnlock('pre', true); // pre-unlock → tier 3
    const r = buildAdminRoutes({ db, pack, adminPassword: ADMIN_PW, service, nutanix: noopNutanix, clusterProfile: 'hpoc', pcEndpoint: '' });
    const res = await r.request('/gates', { headers: { 'X-Admin-Password': ADMIN_PW } });
    const body = (await res.json()) as { entries: AdminGateEntry[] };
    // → gate 'all' = 2/2 (tier 0), gate 'some' = 1/2 (tier 1), gate 'none' = 0/2 (tier 2),
    //   gate 'pre' = unlocked (tier 3).
    expect(body.entries.map((e) => e.stageName)).toEqual(['all', 'some', 'none', 'pre']);
  });

  test('without admin header → 401 on /gates and /gates/:name/unlock', async () => {
    const db = freshDb();
    const r = router(db, fakePack(gatedStages));
    expect((await r.request('/gates')).status).toBe(401);
    expect((await r.request('/gates/first-task/unlock', { method: 'POST' })).status).toBe(401);
  });

  test('gates list reads effective stages — overlay-enabled gate appears, overlay-cleared stage hides', async () => {
    const db = freshDb();
    // Pack with NO gate in JSON; we'll add one via overlay.
    const noGateStages: StageDefinition[] = [
      { id: 0, name: 'one', active: true, messages: ['s1'], saveScore: false },
      { id: 1, name: 'two', active: true, messages: ['s2'], saveScore: false },
    ];
    const pack = fakePack(noGateStages);
    const service = makeService(db, pack);
    const r = buildAdminRoutes({ db, pack, adminPassword: ADMIN_PW, service, nutanix: noopNutanix, clusterProfile: 'hpoc', pcEndpoint: '' });

    // Initially no stages are gated.
    let res = await r.request('/gates', { headers: { 'X-Admin-Password': ADMIN_PW } });
    expect(((await res.json()) as { entries: AdminGateEntry[] }).entries).toEqual([]);

    // Operator toggles adminGate=true on stage 'two' via the pack overlay.
    service.packOverlay.setField(PACK_ID, 'two', 'adminGate', true);
    service.applyEffectiveStages();

    res = await r.request('/gates', { headers: { 'X-Admin-Password': ADMIN_PW } });
    const body = (await res.json()) as { entries: AdminGateEntry[] };
    expect(body.entries.map((e) => e.stageName)).toEqual(['two']);

    // Unlock should accept the overlay-enabled gate (not just JSON ones).
    res = await r.request('/gates/two/unlock', {
      method: 'POST',
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(200);

    // Conversely: if a JSON-tagged gate is overridden to adminGate=false,
    // it should disappear from the gates listing.
    const jsonGatedPack = fakePack([
      { id: 0, name: 'one', active: true, adminGate: true, messages: ['s1'], saveScore: false },
    ]);
    const db2 = freshDb();
    const service2 = makeService(db2, jsonGatedPack);
    const r2 = buildAdminRoutes({ db: db2, pack: jsonGatedPack, adminPassword: ADMIN_PW, service: service2, nutanix: noopNutanix, clusterProfile: 'hpoc', pcEndpoint: '' });
    res = await r2.request('/gates', { headers: { 'X-Admin-Password': ADMIN_PW } });
    expect(((await res.json()) as { entries: AdminGateEntry[] }).entries.map((e) => e.stageName)).toEqual(['one']);

    service2.packOverlay.setField(PACK_ID, 'one', 'adminGate', false);
    service2.applyEffectiveStages();
    res = await r2.request('/gates', { headers: { 'X-Admin-Password': ADMIN_PW } });
    expect(((await res.json()) as { entries: AdminGateEntry[] }).entries).toEqual([]);
  });
});

describe('GET /api/admin/pack', () => {
  // Pack with: stage 1 captures ProjectUUID, stage 2 needs it, stage 3
  // standalone. Lets us exercise the broken-cascade path when we disable 1.
  const packStages: StageDefinition[] = [
    { id: 0, name: 'mk-project', active: true, messages: ['s1'], saveScore: false, captures: ['ProjectUUID'] },
    { id: 1, name: 'use-project', active: true, messages: ['s2'], saveScore: false, needs: ['ProjectUUID'] },
    { id: 2, name: 'standalone', active: true, messages: ['s3'], saveScore: false },
  ];

  test('lists every stage with effective active/adminGate, no broken when nothing is off', async () => {
    const db = freshDb();
    const res = await router(db, fakePack(packStages)).request('/pack', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminPackPayload;
    expect(body.stages.map((s) => s.stageName)).toEqual(['mk-project', 'use-project', 'standalone']);
    expect(body.brokenCount).toBe(0);
    expect(body.stages.every((s) => s.active)).toBe(true);
    expect(body.stages.every((s) => !s.activeOverridden)).toBe(true);
  });

  test('toggle persists + applyEffectiveStages → subsequent /pack reflects override + broken stage', async () => {
    const db = freshDb();
    // Single router instance so we share the same SessionService (and
    // therefore the same in-memory effective stages cache) across requests.
    const pack = fakePack(packStages);
    const service = makeService(db, pack);
    const r = buildAdminRoutes({ db, pack, adminPassword: ADMIN_PW, service, nutanix: noopNutanix, clusterProfile: 'hpoc', pcEndpoint: '' });

    let res = await r.request('/pack/stages/mk-project/toggle?field=active', {
      method: 'POST',
      headers: { 'X-Admin-Password': ADMIN_PW, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: false }),
    });
    expect(res.status).toBe(200);

    res = await r.request('/pack', { headers: { 'X-Admin-Password': ADMIN_PW } });
    const body = (await res.json()) as AdminPackPayload;
    const s1 = body.stages.find((s) => s.stageName === 'mk-project');
    const s2 = body.stages.find((s) => s.stageName === 'use-project');
    expect(s1?.active).toBe(false);
    expect(s1?.activeOverridden).toBe(true);
    // Stage 2 still active but flagged broken — its `needs: [ProjectUUID]`
    // can't be satisfied with stage 1 disabled.
    expect(s2?.active).toBe(true);
    expect(s2?.brokenMissingVars).toEqual(['ProjectUUID']);
    expect(body.brokenCount).toBe(1);
  });

  test('preview-disable returns the cascade list without mutating overlay', async () => {
    const db = freshDb();
    const r = router(db, fakePack(packStages));
    const res = await r.request('/pack/preview-disable/mk-project', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminPackTogglePreview;
    expect(body.requested).toBe('mk-project');
    expect(body.cascade.map((c) => c.stageName)).toEqual(['use-project']);
    expect(body.cascade[0].missingVars).toEqual(['ProjectUUID']);

    // Confirm the preview did NOT persist anything.
    const r2 = router(db, fakePack(packStages));
    const lookup = await r2.request('/pack', { headers: { 'X-Admin-Password': ADMIN_PW } });
    const body2 = (await lookup.json()) as AdminPackPayload;
    expect(body2.stages.find((s) => s.stageName === 'mk-project')?.active).toBe(true);
  });

  test('toggle on unknown field rejected with 400; unknown stage with 404', async () => {
    const db = freshDb();
    const r = router(db, fakePack(packStages));
    let res = await r.request('/pack/stages/mk-project/toggle?field=bogus', {
      method: 'POST',
      headers: { 'X-Admin-Password': ADMIN_PW, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: false }),
    });
    expect(res.status).toBe(400);

    res = await r.request('/pack/stages/nope-nope/toggle?field=active', {
      method: 'POST',
      headers: { 'X-Admin-Password': ADMIN_PW, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: false }),
    });
    expect(res.status).toBe(404);
  });

  test('clearing an override (value=null) restores the JSON default + drops the row', async () => {
    const db = freshDb();
    const pack = fakePack(packStages);
    const service = makeService(db, pack);
    const r = buildAdminRoutes({ db, pack, adminPassword: ADMIN_PW, service, nutanix: noopNutanix, clusterProfile: 'hpoc', pcEndpoint: '' });

    // Override active=false, then clear it.
    await r.request('/pack/stages/mk-project/toggle?field=active', {
      method: 'POST',
      headers: { 'X-Admin-Password': ADMIN_PW, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: false }),
    });
    await r.request('/pack/stages/mk-project/toggle?field=active', {
      method: 'POST',
      headers: { 'X-Admin-Password': ADMIN_PW, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: null }),
    });

    const res = await r.request('/pack', { headers: { 'X-Admin-Password': ADMIN_PW } });
    const body = (await res.json()) as AdminPackPayload;
    const s1 = body.stages.find((s) => s.stageName === 'mk-project');
    expect(s1?.active).toBe(true);
    expect(s1?.activeOverridden).toBe(false);
    // Sparse-row guarantee: clearing both fields drops the row entirely.
    const overlayRows = service.packOverlay.list(PACK_ID);
    expect(overlayRows).toEqual([]);
  });
});

describe('GET /api/admin/cluster-status', () => {
  test('without admin header → 401', async () => {
    const db = freshDb();
    const res = await router(db).request('/cluster-status');
    expect(res.status).toBe(401);
  });

  test('mock mode → intelligentOps state=null, enableUrl=null (no live calls)', async () => {
    // noopNutanix.mode === 'mock' → probe short-circuits, never hits request().
    const db = freshDb();
    const res = await router(db).request('/cluster-status', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { intelligentOps: { state: unknown; enableUrl: unknown } };
    expect(body.intelligentOps.state).toBeNull();
    expect(body.intelligentOps.enableUrl).toBeNull();
  });

  test('live mode → reflects PC enablementState + builds Prism deep-link', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const liveNutanix: NutanixClient = {
      mode: 'live',
      async request<T>(method: string, path: string): Promise<T> {
        calls.push({ method, path });
        if (path.startsWith('/api/prism/v4.2/config/domain-managers')) {
          return { data: [{ extId: 'pc-uuid-1' }] } as unknown as T;
        }
        if (path.includes('/products')) {
          return {
            data: [
              { name: 'NUTANIX_DISASTER_RECOVERY', enablementState: 'ENABLED' },
              { name: 'INTELLIGENT_OPERATIONS', enablementState: 'DISABLED' },
            ],
          } as unknown as T;
        }
        if (path === '/api/nutanix/v3/clusters/list') {
          return {
            entities: [
              {
                status: {
                  name: 'PC',
                  resources: {
                    config: { build: { version: '7.5.1' }, service_list: ['PRISM_CENTRAL'] },
                  },
                },
              },
              {
                status: {
                  name: 'DM3-POC004',
                  resources: { config: { build: { version: '7.5.1' }, service_list: ['AOS'] } },
                },
              },
            ],
          } as unknown as T;
        }
        if (path.startsWith('/api/lifecycle/v4.2/resources/entities')) {
          return {
            data: [
              // Duplicate PC row must be skipped (clusters list already covers it).
              { entityType: 'SOFTWARE', entityModel: 'PC', entityVersion: '7.5.1' },
              {
                entityType: 'SOFTWARE',
                entityModel: 'Files',
                entityVersion: '5.2.0',
                locationInfo: { locationName: 'DM3-POC004' },
              },
              // Firmware and version-less rows are ignored.
              { entityType: 'FIRMWARE', entityModel: 'NIC X550T', entityVersion: '0x18a5' },
              { entityType: 'SOFTWARE', entityModel: 'Foundation' },
            ],
          } as unknown as T;
        }
        throw new Error(`unexpected path: ${path}`);
      },
    };
    const db = freshDb();
    const pack = fakePack();
    const service = makeService(db, pack);
    const r = buildAdminRoutes({
      db, pack, adminPassword: ADMIN_PW, service, nutanix: liveNutanix,
      clusterProfile: 'hpoc', pcEndpoint: 'https://10.8.16.7:9440',
    });
    const res = await r.request('/cluster-status', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      intelligentOps: { state: string; enableUrl: string };
    };
    expect(body.intelligentOps.state).toBe('DISABLED');
    expect(body.intelligentOps.enableUrl).toBe(
      'https://10.8.16.7:9440/dm/settings/prism_ops',
    );
    const paths = calls.map((x) => x.path);
    expect(paths).toContain('/api/prism/v4.2/config/domain-managers');
    expect(paths.some((p) => p.includes('/domain-managers/pc-uuid-1/products'))).toBe(true);
  });

  test('GET /cluster-versions (live) → PC/AOS from v3 clusters + LCM inventory, deduped + sorted', async () => {
    const liveNutanix: NutanixClient = {
      mode: 'live',
      async request<T>(_method: string, path: string): Promise<T> {
        if (path === '/api/nutanix/v3/clusters/list') {
          return {
            entities: [
              {
                status: {
                  name: 'PC',
                  resources: {
                    config: { build: { version: '7.5.1' }, service_list: ['PRISM_CENTRAL'] },
                  },
                },
              },
              {
                status: {
                  name: 'DM3-POC004',
                  resources: { config: { build: { version: '7.5.1' }, service_list: ['AOS'] } },
                },
              },
            ],
          } as unknown as T;
        }
        if (path.startsWith('/api/lifecycle/v4.2/resources/entities')) {
          return {
            data: [
              // Duplicate PC row must be skipped (clusters list already covers it).
              { entityType: 'SOFTWARE', entityModel: 'PC', entityVersion: '7.5.1' },
              {
                entityType: 'SOFTWARE',
                entityModel: 'Files',
                entityVersion: '5.2.0',
                locationInfo: { locationName: 'DM3-POC004' },
              },
              // Firmware and version-less rows are ignored.
              { entityType: 'FIRMWARE', entityModel: 'NIC X550T', entityVersion: '0x18a5' },
              { entityType: 'SOFTWARE', entityModel: 'Foundation' },
            ],
          } as unknown as T;
        }
        throw new Error(`unexpected path: ${path}`);
      },
    };
    const db = freshDb();
    const pack = fakePack();
    const service = makeService(db, pack);
    const r = buildAdminRoutes({
      db, pack, adminPassword: ADMIN_PW, service, nutanix: liveNutanix,
      clusterProfile: 'hpoc', pcEndpoint: 'https://10.8.16.7:9440',
    });
    const res = await r.request('/cluster-versions', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ component: string; version: string; location?: string; source: string }>;
    };
    expect(body.rows).toEqual([
      { component: 'Prism Central', version: '7.5.1', location: 'PC', source: 'pc' },
      { component: 'AOS', version: '7.5.1', location: 'DM3-POC004', source: 'pc' },
      { component: 'Files', version: '5.2.0', location: 'DM3-POC004', source: 'lcm' },
    ]);
  });

  test('live mode + product missing → state=null with explanatory error, deep-link still built', async () => {
    const liveNutanix: NutanixClient = {
      mode: 'live',
      async request<T>(_method: string, path: string): Promise<T> {
        if (path.startsWith('/api/prism/v4.2/config/domain-managers')) {
          return { data: [{ extId: 'pc-uuid-1' }] } as unknown as T;
        }
        return { data: [] } as unknown as T;
      },
    };
    const db = freshDb();
    const pack = fakePack();
    const service = makeService(db, pack);
    const r = buildAdminRoutes({
      db, pack, adminPassword: ADMIN_PW, service, nutanix: liveNutanix,
      clusterProfile: 'hpoc', pcEndpoint: 'https://10.8.16.7:9440',
    });
    const res = await r.request('/cluster-status', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      intelligentOps: { state: string | null; enableUrl: string; error?: string };
    };
    expect(body.intelligentOps.state).toBeNull();
    expect(body.intelligentOps.enableUrl).toBe(
      'https://10.8.16.7:9440/dm/settings/prism_ops',
    );
    expect(body.intelligentOps.error).toBeTruthy();
  });

  test('live mode + GET throws → state=null with error, deep-link present', async () => {
    const liveNutanix: NutanixClient = {
      mode: 'live',
      async request<T>(): Promise<T> {
        throw new Error('connection refused');
      },
    };
    const db = freshDb();
    const pack = fakePack();
    const service = makeService(db, pack);
    const r = buildAdminRoutes({
      db, pack, adminPassword: ADMIN_PW, service, nutanix: liveNutanix,
      clusterProfile: 'hpoc', pcEndpoint: 'https://10.8.16.7:9440',
    });
    const res = await r.request('/cluster-status', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      intelligentOps: { state: null; enableUrl: string; error: string };
    };
    expect(body.intelligentOps.state).toBeNull();
    expect(body.intelligentOps.error).toContain('connection refused');
  });
});

describe('lunch lock (pack-wide pause)', () => {
  test('GET /lunch returns paused=false initially with totalActive count', async () => {
    const db = freshDb();
    seedSession(db, { id: 's-A', currentStage: 'intro' });
    seedSession(db, { id: 's-B', currentStage: 'outro' });
    seedSession(db, { id: 's-fin', currentStage: 'outro', finishedAt: 1 });
    const res = await router(db).request('/lunch', {
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminLunchStatus;
    expect(body.paused).toBe(false);
    expect(body.pausedAt).toBeNull();
    expect(body.affectedCount).toBe(2); // s-fin excluded
  });

  test('POST /lunch/lock then GET /lunch reports paused=true with timestamp', async () => {
    const db = freshDb();
    const pack = fakePack();
    const service = makeService(db, pack);
    const r = buildAdminRoutes({ db, pack, adminPassword: ADMIN_PW, service, nutanix: noopNutanix, clusterProfile: 'hpoc', pcEndpoint: '' });
    const res = await r.request('/lunch/lock', {
      method: 'POST',
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(res.status).toBe(200);
    const status = await r.request('/lunch', { headers: { 'X-Admin-Password': ADMIN_PW } });
    const body = (await status.json()) as AdminLunchStatus;
    expect(body.paused).toBe(true);
    expect(typeof body.pausedAt).toBe('number');
  });

  test('POST /lunch/unlock clears the pause + state visible across new service instance (persisted)', async () => {
    const db = freshDb();
    const pack = fakePack();
    const service1 = makeService(db, pack);
    const r1 = buildAdminRoutes({ db, pack, adminPassword: ADMIN_PW, service: service1, nutanix: noopNutanix, clusterProfile: 'hpoc', pcEndpoint: '' });
    await r1.request('/lunch/lock', {
      method: 'POST',
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(service1.isGloballyPaused()).toBe(true);

    // Spin a brand-new SessionService against the same DB — it should
    // pick up the persisted pause at construction time.
    const service2 = makeService(db, pack);
    expect(service2.isGloballyPaused()).toBe(true);

    // Unlock via service1, service2 stays cached at "paused" until next
    // construction — that's intentional, in-memory cache is per-instance.
    const r2 = buildAdminRoutes({ db, pack, adminPassword: ADMIN_PW, service: service1, nutanix: noopNutanix, clusterProfile: 'hpoc', pcEndpoint: '' });
    await r2.request('/lunch/unlock', {
      method: 'POST',
      headers: { 'X-Admin-Password': ADMIN_PW },
    });
    expect(service1.isGloballyPaused()).toBe(false);

    const service3 = makeService(db, pack);
    expect(service3.isGloballyPaused()).toBe(false);
  });

  test('without admin header → 401 on every /lunch endpoint', async () => {
    const db = freshDb();
    const r = router(db);
    expect((await r.request('/lunch')).status).toBe(401);
    expect((await r.request('/lunch/lock', { method: 'POST' })).status).toBe(401);
    expect((await r.request('/lunch/unlock', { method: 'POST' })).status).toBe(401);
  });
});

describe('email participant routes', () => {
  const AUTH = { 'X-Admin-Password': ADMIN_PW };
  const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };

  /** Router with a stubbed Mailtrap call recording every send. */
  function emailRouter(db: Database, sendResult: { ok: boolean; error?: string } = { ok: true }) {
    const calls: Array<{ to: string; subject: string; html: string }> = [];
    const pack = fakePack();
    const service = makeService(db, pack);
    const r = buildAdminRoutes({
      db, pack, adminPassword: ADMIN_PW, service, nutanix: noopNutanix,
      clusterProfile: 'hpoc', pcEndpoint: '',
      sendEmail: async (args) => {
        calls.push({ to: args.to, subject: args.subject, html: args.html });
        return sendResult;
      },
    });
    return { r, calls, service };
  }

  const wireSender = async (r: ReturnType<typeof emailRouter>['r']) => {
    await r.request('/email-config', {
      method: 'PUT',
      headers: JSON_AUTH,
      body: JSON.stringify({ mailtrapToken: 'tok', fromEmail: 'tank@ntnx.ch' }),
    });
  };

  const addRoster = (r: ReturnType<typeof emailRouter>['r'], emails: string[]) =>
    r.request('/email-roster', {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ emails }),
    });

  const sendBody = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      templateId: 'invitation-vdi',
      locale: 'en',
      subject: 's',
      html: '<b>agent {ID} on {CLUSTER}</b>',
      vars: { CLUSTER: 'DM3-POC004' },
      mode: 'pending',
      ...over,
    });

  test('config: empty by default, PUT persists, empty string clears', async () => {
    const { r } = emailRouter(freshDb());
    let res = await r.request('/email-config', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mailtrapToken: '', fromEmail: '', fromName: '', vars: {},
    });

    res = await r.request('/email-config', {
      method: 'PUT',
      headers: JSON_AUTH,
      body: JSON.stringify({
        mailtrapToken: 'tok', fromEmail: 'a@b.co', fromName: 'N', vars: { CLUSTER: 'X' },
      }),
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { mailtrapToken: string; vars: Record<string, string> };
    expect(saved.mailtrapToken).toBe('tok');
    expect(saved.vars).toEqual({ CLUSTER: 'X' });

    // Empty string clears, missing key leaves untouched (planner-config semantics).
    res = await r.request('/email-config', {
      method: 'PUT',
      headers: JSON_AUTH,
      body: JSON.stringify({ fromName: '' }),
    });
    const after = (await res.json()) as { mailtrapToken: string; fromName: string };
    expect(after.mailtrapToken).toBe('tok');
    expect(after.fromName).toBe('');
  });

  test('templates: 2 ids x 2 locales, defaults not overridden', async () => {
    const { r } = emailRouter(freshDb());
    const res = await r.request('/email-templates', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      templates: Array<{ id: string; locale: string; subject: string; html: string; overridden: boolean }>;
    };
    const keys = body.templates.map((t) => `${t.id}.${t.locale}`).sort();
    expect(keys).toEqual(['invitation-vdi.en', 'invitation-vdi.fr', 'summary.en', 'summary.fr']);
    for (const t of body.templates) {
      expect(t.subject.length).toBeGreaterThan(0);
      expect(t.html).toContain('<!doctype html>');
      expect(t.overridden).toBe(false);
    }
  });

  test('roster: seats assigned lowest-free-first, duplicates skipped, delete frees the seat', async () => {
    const { r } = emailRouter(freshDb());
    let res = await addRoster(r, ['a@x.co', 'b@x.co', 'c@x.co', 'a@x.co']);
    expect(res.status).toBe(200);
    let body = (await res.json()) as {
      added: number; skipped: number;
      entries: Array<{ id: number; seat: number; email: string }>;
    };
    expect(body.added).toBe(3);
    expect(body.skipped).toBe(1);
    expect(body.entries.map((e) => e.seat)).toEqual([1, 2, 3]);

    const bId = body.entries.find((e) => e.email === 'b@x.co')!.id;
    res = await r.request(`/email-roster/${bId}`, { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(200);

    res = await addRoster(r, ['d@x.co']);
    body = (await res.json()) as typeof body;
    // d takes the freed seat 2, not seat 4.
    expect(body.entries.find((e) => e.email === 'd@x.co')!.seat).toBe(2);
  });

  test('send pending-only: late addition only emails the newcomer; rows = explicit resend; test marks nobody', async () => {
    const db = freshDb();
    const { r, calls } = emailRouter(db);
    await wireSender(r);
    await addRoster(r, ['a@x.co', 'b@x.co']);

    // First batch reaches both, with per-seat {ID} + {CLUSTER} substituted.
    let res = await r.request('/email-send', { method: 'POST', headers: JSON_AUTH, body: sendBody() });
    expect(res.status).toBe(200);
    let report = (await res.json()) as { sent: number; failed: number; results: Array<{ seat: number }> };
    expect(report.sent).toBe(2);
    expect(calls.map((c) => c.html)).toEqual([
      '<b>agent 01 on DM3-POC004</b>',
      '<b>agent 02 on DM3-POC004</b>',
    ]);

    // Late addition: a second pending send only reaches the newcomer.
    await addRoster(r, ['c@x.co']);
    calls.length = 0;
    res = await r.request('/email-send', { method: 'POST', headers: JSON_AUTH, body: sendBody() });
    report = (await res.json()) as typeof report;
    expect(report.sent).toBe(1);
    expect(calls.map((c) => c.to)).toEqual(['c@x.co']);

    // Everyone served → pending send has nothing to do.
    calls.length = 0;
    res = await r.request('/email-send', { method: 'POST', headers: JSON_AUTH, body: sendBody() });
    report = (await res.json()) as typeof report;
    expect(report.sent).toBe(0);
    expect(calls.length).toBe(0);

    // Explicit per-row resend still works.
    const roster = (await (await r.request('/email-roster', { headers: AUTH })).json()) as {
      entries: Array<{ id: number; email: string; sent: Record<string, number> }>;
    };
    const a = roster.entries.find((e) => e.email === 'a@x.co')!;
    expect(a.sent['invitation-vdi']).toBeGreaterThan(0);
    res = await r.request('/email-send', {
      method: 'POST', headers: JSON_AUTH, body: sendBody({ mode: 'rows', rosterIds: [a.id] }),
    });
    report = (await res.json()) as typeof report;
    expect(report.sent).toBe(1);
    expect(calls.map((c) => c.to)).toEqual(['a@x.co']);

    // Test mode targets the given address and marks nobody.
    calls.length = 0;
    res = await r.request('/email-send', {
      method: 'POST', headers: JSON_AUTH, body: sendBody({ mode: 'test', testAddress: 'op@x.co' }),
    });
    expect(((await res.json()) as { sent: number }).sent).toBe(1);
    expect(calls.map((c) => c.to)).toEqual(['op@x.co']);
    const after = (await (await r.request('/email-roster', { headers: AUTH })).json()) as {
      entries: Array<{ sent: Record<string, number> }>;
    };
    // summary family untouched everywhere; op@x.co not added to the roster.
    expect(after.entries).toHaveLength(3);
    expect(after.entries.every((e) => e.sent['summary'] === undefined)).toBe(true);
  });

  test('failed sends stay pending (no markSent)', async () => {
    const db = freshDb();
    const { r, calls } = emailRouter(db, { ok: false, error: 'HTTP 401' });
    await wireSender(r);
    await addRoster(r, ['a@x.co']);
    let res = await r.request('/email-send', { method: 'POST', headers: JSON_AUTH, body: sendBody() });
    const report = (await res.json()) as { ok: boolean; sent: number; failed: number };
    expect(report.ok).toBe(false);
    expect(report.failed).toBe(1);
    expect(calls.length).toBe(1);
    // Still pending: a retry targets them again.
    res = await r.request('/email-send', { method: 'POST', headers: JSON_AUTH, body: sendBody() });
    expect(((await res.json()) as { failed: number }).failed).toBe(1);
  });

  test('sending an edited draft persists it as the deployment template; matching default clears it', async () => {
    const db = freshDb();
    const { r } = emailRouter(db);
    await wireSender(r);
    await addRoster(r, ['a@x.co']);
    await r.request('/email-send', { method: 'POST', headers: JSON_AUTH, body: sendBody() });

    let tpl = (await (await r.request('/email-templates', { headers: AUTH })).json()) as {
      templates: Array<{ id: string; locale: string; html: string; overridden: boolean }>;
    };
    const edited = tpl.templates.find((t) => t.id === 'invitation-vdi' && t.locale === 'en')!;
    expect(edited.overridden).toBe(true);
    expect(edited.html).toBe('<b>agent {ID} on {CLUSTER}</b>');

    // Reset restores the bundled default.
    const res = await r.request('/email-templates/invitation-vdi/en', {
      method: 'DELETE', headers: AUTH,
    });
    expect(res.status).toBe(200);
    tpl = (await (await r.request('/email-templates', { headers: AUTH })).json()) as typeof tpl;
    const restored = tpl.templates.find((t) => t.id === 'invitation-vdi' && t.locale === 'en')!;
    expect(restored.overridden).toBe(false);
    expect(restored.html).toContain('<!doctype html>');
  });

  test('send validation: bad template, empty subject/html, unconfigured sender', async () => {
    const { r } = emailRouter(freshDb());
    const post = (body: string) =>
      r.request('/email-send', { method: 'POST', headers: JSON_AUTH, body });
    expect((await post(sendBody({ templateId: 'nope' }))).status).toBe(400);
    expect((await post(sendBody({ subject: '' }))).status).toBe(400);
    expect((await post(sendBody({ html: '' }))).status).toBe(400);
    expect((await post(sendBody({ mode: 'weird' }))).status).toBe(400);
    // Valid payload but no token/from configured → 400 before any send.
    const res = await post(sendBody());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('not configured');
  });

  test('without admin header → 401 on every email endpoint', async () => {
    const { r } = emailRouter(freshDb());
    expect((await r.request('/email-config')).status).toBe(401);
    expect((await r.request('/email-config', { method: 'PUT' })).status).toBe(401);
    expect((await r.request('/email-templates')).status).toBe(401);
    expect((await r.request('/email-roster')).status).toBe(401);
    expect((await r.request('/email-roster', { method: 'POST' })).status).toBe(401);
    expect((await r.request('/email-send', { method: 'POST' })).status).toBe(401);
    expect((await r.request('/email-domains')).status).toBe(401);
  });
});
