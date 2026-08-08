/**
 * Re-reading a step from the contents menu.
 *
 * Two things have to hold. It must not touch the run: a learner who opens
 * Persistent storage from inside Observability has to come back to exactly
 * the prompt they left. And it must not read ahead, or the menu becomes an
 * answer key for every lab still to come.
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
import { HttpError } from '../src/session-service';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(resolve(HERE, '../src/db/schema.sql'), 'utf8');
const PACKS_DIR = resolve(HERE, '../../../packs');
const FIXTURES = resolve(PACKS_DIR, 'nkp-bootcamp/fixtures.json');

async function boot() {
  const pack = await loadPack(PACKS_DIR, 'nkp-bootcamp');
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const { service } = buildApp({
    db,
    pack,
    nutanix: createMockAdapter(FIXTURES),
    kube: createKubeClient({ mode: 'mock', fixtures: FIXTURES }),
    clusterEndpoint: '',
    clusterProfile: 'other',
    capabilities: [],
    adminPassword: 'pw',
    serverMode: 'mock',
  });
  const session = await service.create({
    locale: 'en',
    clusterEndpoint: '',
    clusterProfile: 'other',
    capabilities: [],
  });
  return { service, id: session.id };
}

/** Walk the run forward to `target` the way a player would, prompt by prompt. */
async function playTo(service: Awaited<ReturnType<typeof boot>>['service'], id: string, target: string) {
  for (let i = 0; i < 300; i++) {
    const s = service.getSession(id) as unknown as {
      currentStage: string | null;
      awaiting?: { stageName: string; variable?: string } | null;
      pendingCheck?: unknown;
    };
    if (s.awaiting?.stageName === target) return;
    if (s.pendingCheck) {
      await service.resolvePendingCheck(id);
      continue;
    }
    if (s.awaiting?.variable) {
      const v = s.awaiting.variable;
      await service.submitInput(id, v, v === 'UserNum' ? '7' : '');
      continue;
    }
    await service.advance(id);
  }
  throw new Error(`never reached ${target}`);
}

describe('readStage', () => {
  test('a learner in Observability can re-read a step from Fundamentals', async () => {
    const { service, id } = await boot();
    await playTo(service, id, 'cost');

    const read = service.readStage(id, 'storage-intro');
    expect(read.stage).toBe('storage-intro');
    expect(read.units.length).toBeGreaterThan(0);
    expect(read.units.some((u) => u.kind === 'text')).toBe(true);
  });

  test('re-reading leaves the player exactly where they were', async () => {
    const { service, id } = await boot();
    await playTo(service, id, 'cost');
    const before = JSON.stringify(service.getSession(id));

    service.readStage(id, 'storage-intro');
    service.readStage(id, 'welcome');

    expect(JSON.stringify(service.getSession(id))).toBe(before);
  });

  // The prompts and beats belong to the run. What comes back is the material.
  test('the prompts, pauses and wipes are stripped', async () => {
    const { service, id } = await boot();
    await playTo(service, id, 'access');
    const kinds = new Set(service.readStage(id, 'welcome').units.map((u) => u.kind));
    expect(kinds.has('await-input')).toBe(false);
    expect(kinds.has('pause')).toBe(false);
    expect(kinds.has('clear')).toBe(false);
  });

  test('a step still ahead is refused, so the menu is no answer key', async () => {
    const { service, id } = await boot();
    await playTo(service, id, 'access');
    expect(() => service.readStage(id, 'ingress')).toThrow(HttpError);
    try {
      service.readStage(id, 'ingress');
    } catch (err) {
      expect((err as HttpError).status).toBe(403);
    }
  });

  test('the step the player is standing in is theirs to re-read', async () => {
    const { service, id } = await boot();
    await playTo(service, id, 'access');
    expect(service.readStage(id, 'access').units.length).toBeGreaterThan(0);
  });

  test('a stage the pack does not have is a 404, not an empty page', async () => {
    const { service, id } = await boot();
    await playTo(service, id, 'access');
    try {
      service.readStage(id, 'no-such-stage');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as HttpError).status).toBe(404);
    }
  });
});
