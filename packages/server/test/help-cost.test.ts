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
  makeBundle,
  type LocaleBundle,
  type NutanixClient,
  type StageDefinition,
} from '@ntnx-game/engine';
import { PackOverlayQueries } from '../src/db/queries';
import { buildApp } from '../src/app';
import { applyOverlay } from '../src/pack-overlay';
import { HttpError } from '../src/session-service';
import type { LoadedPack } from '../src/pack-loader';

// The operator can change what a stage's step-by-step help costs from the
// Pack tab. These pin the storage (pack_overlay), the admin API, how the new
// value reaches players, and that nobody pays more than they agreed to.

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
    help: ['paid.h1'],
    helpPenaltySec: 120,
  },
  { index: 2, id: 'free', name: 'free', active: true, messages: ['free.m1'], help: ['free.h1'] },
];

const bundle: LocaleBundle = makeBundle('en', {
  en: {
    'intro.m1': 'Hi',
    'paid.m1': 'Do it <input/>',
    'paid.h1': 'Step 1',
    'free.m1': 'Do it too <input/>',
    'free.h1': 'Free hint',
  },
});

const noopNutanix: NutanixClient = {
  mode: 'mock',
  async request() {
    throw new Error('noop client');
  },
};

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

function setup() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const { app, service } = buildApp({
    db,
    pack: fakePack(),
    nutanix: noopNutanix,
    clusterEndpoint: '',
    clusterProfile: 'hpoc',
    capabilities: [],
    adminPassword: ADMIN_PW,
  });
  return { db, app, service };
}

type App = ReturnType<typeof setup>['app'];
const headers = { 'Content-Type': 'application/json', 'x-admin-password': ADMIN_PW };

function putPenalty(app: App, stage: string, body: unknown) {
  return app.request(`/api/admin/pack/stages/${stage}/help-penalty`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
}

async function adminPack(app: App) {
  const body = (await (await app.request('/api/admin/pack', { headers })).json()) as {
    stages: Array<{
      stageName: string;
      hasHelp: boolean;
      helpPenaltySec: number;
      helpPenaltyDefaultSec: number;
      helpPenaltyOverridden: boolean;
    }>;
  };
  return Object.fromEntries(body.stages.map((s) => [s.stageName, s]));
}

async function publicPenalty(app: App, stage: string): Promise<number> {
  const body = (await (await app.request('/api/pack')).json()) as {
    stages: Array<{ name: string; helpPenaltySec: number }>;
  };
  return body.stages.find((s) => s.name === stage)!.helpPenaltySec;
}

describe('pack_overlay help penalty storage', () => {
  function overlay() {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    return new PackOverlayQueries(db);
  }

  test('sets, reads back and clears an override', () => {
    const q = overlay();
    q.setHelpPenalty(PACK_ID, 'paid', 300);
    expect(q.list(PACK_ID)).toEqual([
      { stageName: 'paid', active: null, adminGate: null, helpPenaltySec: 300 },
    ]);
    q.setHelpPenalty(PACK_ID, 'paid', null);
    expect(q.list(PACK_ID)).toEqual([]);
  });

  test('a row with no override left is garbage-collected, one with another override stays', () => {
    const q = overlay();
    q.setField(PACK_ID, 'paid', 'active', false);
    q.setHelpPenalty(PACK_ID, 'paid', 60);
    q.setHelpPenalty(PACK_ID, 'paid', null);
    expect(q.list(PACK_ID)).toEqual([
      { stageName: 'paid', active: false, adminGate: null, helpPenaltySec: null },
    ]);
    q.setField(PACK_ID, 'paid', 'active', null);
    expect(q.list(PACK_ID)).toEqual([]);
  });

  test('toggling active or gate keeps the penalty override', () => {
    const q = overlay();
    q.setHelpPenalty(PACK_ID, 'paid', 45);
    q.setField(PACK_ID, 'paid', 'adminGate', true);
    q.setField(PACK_ID, 'paid', 'adminGate', null);
    expect(q.list(PACK_ID)).toEqual([
      { stageName: 'paid', active: null, adminGate: null, helpPenaltySec: 45 },
    ]);
  });

  test('replaceAll carries penalties and skips rows that say nothing', () => {
    const q = overlay();
    q.replaceAll(PACK_ID, [
      { stageName: 'paid', active: null, adminGate: null, helpPenaltySec: 0 },
      { stageName: 'free', active: null, adminGate: null, helpPenaltySec: null },
    ]);
    expect(q.list(PACK_ID)).toEqual([
      { stageName: 'paid', active: null, adminGate: null, helpPenaltySec: 0 },
    ]);
  });

  test('applyOverlay puts the override on the stage and leaves the others alone', () => {
    const out = applyOverlay(stages, [
      { stageName: 'paid', active: null, adminGate: null, helpPenaltySec: 300 },
    ]);
    expect(out.find((s) => s.name === 'paid')!.helpPenaltySec).toBe(300);
    expect(out.find((s) => s.name === 'free')!.helpPenaltySec).toBeUndefined();
    expect(stages.find((s) => s.name === 'paid')!.helpPenaltySec).toBe(120);
  });
});

describe('PUT /api/admin/pack/stages/:name/help-penalty', () => {
  test('requires the admin password', async () => {
    const { app } = setup();
    const res = await app.request('/api/admin/pack/stages/paid/help-penalty', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: 60 }),
    });
    expect(res.status).toBe(401);
  });

  test('lists what each stage costs, with the pack value and whether it was changed', async () => {
    const { app } = setup();
    const before = await adminPack(app);
    expect(before.paid).toMatchObject({
      hasHelp: true,
      helpPenaltySec: 120,
      helpPenaltyDefaultSec: 120,
      helpPenaltyOverridden: false,
    });
    expect(before.free).toMatchObject({ hasHelp: true, helpPenaltySec: 0, helpPenaltyDefaultSec: 0 });
    expect(before.intro).toMatchObject({ hasHelp: false, helpPenaltySec: 0, helpPenaltyOverridden: false });

    expect((await putPenalty(app, 'paid', { seconds: 300 })).status).toBe(200);
    const after = await adminPack(app);
    expect(after.paid).toMatchObject({
      helpPenaltySec: 300,
      helpPenaltyDefaultSec: 120,
      helpPenaltyOverridden: true,
    });
  });

  test('null clears the override; sending the pack value clears it too', async () => {
    const { app, db } = setup();
    await putPenalty(app, 'paid', { seconds: 300 });
    await putPenalty(app, 'paid', { seconds: null });
    expect((await adminPack(app)).paid).toMatchObject({ helpPenaltySec: 120, helpPenaltyOverridden: false });

    await putPenalty(app, 'paid', { seconds: 120 });
    expect((await adminPack(app)).paid.helpPenaltyOverridden).toBe(false);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM pack_overlay').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test('a free help can be made costly, and a costly one free', async () => {
    const { app } = setup();
    await putPenalty(app, 'free', { seconds: 90 });
    await putPenalty(app, 'paid', { seconds: 0 });
    const after = await adminPack(app);
    expect(after.free).toMatchObject({ helpPenaltySec: 90, helpPenaltyOverridden: true });
    expect(after.paid).toMatchObject({ helpPenaltySec: 0, helpPenaltyOverridden: true });
  });

  test.each([
    ['a negative value', { seconds: -1 }],
    ['a fraction', { seconds: 1.5 }],
    ['more than an hour', { seconds: 3601 }],
    ['a string', { seconds: '60' }],
    ['a missing value', {}],
  ])('rejects %s', async (_label, body) => {
    const { app } = setup();
    expect((await putPenalty(app, 'paid', body)).status).toBe(400);
    expect((await adminPack(app)).paid.helpPenaltyOverridden).toBe(false);
  });

  test('accepts the limits: 0 and one hour', async () => {
    const { app } = setup();
    expect((await putPenalty(app, 'paid', { seconds: 0 })).status).toBe(200);
    expect((await putPenalty(app, 'paid', { seconds: 3600 })).status).toBe(200);
  });

  test('unknown stage → 404, stage without help → 400', async () => {
    const { app } = setup();
    expect((await putPenalty(app, 'nope', { seconds: 60 })).status).toBe(404);
    expect((await putPenalty(app, 'intro', { seconds: 60 })).status).toBe(400);
  });

  test('the public /api/pack shows the new cost to players loading the page', async () => {
    const { app } = setup();
    expect(await publicPenalty(app, 'paid')).toBe(120);
    await putPenalty(app, 'paid', { seconds: 300 });
    expect(await publicPenalty(app, 'paid')).toBe(300);
    await putPenalty(app, 'paid', { seconds: null });
    expect(await publicPenalty(app, 'paid')).toBe(120);
  });

  test('export / import carries the penalty, and reset clears it', async () => {
    const { app } = setup();
    await putPenalty(app, 'paid', { seconds: 300 });
    const exported = (await (await app.request('/api/admin/pack/config', { headers })).json()) as {
      config: string;
      overriddenCount: number;
    };
    expect(exported.overriddenCount).toBe(1);

    await app.request('/api/admin/pack/config/reset', { method: 'POST', headers });
    expect((await adminPack(app)).paid.helpPenaltyOverridden).toBe(false);

    const imported = await app.request('/api/admin/pack/config', {
      method: 'POST',
      headers,
      body: JSON.stringify({ config: exported.config }),
    });
    expect(imported.status).toBe(200);
    expect((await adminPack(app)).paid).toMatchObject({ helpPenaltySec: 300, helpPenaltyOverridden: true });
  });
});

describe('a changed cost reaches the help flow', () => {
  /** A session parked on `stage`, help switched on globally. */
  async function awaitingOn(stage: string) {
    const ctx = setup();
    ctx.service.setHelpEnabledGlobally(true);
    const res = await ctx.app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'en' }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };
    ctx.service.sessions.setAwaiting(sessionId, { variable: '$continue', stageName: stage, renderOffset: 1 });
    return { ...ctx, sessionId };
  }

  test('the next first display uses the operator\'s value', async () => {
    const { app, service, sessionId } = await awaitingOn('paid');
    await putPenalty(app, 'paid', { seconds: 300 });
    expect(service.requestHelp(sessionId)).toEqual({
      status: 'confirm-required',
      stageName: 'paid',
      penaltySec: 300,
    });
    const ok = service.requestHelp(sessionId, { confirm: true });
    if (ok.status !== 'ok') throw new Error('expected ok');
    expect(ok.penaltySec).toBe(300);
    expect(service.helpUsage.get(sessionId, 'paid')?.penaltySec).toBe(300);
  });

  test('a player who already used the help keeps the penalty frozen at that time', async () => {
    const { app, service, sessionId } = await awaitingOn('paid');
    service.requestHelp(sessionId, { confirm: true });
    await putPenalty(app, 'paid', { seconds: 900 });
    const again = service.requestHelp(sessionId);
    if (again.status !== 'ok') throw new Error('expected ok');
    expect(again.penaltySec).toBe(120);
    expect(service.helpUsage.get(sessionId, 'paid')?.penaltySec).toBe(120);
  });

  test('a confirmation for an old amount is refused when the cost changed meanwhile', async () => {
    const { app, service, sessionId } = await awaitingOn('paid');
    // The player agreed to 120 s, then the operator raised it to 300 s.
    await putPenalty(app, 'paid', { seconds: 300 });
    const stale = service.requestHelp(sessionId, { confirm: true, confirmedPenaltySec: 120 });
    expect(stale).toEqual({ status: 'confirm-required', stageName: 'paid', penaltySec: 300 });
    expect(service.helpUsage.get(sessionId, 'paid')).toBeNull();

    const fresh = service.requestHelp(sessionId, { confirm: true, confirmedPenaltySec: 300 });
    expect(fresh.status).toBe('ok');
  });

  test('over HTTP, the confirmed amount travels in the body', async () => {
    const { app, sessionId } = await awaitingOn('paid');
    const post = (body: unknown) =>
      app.request(`/api/session/${sessionId}/help`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const stale = (await (await post({ confirm: true, penaltySec: 60 })).json()) as { status: string };
    expect(stale.status).toBe('confirm-required');
    const good = (await (await post({ confirm: true, penaltySec: 120 })).json()) as { status: string };
    expect(good.status).toBe('ok');
  });

  test('a confirmation without an amount still works (older clients)', async () => {
    const { service, sessionId } = await awaitingOn('paid');
    expect(service.requestHelp(sessionId, { confirm: true }).status).toBe('ok');
  });

  test('making a costly help free skips the confirmation', async () => {
    const { app, service, sessionId } = await awaitingOn('paid');
    await putPenalty(app, 'paid', { seconds: 0 });
    const r = service.requestHelp(sessionId);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.penaltySec).toBe(0);
  });

  test('HttpError type is the one the routes translate', () => {
    expect(new HttpError(400, 'x').status).toBe(400);
  });
});
