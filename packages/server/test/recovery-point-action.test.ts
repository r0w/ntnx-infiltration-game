/**
 * Verifies the player-facing recovery-point creation actually fires.
 *
 * For a real player (NOT auto-play, which uses the act), the recovery point
 * is created by the narrative action `<action name='createRecoveryPoint'/>`
 * carried on stage 13 `verify-prod-user-isolation`. This test proves two
 * independent halves:
 *   A. The engine extracts that action from the REAL pack/locales when the
 *      stage renders — in en, and via the en-fallback in fr/de (the tag is
 *      only present in en.json).
 *   B. The REAL action, as registered, POSTs to the dataprotection
 *      recovery-points endpoint with the right body when VMUUID is captured,
 *      and quietly does nothing when it isn't (or in mock mode).
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRegistry,
  CheckRegistry,
  StageRunner,
  VariableStore,
  makeBundle,
  type ActionContext,
  type Locale,
  type NutanixClient,
  type StageDefinition,
} from '@ntnx-game/engine';
import { loadPack } from '../src/pack-loader';
import { SessionService } from '../src/session-service';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = resolve(HERE, '../../../packs');
const SCHEMA = readFileSync(resolve(HERE, '../src/db/schema.sql'), 'utf8');
const STAGE = 'verify-prod-user-isolation';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Records every rest.request call so we can assert the POST happened. */
function recordingClient(mode: 'mock' | 'live') {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const rest = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      return {} as T;
    },
  };
  const client = {
    mode,
    rest,
    request: rest.request,
    sdk: {},
  } as unknown as NutanixClient;
  return { client, calls };
}

function actionCtx(client: NutanixClient, vars: VariableStore): ActionContext {
  return {
    nutanix: client,
    vars,
    cache: { get: () => undefined, set() {}, all: () => [] },
    session: { id: 's', trigram: 'xy9', locale: 'en', clusterProfile: 'hpoc' },
    logger: silentLogger,
    mockOverlay: { set() {}, get: () => undefined } as unknown as ActionContext['mockOverlay'],
  };
}

describe('recovery-point action wiring', () => {
  test('A — stage 13 render yields createRecoveryPoint in every locale', async () => {
    const pack = await loadPack(PACKS_DIR, 'ntnx-infiltration');
    const runner = new StageRunner(pack.stages, pack.checks);
    const stage = pack.stages.find((s) => s.name === STAGE);
    expect(stage).toBeDefined();

    for (const locale of ['en', 'fr', 'de'] as Locale[]) {
      const rendered = runner.render(stage!, new VariableStore(), locale, pack.bundle);
      expect(rendered.actions).toContain('createRecoveryPoint');
    }
  });

  test('A2 — createRecoveryPoint is registered in the pack action registry', async () => {
    const pack = await loadPack(PACKS_DIR, 'ntnx-infiltration');
    expect(pack.actions.get('createRecoveryPoint')).toBeDefined();
  });

  test('B — POSTs a recovery point when VMUUID is captured (live)', async () => {
    const pack = await loadPack(PACKS_DIR, 'ntnx-infiltration');
    const action = pack.actions.get('createRecoveryPoint')!;
    const { client, calls } = recordingClient('live');
    const vars = new VariableStore();
    vars.set('VMUUID', 'vm-abc-123', 'create-vm');

    await action(actionCtx(client, vars));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/dataprotection/v4.0/config/recovery-points',
      body: { vmRecoveryPoints: [{ vmExtId: 'vm-abc-123' }] },
    });
  });

  test('B2 — no POST when VMUUID is missing', async () => {
    const pack = await loadPack(PACKS_DIR, 'ntnx-infiltration');
    const action = pack.actions.get('createRecoveryPoint')!;
    const { client, calls } = recordingClient('live');

    await action(actionCtx(client, new VariableStore()));

    expect(calls).toHaveLength(0);
  });

  test('B3 — no POST in mock mode', async () => {
    const pack = await loadPack(PACKS_DIR, 'ntnx-infiltration');
    const action = pack.actions.get('createRecoveryPoint')!;
    const { client, calls } = recordingClient('mock');
    const vars = new VariableStore();
    vars.set('VMUUID', 'vm-abc-123', 'create-vm');

    await action(actionCtx(client, vars));

    expect(calls).toHaveLength(0);
  });
});

/**
 * End-to-end through the real SessionService: a producer stage captures
 * VMUUID via its check, then entering the consumer stage (which carries the
 * createRecoveryPoint action) must fire the POST — proving VMUUID IS present
 * at dispatch time (i.e. the action is NOT "fired too early").
 */
describe('recovery-point action — full session flow', () => {
  const stages: StageDefinition[] = [
    { index: 0, id: 'welcome', name: 'welcome', active: true, messages: ['w.m1'] },
    { index: 1, id: 'create-vm', name: 'create-vm', active: true, messages: ['v.m1'], check: { fn: 'captureVm' } },
    { index: 2, id: 'verify-iso', name: 'verify-iso', active: true, messages: ['iso.m1'] },
  ];
  const bundle = makeBundle('en', {
    en: {
      'w.m1': 'Welcome',
      'v.m1': 'Create the VM, then continue',
      'iso.m1': "<action name='createRecoveryPoint'/>Now check isolation",
    },
  });

  test('VMUUID captured at create-vm is present when verify-iso fires the action', async () => {
    const { client, calls } = recordingClient('live');
    const checks = new CheckRegistry();
    checks.register('captureVm', async () => ({ pass: true, captured: { VMUUID: 'vm-live-999' } }));

    const realAction = (await loadPack(PACKS_DIR, 'ntnx-infiltration')).actions.get('createRecoveryPoint')!;
    const actions = new ActionRegistry();
    actions.register('createRecoveryPoint', realAction);

    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const service = new SessionService({
      db,
      runner: new StageRunner(stages, checks),
      nutanix: client,
      actions,
      logger: silentLogger,
      packId: 'test-pack',
      bundle,
    });
    const session = await service.create({
      locale: 'en', clusterEndpoint: '10.0.0.1', clusterProfile: 'hpoc', capabilities: [],
    });
    const id = session.id;

    // Walk until we land on verify-iso (the stage carrying the action).
    for (let i = 0; i < 20; i++) {
      const s: any = service.getSession(id);
      if (s.currentStage === 'verify-iso') break;
      if (s.pendingCheck) await service.resolvePendingCheck(id);
      else if (s.awaiting?.variable) await service.submitInput(id, s.awaiting.variable, '');
      else await service.advance(id);
    }

    const rpCall = calls.find((c) => c.path === '/api/dataprotection/v4.0/config/recovery-points');
    expect(rpCall).toBeDefined();
    expect(rpCall!.body).toEqual({ vmRecoveryPoints: [{ vmExtId: 'vm-live-999' }] });
  }, 30_000);
});
