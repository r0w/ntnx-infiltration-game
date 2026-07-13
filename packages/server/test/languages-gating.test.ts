/**
 * End-to-end coverage for the WIP-locale visibility gate (issue #65),
 * driving the **full Hono app** via `buildApp()` — the same path the
 * browser hits. `effective-locales.test.ts` covers the pure filter; this
 * checks the load-bearing HTTP contract the filter feeds:
 *
 *   - `/api/pack` exposes the mode-filtered `supportedLocales` + `wipLocales`
 *   - `POST /api/session` defends the gate server-side (a hidden WIP locale
 *     falls back to the default, not just hidden in the UI)
 *   - `PUT /admin/languages/:code` flips a `live` WIP locale on/off and the
 *     change takes effect on the next request with no restart.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
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
import type { LoadedPack } from '../src/pack-loader';

const SCHEMA = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql'),
  'utf8',
);

const ADMIN_PW = 'test-pw';

const stages: StageDefinition[] = [
  { index: 0, id: 'intro', name: 'intro', active: true, messages: ['s.intro'] },
];

const bundle = makeBundle('en', {
  en: { 's.intro': 'Intro.' },
  fr: { 's.intro': 'Intro.' },
  es: { 's.intro': 'Intro.' },
  it: { 's.intro': 'Intro.' },
});

function fakePack(): LoadedPack {
  return {
    manifest: {
      id: 'lang-pack',
      name: 'Lang pack',
      version: '0.0.0',
      checks: './checks',
      stages: './stages',
      defaultLocale: 'en',
      supportedLocales: ['en', 'fr', 'es', 'it'],
      wipLocales: ['es', 'it'],
    },
    dir: '/tmp/lang-pack',
    stages,
    checks: new CheckRegistry(),
    actions: new ActionRegistry(),
    acts: new ActRegistry(),
    cleanups: new CleanupRegistry(),
    bundle,
  };
}

const noopNutanix: NutanixClient = { mode: 'mock', request: async () => ({}) };

function bootApp(serverMode: 'mock' | 'test' | 'live') {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const { app } = buildApp({
    db,
    pack: fakePack(),
    nutanix: noopNutanix,
    serverMode,
    clusterEndpoint: '10.0.0.1',
    clusterProfile: 'hpoc',
    capabilities: [],
    adminPassword: ADMIN_PW,
  });
  return app;
}

async function getPack(app: ReturnType<typeof bootApp>) {
  const r = await app.request('/api/pack');
  expect(r.status).toBe(200);
  return (await r.json()) as { supportedLocales: string[]; wipLocales: string[] };
}

async function createSessionLocale(
  app: ReturnType<typeof bootApp>,
  locale: string,
): Promise<string> {
  const r = await app.request('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale }),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { locale: string }).locale;
}

async function toggleLive(
  app: ReturnType<typeof bootApp>,
  code: string,
  enabled: boolean,
): Promise<Response> {
  return app.request(`/api/admin/languages/${code}`, {
    method: 'PUT',
    headers: { 'X-Admin-Password': ADMIN_PW, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

describe('e2e — WIP-locale gate (issue #65)', () => {
  test('mock exposes WIP locales and accepts them on session-create', async () => {
    const app = bootApp('mock');
    const pack = await getPack(app);
    expect(pack.supportedLocales).toEqual(['en', 'fr', 'es', 'it']);
    expect(pack.wipLocales).toEqual(['es', 'it']);
    expect(await createSessionLocale(app, 'it')).toBe('it');
  });

  describe('live', () => {
    let app: ReturnType<typeof bootApp>;
    beforeEach(() => {
      app = bootApp('live');
    });

    test('hides WIP locales by default and falls back to default on session-create', async () => {
      const pack = await getPack(app);
      expect(pack.supportedLocales).toEqual(['en', 'fr']);
      expect(pack.wipLocales).toEqual([]);
      // Defensive server-side gate: a hidden WIP locale is rejected even if
      // a client POSTs it directly, falling back to the default locale.
      expect(await createSessionLocale(app, 'es')).toBe('en');
      // Non-WIP locales are unaffected.
      expect(await createSessionLocale(app, 'fr')).toBe('fr');
    });

    test('operator enabling a WIP locale exposes it on the next request, no restart', async () => {
      expect((await toggleLive(app, 'es', true)).status).toBe(200);
      const pack = await getPack(app);
      expect(pack.supportedLocales).toEqual(['en', 'fr', 'es']);
      expect(pack.wipLocales).toEqual(['es']);
      expect(await createSessionLocale(app, 'es')).toBe('es');
      // it stays hidden until separately enabled.
      expect(pack.supportedLocales).not.toContain('it');
      expect(await createSessionLocale(app, 'it')).toBe('en');

      // Disabling hides it again.
      expect((await toggleLive(app, 'es', false)).status).toBe(200);
      expect((await getPack(app)).supportedLocales).toEqual(['en', 'fr']);
      expect(await createSessionLocale(app, 'es')).toBe('en');
    });

    test('toggling a non-WIP or unknown locale is rejected', async () => {
      expect((await toggleLive(app, 'fr', true)).status).toBe(400);
      expect((await toggleLive(app, 'zz', true)).status).toBe(404);
    });
  });
});
