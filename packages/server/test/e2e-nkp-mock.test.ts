/**
 * Plays the whole NKP bootcamp on the mock adapters, start to finish.
 *
 * This is the guard that matters most for a content pack: a check can tighten,
 * a fixture can drift, a locale key can be renamed, and none of it fails a unit
 * test — it just strands a learner halfway through the run. Here the run either
 * reaches the last stage or the test says which stage it died on.
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
const PACK_DIR = resolve(PACKS_DIR, 'nkp-bootcamp');

async function boot() {
  const pack = await loadPack(PACKS_DIR, 'nkp-bootcamp');
  const fixtures = resolve(PACK_DIR, 'fixtures.json');
  const { service } = buildApp({
    db: (() => {
      const db = new Database(':memory:');
      db.exec(SCHEMA);
      return db;
    })(),
    pack,
    nutanix: createMockAdapter(fixtures),
    kube: createKubeClient({ mode: 'mock', fixtures }),
    clusterEndpoint: '',
    clusterProfile: 'other',
    capabilities: [],
    adminPassword: 'pw',
    initialVariables: { DashboardUrl: 'https://10.0.0.16/dkp/kommander/dashboard' },
    serverMode: 'mock',
  });
  return { service, pack };
}

describe('e2e — NKP bootcamp on mock', () => {
  test('a learner reaches the end of the run', async () => {
    const { service, pack } = await boot();
    const order = pack.manifest.stages;
    const last = order[order.length - 1];

    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '',
      clusterProfile: 'other',
      capabilities: [],
    });
    const id = session.id;

    const visited: string[] = [];
    let stalledOn: string | null = null;

    for (let i = 0; i < 300; i++) {
      const s = service.getSession(id) as unknown as {
        currentStage: string | null;
        pendingCheck?: unknown;
        awaiting?: { variable?: string } | null;
        finished?: boolean;
      };
      if (s.currentStage && visited.at(-1) !== s.currentStage) visited.push(s.currentStage);
      if (s.finished) break;

      if (s.pendingCheck) {
        const verdict = (await service.resolvePendingCheck(id)) as unknown as {
          pass?: boolean;
          hint?: string;
        };
        if (verdict?.pass === false) {
          stalledOn = `${s.currentStage}: ${verdict.hint ?? 'check failed'}`;
          break;
        }
        continue;
      }

      if (s.awaiting?.variable) {
        // Every prompt in this pack is either the user number or a press-Enter
        // / "type Ok" confirmation.
        const v = s.awaiting.variable;
        const value = v === 'UserNum' ? '7' : v === '$continue' ? '' : 'Ok';
        await service.submitInput(id, v, value);
        continue;
      }

      await service.advance(id);
      if (s.currentStage === last) {
        const after = service.getSession(id) as unknown as { currentStage: string | null };
        if (after.currentStage === last && !s.awaiting) break;
      }
    }

    expect(stalledOn).toBeNull();
    // Every stage in the manifest is narrative or passes its check, so the run
    // visits all of them.
    expect(visited).toEqual(order);
  });

  test('a wrong user number is rejected before the run starts', async () => {
    const { service } = await boot();
    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '',
      clusterProfile: 'other',
      capabilities: [],
    });
    await service.advance(session.id);
    // Walk to the UserNum prompt (the intro is a press-Enter beat first).
    for (let i = 0; i < 5; i++) {
      const s = service.getSession(session.id) as unknown as { awaiting?: { variable?: string } | null };
      const v = s.awaiting?.variable;
      if (!v) { await service.advance(session.id); continue; }
      if (v === 'UserNum') break;
      await service.submitInput(session.id, v, '');
    }
    await service.submitInput(session.id, 'UserNum', 'not-a-number');
    const verdict = (await service.resolvePendingCheck(session.id)) as unknown as {
      check?: { pass?: boolean; hint?: string };
    };
    expect(verdict.check?.pass).toBe(false);
    expect(verdict.check?.hint).toContain('user number');

    // The run does not start until the identity is valid, because every later
    // check reads the `user##` namespace it names: the learner is parked back
    // on the same prompt rather than carried forward.
    const after = service.getSession(session.id) as unknown as {
      awaiting?: { variable?: string; stageName?: string } | null;
    };
    expect(after.awaiting?.variable).toBe('UserNum');
    expect(after.awaiting?.stageName).toBe('welcome');
  });
});
