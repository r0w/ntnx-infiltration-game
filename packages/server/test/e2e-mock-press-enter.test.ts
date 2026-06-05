/**
 * Verifies the "press Enter to continue" change: the pack's continue prompts
 * no longer carry waitForInputValue="Ok", so submitting an EMPTY value to a
 * $continue input advances the stage instead of being rejected. Drives the
 * real pack on the mock adapter through the first continue gate
 * (create-admin-user, stage 6) pressing Enter (empty) the whole way.
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
    db, pack, nutanix, clusterEndpoint: '', clusterProfile: 'hpoc',
    capabilities: ['CalmDSL', 'NodeRemove', 'MultiNode', 'ApprovalPolicy'],
    adminPassword: 'pw',
    initialVariables: {
      PC: 'mock-pc', PCUser: 'admin', PCPassword: 'unused-in-mock', Vlanid: '42',
      ImageURL: 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img',
    },
    serverMode: 'mock',
  });
  return { service };
}

const NAMED: Record<string, string> = { Trigram: 'xy9', PIN: '4242', Username: 'AutoPlay' };

describe('e2e — mock press-Enter to continue', () => {
  test('empty submit to a $continue prompt advances (no waitForInputValue gate)', async () => {
    const { service } = await boot();
    const session = await service.create({
      locale: 'en', clusterEndpoint: '', clusterProfile: 'hpoc',
      capabilities: ['CalmDSL', 'NodeRemove', 'MultiNode', 'ApprovalPolicy'],
    });
    const id = session.id;

    let pressedEnter = false;
    // Walk until we've cleared create-admin-user (the first continue gate).
    for (let i = 0; i < 40; i++) {
      const s: any = service.getSession(id);
      if (s.currentStage === 'create-auth-policy') break; // == past create-admin-user
      if (s.awaiting && s.awaiting.variable) {
        const v: any = s.awaiting.variable;
        // Named identity inputs need real values; every other prompt is a
        // $continue — press Enter (empty string).
        const value = NAMED[v] ?? '';
        if (value === '') pressedEnter = true;
        const r: any = await service.submitInput(id, v, value);
        // The whole point: an empty continue submit must NOT be rejected.
        expect(r.rejected).toBeFalsy();
      } else {
        await service.advance(id);
      }
    }

    expect(pressedEnter).toBe(true); // we actually exercised an empty submit
    expect(service.getSession(id).currentStage).toBe('create-auth-policy');
  }, 60_000);
});
