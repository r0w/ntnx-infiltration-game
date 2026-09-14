/**
 * Covers `POST /api/session/:id/auto-fill-current` against the real pack +
 * mock adapter — the path the frontend auto-play uses to answer the three
 * cluster-derived prompts (NodeSerial / NumberUpdates / Runway) without the
 * operator typing.
 *
 * Why this exists: `e2e-mock-autoplay` pre-seeds these vars as initial
 * variables, so it never drove `/auto-fill-current`. That blind spot let a
 * regression ship where mock auto-play submitted "Ok" for all three and every
 * check failed. This test hits the endpoint directly so the lookups + the
 * mode gate stay covered.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockAdapter } from '@ntnx-game/nutanix';
import type { NutanixClient } from '@ntnx-game/engine';
import { buildApp } from '../src/app';
import { loadPack } from '../src/pack-loader';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(resolve(HERE, '../src/db/schema.sql'), 'utf8');
const PACKS_DIR = resolve(HERE, '../../../packs');
const ADMIN_PW = 'test-pw';

async function bootApp(serverMode: 'mock' | 'test' | 'live', client?: NutanixClient) {
  const pack = await loadPack(PACKS_DIR, 'ntnx-infiltration');
  const nutanix = client ?? createMockAdapter(
    resolve(PACKS_DIR, 'ntnx-infiltration', 'fixtures.json'),
  );
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const { app } = buildApp({
    db,
    pack,
    nutanix,
    clusterEndpoint: '',
    clusterProfile: 'hpoc',
    // Full set so no target stage is capability-gated out — capacity-runway
    // (stage 31) requires 'PlannerCluster' or it auto-skips.
    capabilities: ['NCM', 'IO', 'CalmDSL', 'NodeRemove', 'MultiNode', 'ApprovalPolicy', 'PlannerCluster'],
    adminPassword: ADMIN_PW,
    initialVariables: { PC: 'mock-pc', PCUser: 'admin', PCPassword: 'unused', Vlanid: '42' },
    serverMode,
  });
  return app;
}

type App = Awaited<ReturnType<typeof bootApp>>;

async function newSession(app: App): Promise<string> {
  const r = await app.request('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale: 'en' }),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { sessionId: string }).sessionId;
}

const CONTINUE_VAR = '$continue';

async function awaitingVar(app: App, sid: string): Promise<string | undefined> {
  const r = await app.request(`/api/session/${sid}`);
  const body = (await r.json()) as { awaiting?: { variable?: string } };
  return body.awaiting?.variable;
}

/** goto the stage then drive forward until the session is awaiting `variable`.
 *  The awaiting state lives on the session GET, not the advance response. A
 *  `$continue` prompt (press-Enter) must be submitted, not advanced past;
 *  no other named input sits on the three target paths. */
async function reachPrompt(app: App, sid: string, stage: string, variable: string) {
  const g = await app.request(`/api/session/${sid}/goto/${stage}`, { method: 'POST' });
  expect(g.status).toBe(200);
  for (let i = 0; i < 40; i++) {
    const v = await awaitingVar(app, sid);
    if (v === variable) return;
    if (v === CONTINUE_VAR) {
      await app.request(`/api/session/${sid}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variable: CONTINUE_VAR, value: '' }),
      });
    } else if (v === undefined) {
      await app.request(`/api/session/${sid}/advance`, { method: 'POST' });
    } else {
      throw new Error(`unexpected intermediate prompt '${v}' before ${variable} at ${stage}`);
    }
  }
  throw new Error(`never reached prompt for ${variable} at stage ${stage}`);
}

async function autoFill(app: App, sid: string) {
  const r = await app.request(`/api/session/${sid}/auto-fill-current`, { method: 'POST' });
  return { status: r.status, body: (await r.json()) as { ok?: boolean; variable?: string; value?: string; error?: string } };
}

describe('POST /auto-fill-current (mock)', () => {
  test('NodeSerial → first discoverable serial from the fixture', async () => {
    const app = await bootApp('mock');
    const sid = await newSession(app);
    await reachPrompt(app, sid, 'expand-cluster', 'NodeSerial');
    const { status, body } = await autoFill(app, sid);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, variable: 'NodeSerial', value: 'AB12345DEMO' });
  });

  test('NumberUpdates → a non-negative integer (never 404s in mock)', async () => {
    const app = await bootApp('mock');
    const sid = await newSession(app);
    await reachPrompt(app, sid, 'lcm-check-updates', 'NumberUpdates');
    const { status, body } = await autoFill(app, sid);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.variable).toBe('NumberUpdates');
    expect(body.value).toMatch(/^\d+$/); // fallback '0' or a cached count, never empty/NaN
  });

  test('Runway → the canned mock value', async () => {
    const app = await bootApp('mock');
    const sid = await newSession(app);
    await reachPrompt(app, sid, 'capacity-runway', 'Runway');
    const { status, body } = await autoFill(app, sid);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, variable: 'Runway', value: '120' });
  });
});

describe('POST /auto-fill-current (live gate)', () => {
  test('is disabled in live mode', async () => {
    const app = await bootApp('live');
    const sid = await newSession(app);
    // No need to reach a prompt — the mode gate is checked before awaiting.
    const r = await app.request(`/api/session/${sid}/auto-fill-current`, { method: 'POST' });
    expect(r.status).toBe(403);
  });
});


describe('LCM auto-fill after an unavailable boot reading', () => {
  function lcmClient() {
    const state = { busy: true, unavailable: false, calls: 0, updates: 1 };
    const client = {
      mode: 'live', sdk: {}, rest: { request: async () => ({}) },
      async request<T>(method: string, path: string): Promise<T> {
        expect(method).toBe('GET'); // Never start an inventory or update.
        state.calls++;
        if (state.unavailable) throw new Error('LCM unavailable');
        if (path.includes('lcm-summaries')) return { data: [
          { clusterExtId: 'pe', clusterType: 'AOS', hasAvailableUpgrades: state.updates > 0 },
        ] } as T;
        if (path.includes('resources/entities')) return { data: [
          { clusterExtId: 'pe', entityType: 'SOFTWARE', entityModel: 'AOS', availableVersions: state.updates ? ['7.6'] : [] },
        ] } as T;
        if (path.includes('resources/status')) return { data: {
          inProgressOperation: state.busy ? { operationType: 'INVENTORY' } : {},
        } } as T;
        throw new Error(`unexpected path ${path}`);
      },
    } as unknown as NutanixClient;
    return { client, state };
  }

  test('does not cache a busy reading; retries when settled and reuses the count', async () => {
    const { client, state } = lcmClient();
    const app = await bootApp('test', client);
    const sid = await newSession(app);
    await reachPrompt(app, sid, 'lcm-check-updates', 'NumberUpdates');
    expect((await autoFill(app, sid)).status).toBe(503);
    state.busy = false;
    expect((await autoFill(app, sid)).body.value).toBe('1');
    const calls = state.calls;
    state.unavailable = true;
    expect((await autoFill(app, sid)).body.value).toBe('1');
    expect(state.calls).toBe(calls);
  });

  test('does not turn an unavailable LCM into zero; accepts a settled zero', async () => {
    const { client, state } = lcmClient();
    state.unavailable = true;
    const app = await bootApp('test', client);
    const sid = await newSession(app);
    await reachPrompt(app, sid, 'lcm-check-updates', 'NumberUpdates');
    expect((await autoFill(app, sid)).status).toBe(503);
    state.unavailable = false;
    state.busy = false;
    state.updates = 0;
    expect((await autoFill(app, sid)).body.value).toBe('0');
  });

  test('keeps an operator-provided count without querying LCM', async () => {
    const { client, state } = lcmClient();
    const app = await bootApp('test', client);
    await app.request('/api/admin/cluster-config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': ADMIN_PW },
      body: JSON.stringify({ lcmAvailableUpdates: 7 }),
    });
    const calls = state.calls;
    const sid = await newSession(app);
    await reachPrompt(app, sid, 'lcm-check-updates', 'NumberUpdates');
    expect((await autoFill(app, sid)).body.value).toBe('7');
    expect(state.calls).toBe(calls);
  });
});
