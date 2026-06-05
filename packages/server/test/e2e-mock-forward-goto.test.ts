/**
 * Verifies the DevPanel's forward-jump path on the mock adapter: gotoStage()
 * to a stage well ahead of the playhead must NOT leave the target disabled
 * for missing upstream vars — fillMissingDeps() rehydrates the producers
 * from fixtures so the jump lands cleanly. This is what backs the mock-mode
 * "jump anywhere" affordance.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockAdapter } from '@ntnx-game/nutanix';
import { buildApp } from '../src/app';
import { loadPack } from '../src/pack-loader';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(resolve(HERE, '../src/db/schema.sql'), 'utf8');
const PACKS_DIR = resolve(HERE, '../../../packs');

async function boot() {
  const pack = await loadPack(PACKS_DIR, 'ntnx-infiltration');
  const nutanix = createMockAdapter(resolve(PACKS_DIR, 'ntnx-infiltration', 'fixtures.json'));
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const { service } = buildApp({
    db,
    pack,
    nutanix,
    clusterEndpoint: '',
    clusterProfile: 'hpoc',
    capabilities: ['CalmDSL', 'NodeRemove', 'MultiNode', 'ApprovalPolicy'],
    adminPassword: 'pw',
    initialVariables: {
      PC: 'mock-pc',
      PCUser: 'admin',
      PCPassword: 'unused-in-mock',
      Vlanid: '42',
      ImageURL: 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img',
    },
    serverMode: 'mock',
  });
  return { service };
}

const INPUTS: Record<string, string> = { Trigram: 'xy9', PIN: '4242', Username: 'AutoPlay' };

describe('e2e — mock forward goto', () => {
  test('forward gotoStage lands cleanly — no missing-upstream disables', async () => {
    const { service } = await boot();
    const session = service.create({
      locale: 'en',
      clusterEndpoint: '',
      clusterProfile: 'hpoc',
      capabilities: ['CalmDSL', 'NodeRemove', 'MultiNode', 'ApprovalPolicy'],
    });
    const id = session.id;

    // Drive past identity capture (Trigram/PIN/Username) up to intro-mission.
    for (let i = 0; i < 30; i++) {
      const s: any = service.getSession(id);
      if (s.currentStage === 'intro-mission') break;
      if (s.awaiting && s.awaiting.variable) {
        await service.submitInput(id, s.awaiting.variable, INPUTS[s.awaiting.variable] ?? 'Ok');
      } else {
        await service.advance(id);
      }
    }
    expect(service.getSession(id).currentStage).toBe('intro-mission');

    // Jump far forward (stage 27), well past everything just played. gotoStage
    // parks the playhead on the target's predecessor so the next advance
    // replays the target itself.
    service.gotoStage(id, 'create-report');
    expect(service.getSession(id).currentStage).toBe('restore-vm-from-recovery');

    // The target renders with no upstream gated away: fillMissingDeps()
    // rehydrated every producer between the old playhead and here from the
    // fixtures, so create-report sees its needs satisfied.
    const r: any = await service.advance(id);
    expect(r.units?.length ?? 0).toBeGreaterThan(0);
    expect(r.disabledStages).toEqual([]);
  }, 60_000);

  test('backward gotoStage to the first stage (lore) resets to the pre-game state and re-prompts identity', async () => {
    const { service } = await boot();
    const session = service.create({
      locale: 'en',
      clusterEndpoint: '',
      clusterProfile: 'hpoc',
      capabilities: ['CalmDSL', 'NodeRemove', 'MultiNode', 'ApprovalPolicy'],
    });
    const id = session.id;

    // Capture identity and play a few stages in.
    for (let i = 0; i < 30; i++) {
      const s: any = service.getSession(id);
      if (s.currentStage === 'intro-mission') break;
      if (s.awaiting && s.awaiting.variable) {
        await service.submitInput(id, s.awaiting.variable, INPUTS[s.awaiting.variable] ?? 'Ok');
      } else {
        await service.advance(id);
      }
    }
    expect(service.getSession(id).currentStage).toBe('intro-mission');

    // Jump all the way back to the very first stage. Used to 400 with
    // "not a valid goto target"; now it parks the playhead on the pre-game
    // NULL state a fresh session starts in.
    const g = service.gotoStage(id, 'lore');
    expect(g.currentStage).toBeNull();
    expect(service.getSession(id).currentStage).toBeNull();

    // The next advance re-renders lore, and identity inputs are offered again
    // even though Trigram/PIN/Username are still set — so the player can
    // re-enter them. Re-submitting the same trigram doesn't collide with the
    // session's own directory entry.
    const r: any = await service.advance(id);
    expect(r.disabledStages).toEqual([]);
    const reprompted: string[] = [];
    let s: any = service.getSession(id);
    for (let i = 0; i < 40 && s.currentStage !== 'intro-mission'; i++) {
      if (s.awaiting && s.awaiting.variable) {
        if (s.awaiting.variable !== '$continue') reprompted.push(s.awaiting.variable);
        await service.submitInput(id, s.awaiting.variable, INPUTS[s.awaiting.variable] ?? 'Ok');
      } else {
        await service.advance(id);
      }
      s = service.getSession(id);
    }
    // Identity was re-prompted on the replay (proves the jump-back reopens the
    // capture), and we cleanly walked all the way back to intro-mission.
    expect(reprompted).toContain('Trigram');
    expect(reprompted).toContain('PIN');
    expect(reprompted).toContain('Username');
    expect(service.getSession(id).currentStage).toBe('intro-mission');
  }, 60_000);
});
