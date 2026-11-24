import { describe, expect, test } from 'bun:test';
import { ActionRegistry, CheckRegistry, makeBundle, type NutanixClient } from '@ntnx-game/engine';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import type { LoadedPack } from '../src/pack-loader';
import { Telemetry } from '../src/telemetry';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const pack: LoadedPack = {
  manifest: {
    id: 'delete-test', name: 'Delete test', version: '0.0.0', checks: './checks',
    stages: './stages', defaultLocale: 'en', supportedLocales: ['en'],
  },
  dir: '/tmp/delete-test',
  stages: [{ index: 0, id: 'intro', name: 'intro', active: true, messages: ['intro'] }],
  checks: new CheckRegistry(),
  actions: new ActionRegistry(),
  bundle: makeBundle('en', { en: { intro: 'Welcome' } }),
};
const nutanix: NutanixClient = { mode: 'mock', async request() { return {}; } };
const headers = { 'X-Admin-Password': 'test-pw' };

function boot(url?: string) {
  const db = openDatabase({ path: ':memory:' });
  const telemetry = new Telemetry({ db, logger: silent, url, packId: pack.manifest.id,
    packVersion: '0.0.0', serverMode: 'mock', clusterProfile: 'other' });
  const { app } = buildApp({ db, pack, nutanix, telemetry, clusterEndpoint: '',
    clusterProfile: 'other', capabilities: [], adminPassword: 'test-pw' });
  const events = () => (db.prepare('SELECT event_json FROM telemetry_outbox ORDER BY id').all() as
    Array<{ event_json: string }>).map((row) => JSON.parse(row.event_json));
  const create = async () => {
    const response = await app.request('/api/session', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locale: 'en' }) });
    expect(response.status).toBe(200);
    return (await response.json() as { sessionId: string }).sessionId;
  };
  return { db, app, telemetry, events, create };
}

describe('session deletion telemetry', () => {
  test('authenticated deletion emits once, survives cascade, and never includes identity or PIN', async () => {
    const { db, app, events, create } = boot('http://127.0.0.1:9');
    try {
      const id = await create();
      const sibling = await create();
      expect((await app.request(`/api/admin/users/${id}`, { method: 'DELETE' })).status).toBe(401);
      expect(events().filter((e) => e.type === 'session_deleted')).toEqual([]);
      expect((await app.request(`/api/admin/users/${id}`, { method: 'DELETE', headers })).status).toBe(200);
      expect((await app.request(`/api/admin/users/${id}`, { method: 'DELETE', headers })).status).toBe(404);
      expect((await app.request('/api/admin/users/unknown', { method: 'DELETE', headers })).status).toBe(404);
      expect(events().filter((e) => e.type === 'session_deleted')).toEqual([
        { type: 'session_deleted', sessionId: id, ts: expect.any(Number) },
      ]);
      expect(db.prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual([{ id: sibling }]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM session_variables WHERE session_id = ?').get(id)).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  test('deletion remains successful with disabled or broken telemetry', async () => {
    for (const broken of [false, true]) {
      const { db, app, create, events } = boot(broken ? 'http://127.0.0.1:9' : undefined);
      try {
        const id = await create();
        if (broken) db.exec('DROP TABLE telemetry_outbox');
        expect((await app.request(`/api/admin/users/${id}`, { method: 'DELETE', headers })).status).toBe(200);
        expect(db.prepare('SELECT id FROM sessions').all()).toEqual([]);
        if (!broken) expect(events()).toEqual([]);
      } finally { db.close(); }
    }
  });

  test('failed delivery retains deletion and retry sends it after session_started', async () => {
    const received: Array<{ events: Array<{ type: string; sessionId: string }> }> = [];
    let accepted = false;
    const central = Bun.serve({ port: 0, async fetch(req) {
      received.push(await req.json());
      return Response.json({}, { status: accepted ? 200 : 503 });
    } });
    const { db, app, telemetry, events, create } = boot(`http://127.0.0.1:${central.port}`);
    try {
      const id = await create();
      await app.request(`/api/admin/users/${id}`, { method: 'DELETE', headers });
      await telemetry.flush();
      expect(events().map((e) => e.type)).toEqual(['session_started', 'session_deleted']);
      accepted = true;
      await telemetry.flush();
      expect(events()).toEqual([]);
      expect(received).toHaveLength(2);
      for (const batch of received) {
        expect(batch.events.map((e) => [e.type, e.sessionId])).toEqual([
          ['session_started', id], ['session_deleted', id],
        ]);
      }
    } finally { central.stop(true); db.close(); }
  });
});
