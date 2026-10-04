import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActRegistry,
  ActionRegistry,
  CheckRegistry,
  CleanupRegistry,
  StageRunner,
  makeBundle,
  type LocaleBundle,
  type NutanixClient,
  type StageDefinition,
} from '@ntnx-game/engine';
import { HelpUsageQueries, HistoryQueries, VariableQueries } from '../src/db/queries';
import { buildApp } from '../src/app';
import {
  buildScoreboardRoutes,
  effectiveFinish,
  mergeScoreboards,
  type ScoreboardEntry,
} from '../src/routes/scoreboard';
import { HttpError, SessionService } from '../src/session-service';
import { resolveHelpEnabled } from '../src/help';
import type { LoadedPack } from '../src/pack-loader';

const SCHEMA = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql'),
  'utf8',
);

const PACK_ID = 'test-pack';
const ADMIN_PW = 'test-pw';

const stages: StageDefinition[] = [
  { index: 0, id: 'intro', name: 'intro', active: true, messages: ['intro.m1'] },
  {
    index: 1,
    id: 'paid',
    name: 'paid',
    active: true,
    messages: ['paid.m1'],
    help: ['paid.h1', 'paid.h2'],
    helpPenaltySec: 120,
  },
  {
    index: 2,
    id: 'free',
    name: 'free',
    active: true,
    messages: ['free.m1'],
    help: ['free.h1'],
  },
  { index: 3, id: 'plain', name: 'plain', active: true, messages: ['plain.m1'] },
];

const bundle: LocaleBundle = makeBundle('en', {
  en: {
    'intro.m1': 'Hi',
    'paid.m1': 'Do it <input/>',
    'paid.h1': 'Step 1: name it <code>{Trigram}-thing</code>',
    'paid.h2': 'Step 2: press Save',
    'free.m1': 'Do it too <input/>',
    'free.h1': 'Free hint for {Trigram}',
    'plain.m1': 'No help here <input/>',
  },
});

const noopNutanix: NutanixClient = {
  mode: 'mock',
  async request() {
    throw new Error('noop client — not used in these tests');
  },
};
const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function fakePack(): LoadedPack {
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
    stages,
    checks: new CheckRegistry(),
    actions: new ActionRegistry(),
    acts: new ActRegistry(),
    cleanups: new CleanupRegistry(),
    bundle,
  };
}

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function makeService(db: Database = freshDb()) {
  const service = new SessionService({
    db,
    runner: new StageRunner(stages, new CheckRegistry()),
    nutanix: noopNutanix,
    logger: silentLogger,
    packId: PACK_ID,
    bundle,
  });
  return { db, service };
}

/** A session parked on `stage` as if it were waiting for the player's Enter. */
async function awaitingSession(service: SessionService, stage: string) {
  const session = await service.create({
    locale: 'en',
    clusterEndpoint: '',
    clusterProfile: 'hpoc',
    capabilities: [],
  });
  service.variables.upsert(session.id, 'Trigram', 'ZZZ', 'seed');
  service.sessions.setAwaiting(session.id, {
    variable: '$continue',
    stageName: stage,
    renderOffset: 1,
  });
  return session;
}

function httpStatus(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
  return 0;
}

describe('resolveHelpEnabled', () => {
  test('the player-level value wins over the global flag, in both directions', () => {
    expect(resolveHelpEnabled(true, false)).toBe(true);
    expect(resolveHelpEnabled(false, true)).toBe(false);
    expect(resolveHelpEnabled(null, true)).toBe(true);
    expect(resolveHelpEnabled(null, false)).toBe(false);
  });
});

describe('SessionService step-by-step help', () => {
  test('is disabled by default: the server refuses the request', async () => {
    const { service } = makeService();
    const session = await awaitingSession(service, 'paid');
    expect(service.isHelpEnabledGlobally()).toBe(false);
    expect(httpStatus(() => service.requestHelp(session.id, { confirm: true }))).toBe(403);
    expect(service.helpUsage.list(session.id)).toEqual([]);
  });

  test('a first display that costs time needs a confirmation and records nothing until then', async () => {
    const { service } = makeService();
    service.setHelpEnabledGlobally(true);
    const session = await awaitingSession(service, 'paid');

    const ask = service.requestHelp(session.id);
    expect(ask).toEqual({ status: 'confirm-required', stageName: 'paid', penaltySec: 120 });
    expect(service.helpUsage.list(session.id)).toEqual([]);

    const ok = service.requestHelp(session.id, { confirm: true });
    if (ok.status !== 'ok') throw new Error('expected ok');
    expect(ok.charged).toBe(true);
    expect(ok.penaltySec).toBe(120);
    expect(service.helpUsage.get(session.id, 'paid')?.penaltySec).toBe(120);
  });

  test('renders the help with the session variables substituted', async () => {
    const { service } = makeService();
    service.setHelpEnabledGlobally(true);
    const session = await awaitingSession(service, 'paid');
    const ok = service.requestHelp(session.id, { confirm: true });
    if (ok.status !== 'ok') throw new Error('expected ok');
    expect(ok.units.find((u) => u.kind === 'code')).toEqual({ kind: 'code', text: 'ZZZ-thing' });
    const text = ok.units.map((u) => (u.kind === 'text' ? u.text : '')).join('');
    expect(text).toContain('Step 2: press Save');
  });

  test('is billed once per stage: showing it again is free and needs no confirmation', async () => {
    const { service, db } = makeService();
    service.setHelpEnabledGlobally(true);
    const session = await awaitingSession(service, 'paid');
    service.requestHelp(session.id, { confirm: true });
    const again = service.requestHelp(session.id);
    if (again.status !== 'ok') throw new Error('expected ok');
    expect(again.charged).toBe(false);
    expect(again.penaltySec).toBe(120);
    const count = db.prepare('SELECT COUNT(*) AS n FROM help_usage').get() as { n: number };
    expect(count.n).toBe(1);
  });

  test('keeps the penalty frozen at the first display', async () => {
    const { service } = makeService();
    service.setHelpEnabledGlobally(true);
    const session = await awaitingSession(service, 'paid');
    service.helpUsage.record(session.id, 'paid', 300);
    const r = service.requestHelp(session.id);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.penaltySec).toBe(300);
    expect(service.helpUsage.get(session.id, 'paid')?.penaltySec).toBe(300);
  });

  test('a stage without penalty is free: no confirmation, usage still tracked', async () => {
    const { service } = makeService();
    service.setHelpEnabledGlobally(true);
    const session = await awaitingSession(service, 'free');
    const r = service.requestHelp(session.id);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.penaltySec).toBe(0);
    expect(r.charged).toBe(true);
    expect(service.helpUsage.get(session.id, 'free')?.penaltySec).toBe(0);
  });

  test('a player forced on gets help while the global flag is off', async () => {
    const { service } = makeService();
    const session = await awaitingSession(service, 'free');
    service.setSessionHelp(session.id, true);
    const r = service.requestHelp(session.id);
    expect(r.status).toBe('ok');
  });

  test('a player forced off is refused while the global flag is on', async () => {
    const { service } = makeService();
    service.setHelpEnabledGlobally(true);
    const session = await awaitingSession(service, 'free');
    service.setSessionHelp(session.id, false);
    expect(httpStatus(() => service.requestHelp(session.id))).toBe(403);
  });

  test('clearing the override makes the player follow the global flag again', async () => {
    const { service } = makeService();
    const session = await awaitingSession(service, 'free');
    service.setSessionHelp(session.id, true);
    expect(service.isHelpEnabledFor(service.getSession(session.id))).toBe(true);
    service.setSessionHelp(session.id, null);
    expect(service.isHelpEnabledFor(service.getSession(session.id))).toBe(false);
    service.setHelpEnabledGlobally(true);
    expect(service.isHelpEnabledFor(service.getSession(session.id))).toBe(true);
  });

  test('refuses without an awaiting prompt, on a stage without help, and when finished', async () => {
    const { service } = makeService();
    service.setHelpEnabledGlobally(true);

    const idle = await service.create({
      locale: 'en',
      clusterEndpoint: '',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    expect(httpStatus(() => service.requestHelp(idle.id))).toBe(409);

    const plain = await awaitingSession(service, 'plain');
    expect(httpStatus(() => service.requestHelp(plain.id))).toBe(404);

    const done = await awaitingSession(service, 'free');
    service.sessions.markFinished(done.id);
    expect(httpStatus(() => service.requestHelp(done.id))).toBe(409);
  });

  test('unknown session → 404', () => {
    const { service } = makeService();
    expect(httpStatus(() => service.setSessionHelp('nope', true))).toBe(404);
    expect(httpStatus(() => service.requestHelp('nope'))).toBe(404);
  });

  test('helpSnapshot exposes the effective flag and the stages already shown', async () => {
    const { service } = makeService();
    const session = await awaitingSession(service, 'free');
    expect(service.helpSnapshot(service.getSession(session.id))).toEqual({
      enabled: false,
      usedStages: [],
    });
    service.setSessionHelp(session.id, true);
    service.requestHelp(session.id);
    expect(service.helpSnapshot(service.getSession(session.id))).toEqual({
      enabled: true,
      usedStages: ['free'],
    });
  });

  test('deleting a session removes its help usage', async () => {
    const { service, db } = makeService();
    const session = await awaitingSession(service, 'free');
    service.helpUsage.record(session.id, 'free', 0);
    service.sessions.deleteById(session.id);
    const count = db.prepare('SELECT COUNT(*) AS n FROM help_usage').get() as { n: number };
    expect(count.n).toBe(0);
  });
});

// ─── ranking ─────────────────────────────────────────────────────────

function seedFinished(
  db: Database,
  input: { id: string; trigram: string; startedAt: number; finishedAt: number | null; passed: string[] },
): void {
  db.prepare(
    `INSERT INTO sessions (id, trigram, pin_hash, pack_id, current_stage, started_at, finished_at, locale, cluster_endpoint, cluster_profile, capabilities_json)
     VALUES ($id, $id, '', $pack, NULL, $started, $finished, 'en', '', 'other', '[]')`,
  ).run({
    $id: input.id,
    $pack: PACK_ID,
    $started: input.startedAt,
    $finished: input.finishedAt,
  });
  new VariableQueries(db).upsert(input.id, 'Trigram', input.trigram, 'seed');
  const history = new HistoryQueries(db);
  for (const name of input.passed) history.record(input.id, name, 'passed', 1, null);
}

async function fetchScoreboard(db: Database): Promise<ScoreboardEntry[]> {
  const router = buildScoreboardRoutes({
    db,
    pack: fakePack(),
    mode: 'mock',
    service: { effectivePlayableCount: () => stages.length } as unknown as Parameters<
      typeof buildScoreboardRoutes
    >[0]['service'],
    capabilities: [],
    clusterProfile: 'hpoc',
  });
  const res = await router.request('/');
  return ((await res.json()) as { entries: ScoreboardEntry[] }).entries;
}

describe('ranking with help penalties', () => {
  const all = ['intro', 'paid', 'free', 'plain'];

  test('a finisher who used help can be overtaken by a slower one who did not', async () => {
    const db = freshDb();
    // FAST finishes first (t=3000) but paid 2 s of help: effective 5000.
    seedFinished(db, { id: 's-fast', trigram: 'FST', startedAt: 1000, finishedAt: 3000, passed: all });
    new HelpUsageQueries(db).record('s-fast', 'paid', 2);
    // SLOW finishes later (t=4000) without help: effective 4000.
    seedFinished(db, { id: 's-slow', trigram: 'SLW', startedAt: 1000, finishedAt: 4000, passed: all });

    const entries = await fetchScoreboard(db);
    expect(entries.map((e) => e.trigram)).toEqual(['SLW', 'FST']);
    expect(entries.map((e) => e.rank)).toEqual([1, 2]);
  });

  test('without penalties the earliest finish still wins', async () => {
    const db = freshDb();
    seedFinished(db, { id: 's-a', trigram: 'AAA', startedAt: 1000, finishedAt: 5000, passed: all });
    seedFinished(db, { id: 's-b', trigram: 'BBB', startedAt: 1000, finishedAt: 4000, passed: all });
    const entries = await fetchScoreboard(db);
    expect(entries.map((e) => e.trigram)).toEqual(['BBB', 'AAA']);
  });

  test('entries expose the usage count and the total penalty', async () => {
    const db = freshDb();
    seedFinished(db, { id: 's-x', trigram: 'XXX', startedAt: 1000, finishedAt: 4000, passed: all });
    const help = new HelpUsageQueries(db);
    help.record('s-x', 'paid', 120);
    help.record('s-x', 'free', 0);
    const [entry] = await fetchScoreboard(db);
    expect(entry.helpUses).toBe(2);
    expect(entry.helpPenaltySec).toBe(120);
  });

  test('players still playing are not reordered by help usage', async () => {
    const db = freshDb();
    // LEAD is one stage ahead, so stages passed decide the order, not the clock
    // (a tie would fall back to the last activity, which is the wall clock).
    seedFinished(db, { id: 's-lead', trigram: 'LED', startedAt: 2000, finishedAt: null, passed: ['intro', 'paid', 'free'] });
    seedFinished(db, { id: 's-behind', trigram: 'BHD', startedAt: 1000, finishedAt: null, passed: ['intro', 'paid'] });
    // The leader pays 10 minutes of help: it stays ahead, since a penalty only
    // counts once someone has finished.
    new HelpUsageQueries(db).record('s-lead', 'paid', 600);

    const entries = await fetchScoreboard(db);
    expect(entries.map((e) => e.trigram)).toEqual(['LED', 'BHD']);
    expect(entries[0]!.helpPenaltySec).toBe(600);
  });
});

describe('mergeScoreboards with help penalties', () => {
  function entry(over: Partial<ScoreboardEntry> & { sessionId: string }): ScoreboardEntry & { peerLabel: string | null } {
    return {
      rank: 0,
      trigram: over.sessionId,
      username: null,
      stageName: null,
      stagesPassed: 4,
      stagesDisabled: 0,
      totalStages: 4,
      effectiveTotalStages: 4,
      startedAt: 1000,
      finishedAt: 4000,
      lastActivityAt: null,
      status: 'finished',
      peerLabel: null,
      ...over,
    };
  }

  test('effectiveFinish adds the penalty to the finish time', () => {
    expect(effectiveFinish({ finishedAt: 4000, helpPenaltySec: 2 })).toBe(6000);
    expect(effectiveFinish({ finishedAt: 4000 })).toBe(4000);
    expect(effectiveFinish({ finishedAt: null, helpPenaltySec: 9 })).toBe(Number.POSITIVE_INFINITY);
  });

  test('ranks on finish time plus penalties; a peer without the field counts as 0', () => {
    const merged = mergeScoreboards([
      entry({ sessionId: 'local-helped', finishedAt: 3000, helpPenaltySec: 2 }),
      entry({ sessionId: 'old-peer', finishedAt: 4000, peerLabel: 'old' }),
      entry({ sessionId: 'clean', finishedAt: 7000, helpPenaltySec: 0 }),
    ]);
    expect(merged.map((e) => e.trigram)).toEqual(['old-peer', 'local-helped', 'clean']);
    expect(merged.map((e) => e.rank)).toEqual([1, 2, 3]);
  });
});

// ─── HTTP surface ────────────────────────────────────────────────────

function appSetup() {
  const db = freshDb();
  const { app, service } = buildApp({
    db,
    pack: fakePack(),
    nutanix: noopNutanix,
    clusterEndpoint: '',
    clusterProfile: 'hpoc',
    capabilities: [],
    adminPassword: ADMIN_PW,
  });
  return { app, service, db };
}

const adminHeaders = { 'Content-Type': 'application/json', 'x-admin-password': ADMIN_PW };

async function createSession(app: ReturnType<typeof appSetup>['app'], service: SessionService) {
  const res = await app.request('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale: 'en' }),
  });
  const { sessionId } = (await res.json()) as { sessionId: string };
  service.sessions.setAwaiting(sessionId, {
    variable: '$continue',
    stageName: 'paid',
    renderOffset: 1,
  });
  return sessionId;
}

function postHelp(app: ReturnType<typeof appSetup>['app'], id: string, body: unknown = {}) {
  return app.request(`/api/session/${id}/help`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('player help routes', () => {
  test('POST /help is refused while help is off', async () => {
    const { app, service } = appSetup();
    const id = await createSession(app, service);
    const res = await postHelp(app, id, { confirm: true });
    expect(res.status).toBe(403);
  });

  test('POST /help: confirm-required, then ok with units; the snapshot lists the stage', async () => {
    const { app, service } = appSetup();
    const id = await createSession(app, service);
    const on = await app.request('/api/admin/help', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);

    const first = await (await postHelp(app, id)).json();
    expect(first).toEqual({ status: 'confirm-required', stageName: 'paid', penaltySec: 120 });

    const second = (await (await postHelp(app, id, { confirm: true })).json()) as {
      status: string;
      units: unknown[];
      charged: boolean;
    };
    expect(second.status).toBe('ok');
    expect(second.charged).toBe(true);
    expect(second.units.length).toBeGreaterThan(0);

    const snap = (await (await app.request(`/api/session/${id}`)).json()) as {
      help: { enabled: boolean; usedStages: string[] };
    };
    expect(snap.help).toEqual({ enabled: true, usedStages: ['paid'] });
  });

  test('GET /api/pack lists which stages have help and what it costs', async () => {
    const { app } = appSetup();
    const body = (await (await app.request('/api/pack')).json()) as {
      stages: Array<{ name: string; hasHelp: boolean; helpPenaltySec: number }>;
    };
    const by = Object.fromEntries(body.stages.map((s) => [s.name, s]));
    expect(by.paid).toMatchObject({ hasHelp: true, helpPenaltySec: 120 });
    expect(by.free).toMatchObject({ hasHelp: true, helpPenaltySec: 0 });
    expect(by.plain).toMatchObject({ hasHelp: false, helpPenaltySec: 0 });
  });
});

describe('admin help routes', () => {
  test('require the admin password', async () => {
    const { app } = appSetup();
    expect((await app.request('/api/admin/help')).status).toBe(401);
    const put = await app.request('/api/admin/help', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(401);
  });

  test('global switch: off by default, validated, persisted', async () => {
    const { app, service } = appSetup();
    const get = async () =>
      (await (await app.request('/api/admin/help', { headers: adminHeaders })).json()) as { enabled: boolean };
    expect((await get()).enabled).toBe(false);

    const bad = await app.request('/api/admin/help', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(bad.status).toBe(400);

    await app.request('/api/admin/help', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    expect((await get()).enabled).toBe(true);
    expect(service.isHelpEnabledGlobally()).toBe(true);
  });

  test('per-player override: set, clear, validate, unknown session', async () => {
    const { app, service } = appSetup();
    const id = await createSession(app, service);
    const put = (body: unknown, sid = id) =>
      app.request(`/api/admin/users/${sid}/help`, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(body),
      });

    expect((await put({ enabled: true })).status).toBe(200);
    expect(service.getSession(id).helpEnabled).toBe(true);
    expect((await put({ enabled: false })).status).toBe(200);
    expect(service.getSession(id).helpEnabled).toBe(false);
    expect((await put({ enabled: null })).status).toBe(200);
    expect(service.getSession(id).helpEnabled).toBeNull();

    expect((await put({})).status).toBe(400);
    expect((await put({ enabled: 'x' })).status).toBe(400);
    expect((await put({ enabled: true }, 'unknown')).status).toBe(404);
  });

  test('GET /users carries the override, the effective flag and the usage', async () => {
    const { app, service } = appSetup();
    const id = await createSession(app, service);
    service.setSessionHelp(id, true);
    service.helpUsage.record(id, 'paid', 120);
    service.helpUsage.record(id, 'free', 0);

    const body = (await (await app.request('/api/admin/users', { headers: adminHeaders })).json()) as {
      entries: Array<{
        sessionId: string;
        helpEnabled: boolean | null;
        helpEffective: boolean;
        helpUses: number;
        helpPenaltySec: number;
        helpStages: Array<{ stage: string; penaltySec: number }>;
      }>;
    };
    const row = body.entries.find((e) => e.sessionId === id)!;
    expect(row.helpEnabled).toBe(true);
    expect(row.helpEffective).toBe(true);
    expect(row.helpUses).toBe(2);
    expect(row.helpPenaltySec).toBe(120);
    expect(row.helpStages).toEqual([
      { stage: 'paid', penaltySec: 120 },
      { stage: 'free', penaltySec: 0 },
    ]);
  });
});
