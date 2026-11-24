import { expect, test } from 'bun:test';
import { ActionRegistry, CheckRegistry, makeBundle, type NutanixClient } from '@ntnx-game/engine';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import type { LoadedPack } from '../src/pack-loader';

function boot(mode: 'mock' | 'live', withLogin = true) {
  const db = openDatabase({ path: ':memory:' });
  const pack: LoadedPack = {
    manifest: { id: 'identity-scoreboard', name: 'Identity scoreboard', version: '0.0.0',
      checks: './checks', stages: './stages', defaultLocale: 'en', supportedLocales: ['en'],
      identity: { variable: withLogin ? 'Trigram' : 'UserNum', label: withLogin ? 'Agent' : 'Learner' } },
    dir: '/tmp/identity-scoreboard',
    stages: [{ index: 0, id: 'login', name: 'login', active: true, messages: ['intro'],
      ...(withLogin ? { check: { fn: 'CheckTrigram' } } : {}) }],
    checks: new CheckRegistry(), actions: new ActionRegistry(), bundle: makeBundle('en', { en: { intro: 'Hello' } }),
  };
  const nutanix = { mode, request: async () => ({}), rest: { request: async () => ({ data: [] }) } } as unknown as NutanixClient;
  const { app, service } = buildApp({ db, pack, nutanix, clusterEndpoint: '', clusterProfile: 'other',
    capabilities: [], adminPassword: 'test-pw' });
  const create = () => service.create({ locale: 'en', clusterEndpoint: '', clusterProfile: 'other', capabilities: [] });
  const entries = async (combined = false) => {
    const response = await app.request(`/api/scoreboard${combined ? '/combined' : ''}`);
    expect(response.status).toBe(200);
    return (await response.json()).entries as Array<{ sessionId: string; trigram: string; rank: number }>;
  };
  return { db, service, create, entries };
}

test.each(['live', 'mock'] as const)('%s scoreboard hides abandoned and failed-resume drafts while preserving confirmed runs', async (mode) => {
  const b = boot(mode);
  try {
    const owner = await b.create();
    b.service.variables.upsert(owner.id, 'Trigram', 'abc', 'login');
    b.service.variables.upsert(owner.id, 'PIN', '1111', 'login');
    expect(b.service.identities.importConfirmed(owner.id, 'abc', '1111')).toBe(true);
    const returning = await b.create();
    b.service.variables.upsert(returning.id, 'Trigram', 'abc', 'login');
    b.service.variables.upsert(returning.id, 'PIN', '9999', 'login');
    const abandoned = await b.create();
    b.service.variables.upsert(abandoned.id, 'Trigram', 'xyz', 'login');
    await b.create(); // Includes the unconfirmed default dev identity in mock mode.
    for (const combined of [false, true]) {
      expect((await b.entries(combined)).map((row) => [row.sessionId, row.trigram, row.rank]))
        .toEqual([[owner.id, 'abc', 1]]);
    }
    // Visibility depends on durable ownership, not on rewindable stage history.
    b.service.history.deleteFrom(owner.id, 'login', ['login']);
    b.db.query('UPDATE sessions SET finished_at=? WHERE id=?').run(Date.now(), owner.id);
    expect((await b.entries()).map((row) => row.sessionId)).toEqual([owner.id]);
  } finally { b.db.close(); }
});

test('numbered learners remain visible without a trigram registration', async () => {
  const b = boot('mock', false);
  try {
    const learner = await b.create();
    b.service.variables.upsert(learner.id, 'UserNum', '42', 'welcome');
    expect(b.service.identities.isConfirmed(learner.id)).toBe(false);
    expect((await b.entries()).map((row) => [row.sessionId, row.trigram])).toEqual([[learner.id, '42']]);
  } finally { b.db.close(); }
});
