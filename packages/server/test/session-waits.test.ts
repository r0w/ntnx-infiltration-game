import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRegistry,
  ActRegistry,
  CheckRegistry,
  CleanupRegistry,
  makeBundle,
  type NutanixClient,
  type StageDefinition,
} from '@ntnx-game/engine';
import { buildApp } from '../src/app';
import { SessionWaitQueries } from '../src/db/queries';
import type { LoadedPack } from '../src/pack-loader';

// The time a session spends held by the operator (an admin gate or the
// pack-wide pause) is recorded as "waits", so it can be taken off the player's
// clock. These tests pin when a wait starts, when it ends, and that the
// durations add up.

const SCHEMA = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql'),
  'utf8',
);
const ADMIN_PW = 'test-pw';
const PACK_ID = 'waits-pack';
const MIN = 60_000;

const stages: StageDefinition[] = [
  { index: 0, id: 'intro', name: 'intro', active: true, messages: ['s1.m1'] },
  { index: 1, id: 'checkpoint', name: 'checkpoint', active: true, adminGate: true, messages: ['s2.m1'] },
  { index: 2, id: 'finale', name: 'finale', active: true, messages: ['s3.m1'] },
];
const bundle = makeBundle('en', { en: { 's1.m1': 'Intro.', 's2.m1': 'Checkpoint.', 's3.m1': 'Finale.' } });

function fakePack(): LoadedPack {
  return {
    manifest: {
      id: PACK_ID,
      name: 'Waits pack',
      version: '0.0.0',
      checks: './checks',
      stages: './stages',
      defaultLocale: 'en',
      supportedLocales: ['en'],
    },
    dir: '/tmp/waits-pack',
    stages,
    checks: new CheckRegistry(),
    actions: new ActionRegistry(),
    acts: new ActRegistry(),
    cleanups: new CleanupRegistry(),
    bundle,
  };
}

const noopNutanix: NutanixClient = { mode: 'mock', request: async () => ({}) };

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function bootApp(db: Database) {
  return buildApp({
    db,
    pack: fakePack(),
    nutanix: noopNutanix,
    clusterEndpoint: '10.0.0.1',
    clusterProfile: 'hpoc',
    capabilities: [],
    adminPassword: ADMIN_PW,
  }).app;
}
type App = ReturnType<typeof bootApp>;

async function createSession(app: App): Promise<string> {
  const r = await app.request('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale: 'en' }),
  });
  return ((await r.json()) as { sessionId: string }).sessionId;
}

async function advance(app: App, sid: string) {
  const r = await app.request(`/api/session/${sid}/advance`, { method: 'POST' });
  expect(r.status).toBe(200);
  return (await r.json()) as { kind: string; stageName?: string; gatedReason?: 'stage' | 'global' };
}

async function admin(app: App, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api/admin${path}`, {
    method: 'POST',
    headers: { 'X-Admin-Password': ADMIN_PW, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Walk a fresh session to the gate (intro played, checkpoint locked). */
async function arriveAtGate(app: App): Promise<string> {
  const sid = await createSession(app);
  expect((await advance(app, sid)).stageName).toBe('intro');
  expect((await advance(app, sid)).kind).toBe('gated');
  return sid;
}

/** Wall-clock ms for a time of day on the test day. */
const at = (hh: number, mm: number): Date => new Date(Date.UTC(2026, 9, 4, hh, mm, 0));

// `setSystemTime` pins `Date.now()`, so the durations below are exact to the ms.
beforeEach(() => setSystemTime(at(14, 0)));
afterEach(() => setSystemTime());

describe('SessionWaitQueries', () => {
  function seedSession(db: Database, id: string): void {
    db.prepare(
      `INSERT INTO sessions (id, trigram, pin_hash, pack_id, current_stage, started_at, locale, cluster_endpoint, cluster_profile, capabilities_json)
       VALUES ($id, $id, '', $pack, NULL, 1000, 'en', '', 'other', '[]')`,
    ).run({ $id: id, $pack: PACK_ID });
  }

  test('a session has at most one open wait; the first reason is kept', () => {
    const db = freshDb();
    seedSession(db, 's1');
    const waits = new SessionWaitQueries(db);
    expect(waits.open('s1', 'gate', 'checkpoint', 1000)).toBe(true);
    expect(waits.open('s1', 'pause', null, 2000)).toBe(false);
    const rows = waits.list('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'gate', stageName: 'checkpoint', blockedAt: 1000, releasedAt: null });
  });

  test('asking again while held changes nothing, and does not use up identifiers', () => {
    const db = freshDb();
    seedSession(db, 's1');
    const waits = new SessionWaitQueries(db);
    expect(waits.open('s1', 'gate', 'checkpoint', 1000)).toBe(true);
    // A held player polls every few seconds for as long as the wait lasts.
    for (let i = 0; i < 1000; i++) expect(waits.open('s1', 'gate', 'checkpoint', 2000 + i)).toBe(false);
    waits.close('s1', 5000);
    waits.open('s1', 'pause', null, 6000);
    expect(waits.list('s1').map((w) => w.id)).toEqual([1, 2]);
    const ddl = (db.query("SELECT sql FROM sqlite_master WHERE name = 'session_waits'").get() as { sql: string }).sql;
    expect(ddl).not.toContain('AUTOINCREMENT');
  });

  test('close ends the open wait, and a later wait can start', () => {
    const db = freshDb();
    seedSession(db, 's1');
    const waits = new SessionWaitQueries(db);
    expect(waits.close('s1', 500)).toBe(false);
    waits.open('s1', 'pause', null, 1000);
    expect(waits.close('s1', 4000)).toBe(true);
    expect(waits.close('s1', 5000)).toBe(false);
    expect(waits.open('s1', 'gate', 'checkpoint', 6000)).toBe(true);
    expect(waits.list('s1').map((w) => [w.reason, w.blockedAt, w.releasedAt])).toEqual([
      ['pause', 1000, 4000],
      ['gate', 6000, null],
    ]);
  });

  test('totalBlockedMs adds the closed waits and counts an open one up to now', () => {
    const db = freshDb();
    seedSession(db, 's1');
    const waits = new SessionWaitQueries(db);
    expect(waits.totalBlockedMs('s1', 9000)).toBe(0);
    waits.open('s1', 'gate', 'checkpoint', 1000);
    waits.close('s1', 4000);
    waits.open('s1', 'pause', null, 6000);
    expect(waits.totalBlockedMs('s1', 9000)).toBe(3000 + 3000);
    waits.close('s1', 7000);
    expect(waits.totalBlockedMs('s1', 9000)).toBe(3000 + 1000);
  });

  test('listOpen only returns waits still running', () => {
    const db = freshDb();
    seedSession(db, 's1');
    seedSession(db, 's2');
    const waits = new SessionWaitQueries(db);
    waits.open('s1', 'gate', 'checkpoint', 1000);
    waits.open('s2', 'pause', null, 2000);
    waits.close('s1', 3000);
    expect(waits.listOpen().map((w) => w.sessionId)).toEqual(['s2']);
  });

  test('deleting a session removes its waits', () => {
    const db = freshDb();
    seedSession(db, 's1');
    const waits = new SessionWaitQueries(db);
    waits.open('s1', 'pause', null, 1000);
    db.prepare("DELETE FROM sessions WHERE id = 's1'").run();
    expect(waits.list('s1')).toEqual([]);
  });
});

describe('waits at an admin gate', () => {
  test('the wait starts at the first gated answer and ends at the operator unlock', async () => {
    const db = freshDb();
    const app = bootApp(db);
    const waits = new SessionWaitQueries(db);

    setSystemTime(at(14, 10));
    const sid = await arriveAtGate(app);
    expect(waits.list(sid)).toMatchObject([
      { reason: 'gate', stageName: 'checkpoint', blockedAt: at(14, 10).getTime(), releasedAt: null },
    ]);

    // The client polls every 3 s: polling again must not start another wait.
    setSystemTime(at(14, 20));
    expect((await advance(app, sid)).kind).toBe('gated');
    expect(waits.list(sid)).toHaveLength(1);

    setSystemTime(at(14, 30));
    expect((await admin(app, '/gates/checkpoint/unlock')).status).toBe(200);
    expect(waits.list(sid)[0]!.releasedAt).toBe(at(14, 30).getTime());
    expect(waits.totalBlockedMs(sid)).toBe(20 * MIN);

    // Moving on later does not stretch the wait: it ended at the unlock.
    setSystemTime(at(14, 45));
    expect((await advance(app, sid)).stageName).toBe('checkpoint');
    expect(waits.totalBlockedMs(sid)).toBe(20 * MIN);
  });

  test('players who reach the gate at different times wait for different durations', async () => {
    const db = freshDb();
    const app = bootApp(db);
    const waits = new SessionWaitQueries(db);

    setSystemTime(at(14, 10));
    const lea = await arriveAtGate(app);
    setSystemTime(at(14, 25));
    const marc = await arriveAtGate(app);
    setSystemTime(at(14, 30));
    await admin(app, '/gates/checkpoint/unlock');

    expect(waits.totalBlockedMs(lea)).toBe(20 * MIN);
    expect(waits.totalBlockedMs(marc)).toBe(5 * MIN);
  });

  test('a player who arrives after the unlock never waits', async () => {
    const db = freshDb();
    const app = bootApp(db);
    const waits = new SessionWaitQueries(db);

    await admin(app, '/gates/checkpoint/unlock');
    setSystemTime(at(14, 10));
    const sid = await createSession(app);
    await advance(app, sid);
    expect((await advance(app, sid)).stageName).toBe('checkpoint');
    expect(waits.list(sid)).toEqual([]);
  });

  test('re-locking holds the next arrivals in a new wait and leaves the old one alone', async () => {
    const db = freshDb();
    const app = bootApp(db);
    const waits = new SessionWaitQueries(db);

    setSystemTime(at(14, 0));
    const a = await arriveAtGate(app);
    setSystemTime(at(14, 10));
    await admin(app, '/gates/checkpoint/unlock');
    setSystemTime(at(14, 12));
    await admin(app, '/gates/checkpoint/lock');
    setSystemTime(at(14, 15));
    const b = await arriveAtGate(app);

    expect(waits.totalBlockedMs(a, at(14, 40).getTime())).toBe(10 * MIN);
    expect(waits.list(b)).toMatchObject([{ releasedAt: null, blockedAt: at(14, 15).getTime() }]);
    setSystemTime(at(14, 20));
    await admin(app, '/gates/checkpoint/unlock');
    expect(waits.totalBlockedMs(b)).toBe(5 * MIN);
  });

  test('un-gating the stage from the pack editor frees the players parked on it', async () => {
    const db = freshDb();
    const app = bootApp(db);
    const waits = new SessionWaitQueries(db);

    setSystemTime(at(14, 10));
    const sid = await arriveAtGate(app);
    setSystemTime(at(14, 16));
    const r = await admin(app, '/pack/stages/checkpoint/toggle?field=adminGate', { value: false, cascade: false });
    expect(r.status).toBe(200);
    expect(waits.list(sid)[0]!.releasedAt).toBe(at(14, 16).getTime());
  });
});

describe('waits under the pack-wide pause', () => {
  test('the wait starts when the player is first told to stop and ends at the resume', async () => {
    const db = freshDb();
    const app = bootApp(db);
    const waits = new SessionWaitQueries(db);

    const sid = await createSession(app);
    await advance(app, sid);
    setSystemTime(at(12, 0));
    await admin(app, '/lunch/lock');
    // Nothing is recorded until the player is actually held: they may still be
    // finishing their stage.
    expect(waits.list(sid)).toEqual([]);

    setSystemTime(at(12, 5));
    const held = await advance(app, sid);
    expect(held).toMatchObject({ kind: 'gated', gatedReason: 'global' });
    expect(waits.list(sid)).toMatchObject([{ reason: 'pause', stageName: null, blockedAt: at(12, 5).getTime() }]);

    setSystemTime(at(13, 0));
    await admin(app, '/lunch/unlock');
    expect(waits.list(sid)[0]!.releasedAt).toBe(at(13, 0).getTime());
    expect(waits.totalBlockedMs(sid)).toBe(55 * MIN);
  });

  test('a player held by a gate and then by a pause has one wait, ended by the last release', async () => {
    const db = freshDb();
    const app = bootApp(db);
    const waits = new SessionWaitQueries(db);

    setSystemTime(at(14, 0));
    const sid = await arriveAtGate(app);
    setSystemTime(at(14, 10));
    await admin(app, '/lunch/lock');
    setSystemTime(at(14, 11));
    expect((await advance(app, sid)).gatedReason).toBe('global');
    expect(waits.list(sid)).toHaveLength(1);

    // The gate opens while the pause is still on: the player is still held.
    setSystemTime(at(14, 20));
    await admin(app, '/gates/checkpoint/unlock');
    expect(waits.list(sid)[0]!.releasedAt).toBeNull();

    // The pause ends: now they are free, and the whole stretch counts once.
    setSystemTime(at(14, 30));
    await admin(app, '/lunch/unlock');
    expect(waits.list(sid)).toHaveLength(1);
    expect(waits.list(sid)[0]!.releasedAt).toBe(at(14, 30).getTime());
    expect(waits.totalBlockedMs(sid)).toBe(30 * MIN);
  });

  test('a pause that ends first leaves a player on a still-locked gate waiting', async () => {
    const db = freshDb();
    const app = bootApp(db);
    const waits = new SessionWaitQueries(db);

    setSystemTime(at(14, 0));
    const sid = await arriveAtGate(app);
    setSystemTime(at(14, 5));
    await admin(app, '/lunch/lock');
    setSystemTime(at(14, 6));
    await advance(app, sid);
    setSystemTime(at(14, 15));
    await admin(app, '/lunch/unlock');
    expect(waits.list(sid)[0]!.releasedAt).toBeNull();
    setSystemTime(at(14, 25));
    await admin(app, '/gates/checkpoint/unlock');
    expect(waits.list(sid)[0]!.releasedAt).toBe(at(14, 25).getTime());
    expect(waits.totalBlockedMs(sid)).toBe(25 * MIN);
  });
});

describe('safety net and persistence', () => {
  test('a session that gets through the gates has its leftover wait closed', async () => {
    const db = freshDb();
    const app = bootApp(db);
    const waits = new SessionWaitQueries(db);

    const sid = await createSession(app);
    await advance(app, sid);
    await admin(app, '/gates/checkpoint/unlock');
    // A wait the unlock did not end (simulated): the player is free to go on.
    waits.open(sid, 'gate', 'checkpoint', at(13, 55).getTime());
    setSystemTime(at(14, 5));
    expect((await advance(app, sid)).stageName).toBe('checkpoint');
    expect(waits.listOpen()).toEqual([]);
    expect(waits.list(sid)[0]!.releasedAt).toBe(at(14, 5).getTime());
  });

  test('a finished session has no open wait', async () => {
    const db = freshDb();
    const app = bootApp(db);
    const waits = new SessionWaitQueries(db);

    const sid = await arriveAtGate(app);
    await admin(app, '/gates/checkpoint/unlock');
    expect((await advance(app, sid)).stageName).toBe('checkpoint');
    expect((await advance(app, sid)).stageName).toBe('finale');
    expect((await advance(app, sid)).kind).toBe('finished');
    expect(waits.listOpen()).toEqual([]);
  });

  test('a wait survives a restart and ends at the next unlock', async () => {
    const db = freshDb();
    const waits = new SessionWaitQueries(db);

    setSystemTime(at(14, 0));
    const sid = await arriveAtGate(bootApp(db));

    // A second app over the same database stands for the server coming back.
    setSystemTime(at(14, 10));
    const restarted = bootApp(db);
    expect(waits.list(sid)[0]!.releasedAt).toBeNull();
    setSystemTime(at(14, 25));
    await admin(restarted, '/gates/checkpoint/unlock');
    expect(waits.list(sid)[0]!.releasedAt).toBe(at(14, 25).getTime());
    expect(waits.totalBlockedMs(sid)).toBe(25 * MIN);
  });
});
