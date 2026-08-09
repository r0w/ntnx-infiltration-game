/**
 * NIG Central gets the same story from either game.
 *
 * The event contract carries no player identity — only a session id, the stage
 * and timings — so a pack that captures a user number instead of a trigram must
 * report exactly like the infiltration game. This plays the bootcamp on mock
 * and reads what would have gone out.
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
import { Telemetry } from '../src/telemetry';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(resolve(HERE, '../src/db/schema.sql'), 'utf8');
const PACKS_DIR = resolve(HERE, '../../../packs');
const PACK_DIR = resolve(PACKS_DIR, 'nkp-bootcamp');
const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function boot() {
  const pack = await loadPack(PACKS_DIR, 'nkp-bootcamp');
  const fixtures = resolve(PACK_DIR, 'fixtures.json');
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const telemetry = new Telemetry({
    db,
    logger: silent,
    // Never dialled: the test reads the outbox, which is what a flush sends.
    url: 'http://127.0.0.1:9',
    packId: pack.manifest.id,
    packVersion: pack.manifest.version,
    serverMode: 'test',
    clusterProfile: 'hpoc',
  });
  const { service } = buildApp({
    db,
    pack,
    nutanix: createMockAdapter(fixtures),
    kube: createKubeClient({ mode: 'mock', fixtures }),
    clusterEndpoint: '',
    clusterProfile: 'other',
    capabilities: [],
    adminPassword: 'pw',
    initialVariables: { DashboardUrl: 'https://10.0.0.16/dkp/kommander/dashboard' },
    serverMode: 'mock',
    telemetry,
  });
  return { service, pack, db, telemetry };
}

function outbox(db: Database): Array<Record<string, unknown>> {
  return (db.prepare('SELECT event_json FROM telemetry_outbox ORDER BY id').all() as Array<{
    event_json: string;
  }>).map((r) => JSON.parse(r.event_json));
}

describe('NIG Central telemetry — NKP pack', () => {
  test('a full run reports start, every stage, and the finish', async () => {
    const { service, pack, db, telemetry } = await boot();
    expect(telemetry.enabled).toBe(true);

    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '',
      clusterProfile: 'other',
      capabilities: [],
    });
    const id = session.id;

    for (let i = 0; i < 300; i++) {
      const s = service.getSession(id) as unknown as {
        pendingCheck?: unknown;
        awaiting?: { variable?: string } | null;
        finished?: boolean;
      };
      if (s.finished) break;
      if (s.pendingCheck) { await service.resolvePendingCheck(id); continue; }
      if (s.awaiting?.variable) {
        const v = s.awaiting.variable;
        await service.submitInput(id, v, v === 'UserNum' ? '7' : v === '$continue' ? '' : 'Ok');
        continue;
      }
      await service.advance(id);
    }

    const events = outbox(db);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session_started');
    expect(types).toContain('session_finished');
    expect(types.filter((t) => t === 'session_finished').length).toBe(1);

    // Every stage of the pack reported a pass, with its durable id.
    const passed = events.filter((e) => e.type === 'stage_passed');
    expect(passed.length).toBe(pack.manifest.stages.length);
    expect(new Set(passed.map((e) => e.stageName)).size).toBe(pack.manifest.stages.length);
    for (const e of passed) expect(String(e.stageId)).toMatch(/^nkp-\d{3}$/);

    // No player identity travels: Central sees a session id and nothing else.
    for (const e of events) {
      expect(Object.keys(e)).not.toContain('trigram');
      expect(Object.keys(e)).not.toContain('userNum');
      expect(e.sessionId).toBe(id);
    }

    const finish = events.find((e) => e.type === 'session_finished')!;
    expect(typeof finish.totalMs).toBe('number');
  });

  test('the deployment block names this pack, so Central can tell the games apart', async () => {
    const { telemetry, pack } = await boot();
    const deployment = (telemetry as unknown as { deployment: Record<string, unknown> }).deployment;
    expect(deployment.packId).toBe('nkp-bootcamp');
    expect(deployment.packVersion).toBe(pack.manifest.version);
    expect(deployment.mode).toBe('test');
  });
});
