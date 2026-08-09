/**
 * The operator's two blunt instruments, neither of which had a test.
 *
 * `cleanup-all` is the most destructive thing the game can do: on the bootcamp
 * it deletes a learner's Project, and the federated namespace with everything
 * the labs put in it goes with it. It ran only against live clusters, where a
 * mistake costs someone's work — so it is pinned here against fixtures.
 *
 * The ops console is the other: a pack that does not declare it must not serve
 * endpoints that spawn `ping` on its behalf. Asserting the manifest flag is not
 * enough; what matters is whether the route is mounted.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMockAdapter } from '@ntnx-game/nutanix';
import { createKubeClient } from '@ntnx-game/kube-transport';
import { buildApp } from '../src/app';
import { loadPack } from '../src/pack-loader';

const SCHEMA = readFileSync(resolve(import.meta.dir, '../src/db/schema.sql'), 'utf8');
const PACKS_DIR = resolve(import.meta.dir, '../../../packs');
const ADMIN = { 'x-admin-password': 'pw', 'Content-Type': 'application/json' };

async function appFor(packId: string) {
  const pack = await loadPack(PACKS_DIR, packId);
  const fixtures = resolve(PACKS_DIR, packId, 'fixtures.json');
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const kube = pack.manifest.transports?.includes('kube')
    ? createKubeClient({ mode: 'mock', fixtures })
    : undefined;
  const { app } = buildApp({
    db,
    pack,
    nutanix: createMockAdapter(fixtures),
    kube,
    clusterEndpoint: '',
    clusterProfile: 'hpoc',
    capabilities: [],
    adminPassword: 'pw',
    serverMode: 'mock',
  });
  return { app, pack, kube };
}

describe('POST /api/act/cleanup-all', () => {
  test('needs the admin password', async () => {
    const { app } = await appFor('nkp-bootcamp');
    const res = await app.request('/api/act/cleanup-all/user09', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  /**
   * What this pins is the *target*, not the deletion.
   *
   * The mock store holds the fixture's own `user{UserNum}` and only reads are
   * interpolated — a write carries a concrete name, so a mock delete can never
   * match a templated key. In mock, therefore, an NKP cleanup reports success
   * while removing nothing; do not read a green `cleanup-all` here as proof
   * that a cleanup works. What a test *can* prove is the half that was broken
   * before: that the operator's path resolves the learner and addresses their
   * objects, rather than acting on `undefined` or on someone else's.
   */
  test('the bootcamp addresses the learner named in the URL', async () => {
    const { app, kube } = await appFor('nkp-bootcamp');
    const removed: string[] = [];
    const spy = {
      ...kube!,
      remove: async (ref: { name?: string; plural: string }) => {
        removed.push(`${ref.plural}/${ref.name}`);
      },
    };
    const pack = await loadPack(PACKS_DIR, 'nkp-bootcamp');
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const { app: spied } = buildApp({
      db,
      pack,
      nutanix: createMockAdapter(resolve(PACKS_DIR, 'nkp-bootcamp', 'fixtures.json')),
      kube: spy as typeof kube,
      clusterEndpoint: '',
      clusterProfile: 'hpoc',
      capabilities: [],
      adminPassword: 'pw',
      serverMode: 'mock',
    });
    void app;

    const res = await spied.request('/api/act/cleanup-all/user09', {
      method: 'POST',
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cleanedStages: number;
      results: Array<{ stage: string; ok: boolean; error?: string }>;
    };
    expect(body.results.filter((r) => !r.ok).map((r) => `${r.stage}: ${r.error}`)).toEqual([]);
    expect(body.cleanedStages).toBe(2); // create-project + deploy-app
    expect(removed).toContain('projects/user09');
    // Every object it touched belongs to this learner and nobody else.
    expect(removed.filter((r) => !r.includes('user09'))).toEqual([]);
  });

  test('a segment that names no learner deletes nothing at all', async () => {
    // `xy9` is an infiltration-game trigram: the bootcamp's identityFromPath
    // refuses it, so no UserNum is seeded and the acts must refuse to guess
    // rather than fall back to `user00` or to an unscoped delete.
    const { app, kube } = await appFor('nkp-bootcamp');
    const removed: string[] = [];
    const spy = { ...kube!, remove: async (ref: { name?: string }) => void removed.push(String(ref.name)) };
    const pack = await loadPack(PACKS_DIR, 'nkp-bootcamp');
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const { app: spied } = buildApp({
      db,
      pack,
      nutanix: createMockAdapter(resolve(PACKS_DIR, 'nkp-bootcamp', 'fixtures.json')),
      kube: spy as typeof kube,
      clusterEndpoint: '',
      clusterProfile: 'hpoc',
      capabilities: [],
      adminPassword: 'pw',
      serverMode: 'mock',
    });
    void app;
    const res = await spied.request('/api/act/cleanup-all/xy9', { method: 'POST', headers: ADMIN });
    const body = (await res.json()) as { failures: number };
    expect(removed).toEqual([]);
    expect(body.failures).toBeGreaterThan(0); // it says so, loudly
  });

  test('it runs every cleanup the pack registered, and only those', async () => {
    for (const packId of ['ntnx-infiltration', 'nkp-bootcamp']) {
      const { app, pack } = await appFor(packId);
      const res = await app.request('/api/act/cleanup-all/xy9', {
        method: 'POST',
        headers: ADMIN,
      });
      const body = (await res.json()) as { results: Array<{ stage: string }> };
      // The pack owns the order — a cross-stage dependency makes plain reverse
      // stage order wrong — so the endpoint must not re-sort it.
      expect(`${packId}: ${body.results.map((r) => r.stage).join(',')}`).toBe(
        `${packId}: ${pack.cleanups.names().join(',')}`,
      );
    }
  });

  test('a cleanup that throws is reported, not swallowed, and the sweep continues', async () => {
    const { app, pack } = await appFor('nkp-bootcamp');
    const names = pack.cleanups.names();
    // Break the first one the way a real cluster would: refuse the call.
    const original = pack.cleanups.get(names[0]!)!;
    pack.cleanups.register(names[0]!, async () => {
      throw new Error('cluster said no');
    });
    try {
      const res = await app.request('/api/act/cleanup-all/user09', {
        method: 'POST',
        headers: ADMIN,
      });
      const body = (await res.json()) as {
        ok: boolean;
        failures: number;
        results: Array<{ stage: string; ok: boolean; error?: string }>;
      };
      expect(body.failures).toBe(1);
      expect(body.results[0]!.error).toContain('cluster said no');
      // Every other cleanup still ran: one broken step must not strand the rest
      // of a learner's leftovers on the cluster.
      expect(body.results).toHaveLength(names.length);
    } finally {
      pack.cleanups.register(names[0]!, original);
    }
  });
});

describe('the ops console is only served to the game that declares it', () => {
  test('the infiltration game mounts /api/ssh', async () => {
    const { app } = await appFor('ntnx-infiltration');
    const res = await app.request('/api/ssh/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // 400 = the route is there and rejected an empty target. Any non-404 proves
    // it is mounted; 404 would mean it is not.
    expect(res.status).not.toBe(404);
  });

  test('the bootcamp does not', async () => {
    const { app } = await appFor('nkp-bootcamp');
    const res = await app.request('/api/ssh/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: '127.0.0.1' }),
    });
    expect(res.status).toBe(404);
  });
});
