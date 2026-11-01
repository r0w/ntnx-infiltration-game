/**
 * The operator's bulk auto-play (`POST /api/act/auto-play/:trigram`) against a
 * pack whose checks read Kubernetes.
 *
 * This ran green on a real fleet while reporting every stage as failed: the
 * acts wrote the cluster correctly, but the check context the route builds by
 * hand omitted `kube`, so all twelve NKP checks answered "Kubernetes transport
 * unavailable". The operator's only verdict on a run said nothing had happened.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockAdapter } from '@ntnx-game/nutanix';
import { createKubeClient } from '@ntnx-game/kube-transport';
import { buildApp } from '../src/app';
import { loadPack } from '../src/pack-loader';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(resolve(HERE, '../src/db/schema.sql'), 'utf8');
const PACKS_DIR = resolve(HERE, '../../../packs');
const FIXTURES = resolve(PACKS_DIR, 'nkp-bootcamp/fixtures.json');

type Result = { stage: string; acted: boolean; actError?: string; checkStatus: string; checkDetail?: string };

async function autoPlay(trigram: string): Promise<Result[]> {
  const pack = await loadPack(PACKS_DIR, 'nkp-bootcamp');
  const { app } = buildApp({
    db: (() => {
      const db = new Database(':memory:');
      db.exec(SCHEMA);
      return db;
    })(),
    pack,
    nutanix: createMockAdapter(FIXTURES),
    kube: createKubeClient({ mode: 'mock', fixtures: FIXTURES }),
    clusterEndpoint: '',
    clusterProfile: 'other',
    capabilities: [],
    adminPassword: 'pw',
    serverMode: 'mock',
  });
  const res = await app.request(`/api/act/auto-play/${trigram}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': 'pw' },
    body: JSON.stringify({ maxRetries: 0 }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: Result[] }).results;
}

describe('operator auto-play — NKP', () => {
  test('every checked stage passes, and none blames a missing transport', async () => {
    const results = await autoPlay('user09');
    const failed = results.filter((r) => r.checkStatus !== 'pass' && r.checkStatus !== 'no-check');
    expect(failed.map((r) => `${r.stage}: ${r.checkDetail ?? r.checkStatus}`)).toEqual([]);
    expect(results.filter((r) => r.actError)).toEqual([]);
  });

  test('the identifier reaches the checks in the pack\'s own spelling', async () => {
    // `user9` and `09` are the same learner as `user09`; the route normalises
    // the path segment into UserNum, which is what the fixtures are keyed on.
    for (const who of ['user9', '9']) {
      const results = await autoPlay(who);
      const project = results.find((r) => r.stage === 'create-project');
      expect(`${who} → ${project?.checkStatus}`).toBe(`${who} → pass`);
    }
  });
});
