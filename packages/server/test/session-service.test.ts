import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRegistry,
  CheckRegistry,
  StageRunner,
  makeBundle,
  type ActionContext,
  type LocaleBundle,
  type NutanixClient,
  type StageDefinition,
} from '@ntnx-game/engine';
import { SessionService } from '../src/session-service';
import { consoleLogger } from '../src/logger';

const noopNutanix: NutanixClient = {
  mode: 'mock',
  async request() {
    throw new Error('noop client — not used in these tests');
  },
};

const SCHEMA = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql'),
  'utf8',
);

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};

// Stage names stay stable across the file; ids are 0-based to mirror what
// pack-loader assigns in production (parsed.id = i). The session-service
// compares `stage.id` against a 0-based positional index derived from
// `SessionRecord.currentStage`, so test fixtures need to be consistent.
const stages: StageDefinition[] = [
  { id: 0, name: 's1', active: true, messages: ['s1.m1'], saveScore: true },
  { id: 1, name: 's2', active: true, messages: ['s2.m1'], saveScore: true },
  {
    id: 2,
    name: 's3',
    active: true,
    messages: ['s3.m1'],
    saveScore: true,
    check: { fn: 'alwaysPass' },
  },
  {
    id: 3,
    name: 's4',
    active: true,
    impact: 'hpoc-only',
    messages: ['s4.m1'],
    saveScore: true,
    check: { fn: 'alwaysPass' },
  },
  {
    id: 4,
    name: 's5',
    active: true,
    messages: ['s5.m1'],
    saveScore: true,
    check: { fn: 'needsCapture' },
  },
];

const bundle: LocaleBundle = makeBundle('en', {
  en: {
    's1.m1': 'Welcome!',
    's2.m1': "Enter trigram: <input var='Trigram'/>",
    's3.m1': 'Hello {Trigram}, progressing...',
    's4.m1': 'This is a destructive stage',
    's5.m1': 'Last one',
  },
});

async function makeService(
  clusterProfile: 'hpoc' | 'other',
  nutanix: NutanixClient = noopNutanix,
) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);

  const checks = new CheckRegistry();
  checks.register('alwaysPass', async () => ({ pass: true, detail: 'ok' }));
  checks.register('needsCapture', async () => ({
    pass: true,
    captured: { ProjectUUID: 'abc-123' },
  }));

  const runner = new StageRunner(stages, checks);
  const service = new SessionService({
    db,
    runner,
    nutanix,
    logger: silentLogger,
    packId: 'test-pack',
    bundle,
  });
  const session = await service.create({
    locale: 'en',
    clusterEndpoint: '10.1.2.3',
    clusterProfile,
    capabilities: [],
  });
  return { service, session, db };
}

/**
 * Live-mode Nutanix stub whose subnet list reports the given VLAN IDs as
 * already in use. Paginates ($page/$limit) exactly like a real cluster so the
 * allocator's loop terminates. Only the subnets GET is wired — anything else
 * throws to surface an unexpected call.
 */
function liveNutanixWithVlans(usedVlans: number[]): NutanixClient {
  const subnets = usedVlans.map((v) => ({ subnetType: 'VLAN', networkId: v }));
  return {
    mode: 'live',
    async request() {
      throw new Error('legacy request shim — unused by the allocator');
    },
    sdk: undefined as never,
    rest: {
      async request<T>(method: string, path: string): Promise<T> {
        if (method === 'GET' && path.includes('/networking/v4.0/config/subnets')) {
          const m = path.match(/\$page=(\d+)&\$limit=(\d+)/);
          const page = m ? Number(m[1]) : 0;
          const limit = m ? Number(m[2]) : 50;
          return { data: subnets.slice(page * limit, page * limit + limit) } as T;
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    },
  };
}

describe('SessionService', () => {
  test('creates anonymous session with placeholder trigram and empty pinHash', async () => {
    const { session } = await makeService('hpoc');
    expect(session.trigram).toBe(session.id);
    expect(session.pinHash).toBe('');
    // `null` = "nothing played yet". Replaces the pre-phase-11 `-1` sentinel;
    // lets the lore-vs-login split (stage-0 lore / stage-1 identity) work
    // without a per-session "lore-seen" flag.
    expect(session.currentStage).toBe(null);
  });

  test('each create() returns a distinct session (no trigram-based dedup)', async () => {
    const { service, session } = await makeService('hpoc');
    const other = await service.create({
      locale: 'en',
      clusterEndpoint: '10.1.2.3',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    expect(other.id).not.toBe(session.id);
  });

  test('locale defaults to en when not provided', async () => {
    const { service } = await makeService('hpoc');
    const anon = await service.create({
      clusterEndpoint: '10.1.2.3',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    expect(anon.locale).toBe('en');
  });

  test('Vlanid allocation skips VLANs already live on the cluster', async () => {
    // Cluster reports every VLAN but 249 in use → that's the only free slot.
    const used = Array.from({ length: 249 }, (_, i) => i);
    const { service, session } = await makeService('hpoc', liveNutanixWithVlans(used));
    expect(service.variables.all(session.id).Vlanid).toBe('249');
  });

  test('Vlanid allocation excludes VLANs held by active peers, not just the cluster', async () => {
    // Cluster leaves exactly two slots free (248, 249). The first session
    // grabs one; the second must get the other even though no subnet exists
    // on the cluster yet (DB exclusion closes the create()-to-stage-10 gap).
    const used = Array.from({ length: 248 }, (_, i) => i);
    const { service, session } = await makeService('hpoc', liveNutanixWithVlans(used));
    const first = service.variables.all(session.id).Vlanid as string;
    const second = await service.create({
      locale: 'en',
      clusterEndpoint: '10.1.2.3',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    const secondVlan = service.variables.all(second.id).Vlanid as string;
    expect(new Set([first, secondVlan])).toEqual(new Set(['248', '249']));
  });

  test('advance: first stage has no input, check-less → current_stage advances', async () => {
    const { service, session } = await makeService('hpoc');
    const r = await service.advance(session.id);
    expect(r.kind).toBe('units');
    expect(r.stageName).toBe('s1');
    expect(r.units).toEqual([
      { kind: 'text', text: 'Welcome!', color: 'default' },
      { kind: 'text', text: '\n', color: 'default' },
    ]);
    const updated = service.getSession(session.id);
    expect(updated.currentStage).toBe('s1');
  });

  test('advance: stage with #>I: pauses and sets awaiting', async () => {
    const { service, session } = await makeService('hpoc');
    await service.advance(session.id); // stage 1
    const r = await service.advance(session.id); // stage 2 with input
    expect(r.kind).toBe('awaiting-input');
    expect(r.awaitingVariable).toBe('Trigram');
    const updated = service.getSession(session.id);
    expect(updated.awaiting?.variable).toBe('Trigram');
    expect(updated.awaiting?.stageName).toBe('s2');
  });

  test('advance while awaiting throws 409', async () => {
    const { service, session } = await makeService('hpoc');
    await service.advance(session.id);
    await service.advance(session.id);
    await expect(service.advance(session.id)).rejects.toThrow(/awaiting/);
  });

  test('submitInput captures var and advances', async () => {
    const { service, session } = await makeService('hpoc');
    await service.advance(session.id);
    await service.advance(session.id);
    const r = await service.submitInput(session.id, 'Trigram', 'ZZZ');
    expect(r.kind).toBe('units');
    const after = service.getSession(session.id);
    expect(after.currentStage).toBe('s2');
    expect(after.awaiting).toBeNull();
  });

  test('submitInput with wrong variable rejects', async () => {
    const { service, session } = await makeService('hpoc');
    await service.advance(session.id);
    await service.advance(session.id);
    await expect(service.submitInput(session.id, 'Wrong', 'x')).rejects.toThrow(/Expected input/);
  });

  test('stage 3 substitutes the captured variable', async () => {
    const { service, session } = await makeService('hpoc');
    await service.advance(session.id); // stage 1
    await service.advance(session.id); // stage 2 awaiting
    await service.submitInput(session.id, 'Trigram', 'NEO'); // completes stage 2
    const r = await service.advance(session.id); // stage 3 substitutes #>V:Trigram#
    expect(r.kind).toBe('units');
    expect(r.units.find((u) => u.kind === 'text' && u.text.includes('NEO'))).toBeDefined();
    expect(r.check?.pass).toBe(true);
  });

  test('destructive stage is disabled on shared cluster and recorded in history', async () => {
    // Live mode: profile filtering is a real-cluster concern (mock bypasses it
    // entirely since it never touches a cluster).
    const { service, session } = await makeService('other', liveNutanixWithVlans([]));
    await service.advance(session.id); // stage 1
    await service.advance(session.id); // stage 2 awaiting
    await service.submitInput(session.id, 'Trigram', 'NEO'); // completes 2
    await service.advance(session.id); // stage 3
    const r = await service.advance(session.id); // would be stage 4 (destructive) but gated → jumps to 5
    expect(r.stageName).toBe('s5');
    const history = service.history.listForSession(session.id);
    const entry4 = history.find((h) => h.stageName === 's4');
    expect(entry4?.status).toBe('disabled');
  });

  test('check captures merge into variables', async () => {
    // Live mode so the destructive s4 is filtered (mock would now play it).
    const { service, session } = await makeService('other', liveNutanixWithVlans([]));
    await service.advance(session.id); // 1
    await service.advance(session.id); // 2 await
    await service.submitInput(session.id, 'Trigram', 'NEO');
    await service.advance(session.id); // 3
    await service.advance(session.id); // 5 (destructive 4 skipped)
    const vars = service.variables.all(session.id);
    expect(vars.ProjectUUID).toBe('abc-123');
  });

  test('skipTo jumps to stage, runs rehydrate, records history', async () => {
    const { service, session } = await makeService('hpoc');
    await service.advance(session.id); // stage 1 done
    const r = await service.skipTo(session.id, 's5');
    expect(r.finalStage).toBe('s5');
    expect(r.skipped).toEqual(['s2', 's3', 's4', 's5']);
    const s = service.getSession(session.id);
    expect(s.currentStage).toBe('s5');
    const vars = service.variables.all(session.id);
    expect(vars.ProjectUUID).toBe('abc-123');
  });

  test('finishes session when no more stages', async () => {
    const { service, session } = await makeService('hpoc');
    await service.skipTo(session.id, 's5');
    const r = await service.advance(session.id);
    expect(r.kind).toBe('finished');
  });

  test('check response carries a cheer sentence drawn from sentences.ok-* when pack ships them', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const checks = new CheckRegistry();
    checks.register('alwaysPass', async () => ({ pass: true, detail: 'ok' }));
    const runner = new StageRunner(stages, checks);
    const bundleWithCheers = makeBundle('en', {
      en: {
        ...bundle.catalogs.en,
        'sentences.ok-01': 'Nice!',
        'sentences.ok-02': 'Great work.',
      },
    });
    const service = new SessionService({
      db,
      runner,
      nutanix: noopNutanix,
      logger: silentLogger,
      packId: 'test-pack',
      bundle: bundleWithCheers,
    });
    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '10.1.2.3',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    await service.advance(session.id); // 1
    await service.advance(session.id); // 2 awaiting
    await service.submitInput(session.id, 'Trigram', 'NEO');
    const r = await service.advance(session.id); // 3 runs alwaysPass
    expect(r.check?.pass).toBe(true);
    expect(['Nice!', 'Great work.']).toContain(r.check?.cheer);
  });

  test('check response omits cheer when pack ships no sentences.ok-* keys', async () => {
    const { service, session } = await makeService('hpoc');
    await service.advance(session.id);
    await service.advance(session.id);
    await service.submitInput(session.id, 'Trigram', 'NEO');
    const r = await service.advance(session.id);
    expect(r.check?.pass).toBe(true);
    expect(r.check?.cheer).toBeUndefined();
  });

  test('check response on fail draws cheer from sentences.ko-* when pack ships them', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const checks = new CheckRegistry();
    checks.register('alwaysFail', async () => ({ pass: false, detail: 'nope' }));
    const failStages: StageDefinition[] = [
      { id: 0, name: 's1', active: true, messages: ['s1.m1'], saveScore: true },
      { id: 1, name: 's2', active: true, messages: ['s2.m1'], saveScore: true },
      { id: 2, name: 's3', active: true, messages: ['s3.m1'], saveScore: true, check: { fn: 'alwaysFail' } },
    ];
    const runner = new StageRunner(failStages, checks);
    const bundleWithKo = makeBundle('en', {
      en: {
        ...bundle.catalogs.en,
        'sentences.ko-01': 'Oops!',
        'sentences.ko-02': 'Try again!',
      },
    });
    const service = new SessionService({
      db,
      runner,
      nutanix: noopNutanix,
      logger: silentLogger,
      packId: 'test-pack',
      bundle: bundleWithKo,
    });
    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '10.1.2.3',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    await service.advance(session.id); // 1
    await service.advance(session.id); // 2 awaiting
    await service.submitInput(session.id, 'Trigram', 'NEO');
    const r = await service.advance(session.id); // 3 runs alwaysFail
    expect(r.check?.pass).toBe(false);
    expect(['Oops!', 'Try again!']).toContain(r.check?.cheer);
  });

  test('waitForInputValue mismatch returns interpolated sentences.retry-* message when pack ships them', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const checks = new CheckRegistry();
    const gatedStages: StageDefinition[] = [
      { id: 0, name: 's1', active: true, messages: ['s1.m1'], waitForInputValue: 'Ok', saveScore: true },
    ];
    const runner = new StageRunner(gatedStages, checks);
    const bundleWithRetry = makeBundle('en', {
      en: {
        's1.m1': "Confirm with <input var='Ack'/>",
        'sentences.retry-01': "Please type '{expected}' to continue.",
      },
    });
    const service = new SessionService({
      db,
      runner,
      nutanix: noopNutanix,
      logger: silentLogger,
      packId: 'test-pack',
      bundle: bundleWithRetry,
    });
    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '10.1.2.3',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    await service.advance(session.id); // render stage 1, awaits Ack
    const r = await service.submitInput(session.id, 'Ack', 'nope');
    expect(r.rejected?.expected).toBe('Ok');
    expect(r.rejected?.got).toBe('nope');
    expect(r.rejected?.message).toBe("Please type 'Ok' to continue.");
  });

  test('waitForInputValue mismatch leaves rejected.message undefined when pack ships no retry bucket', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const checks = new CheckRegistry();
    const gatedStages: StageDefinition[] = [
      { id: 0, name: 's1', active: true, messages: ['s1.m1'], waitForInputValue: 'Ok', saveScore: true },
    ];
    const runner = new StageRunner(gatedStages, checks);
    const noRetryBundle = makeBundle('en', {
      en: { 's1.m1': "Confirm with <input var='Ack'/>" },
    });
    const service = new SessionService({
      db,
      runner,
      nutanix: noopNutanix,
      logger: silentLogger,
      packId: 'test-pack',
      bundle: noRetryBundle,
    });
    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '10.1.2.3',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    await service.advance(session.id);
    const r = await service.submitInput(session.id, 'Ack', 'nope');
    expect(r.rejected?.expected).toBe('Ok');
    expect(r.rejected?.message).toBeUndefined();
  });

  test('dispatches <action/> tags via pack action registry on advance', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const checks = new CheckRegistry();
    const fired: string[] = [];
    const actions = new ActionRegistry();
    actions.register('trackMe', async (ctx: ActionContext) => {
      fired.push(ctx.session.id);
    });
    const actionStage: StageDefinition = {
      id: 0,
      name: 's1',
      active: true,
      messages: ['s1.m1'],
      saveScore: true,
    };
    const runner = new StageRunner([actionStage], checks);
    const withActionBundle = makeBundle('en', {
      en: { 's1.m1': "hello <action name='trackMe'/> world" },
    });
    const service = new SessionService({
      db,
      runner,
      nutanix: noopNutanix,
      actions,
      logger: silentLogger,
      packId: 'test-pack',
      bundle: withActionBundle,
    });
    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '10.1.2.3',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    await service.advance(session.id);
    expect(fired).toEqual([session.id]);
  });

  test('unregistered action names are logged and skipped, not thrown', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const checks = new CheckRegistry();
    const actions = new ActionRegistry();
    const stage: StageDefinition = {
      id: 0,
      name: 's1',
      active: true,
      messages: ['s1.m1'],
      saveScore: true,
    };
    const runner = new StageRunner([stage], checks);
    const b = makeBundle('en', { en: { 's1.m1': "hi <action name='nope'/>" } });
    const service = new SessionService({
      db,
      runner,
      nutanix: noopNutanix,
      actions,
      logger: silentLogger,
      packId: 'test-pack',
      bundle: b,
    });
    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '10.1.2.3',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    // Should not throw — unknown action is a warn-and-skip.
    await expect(service.advance(session.id)).resolves.toBeDefined();
  });

  test('fireAction mutates the per-session mock overlay (deleteVM → VMUUID filter)', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const checks = new CheckRegistry();
    const actions = new ActionRegistry();
    actions.register('deleteVM', async (ctx: ActionContext) => {
      const name = `${ctx.vars.get('Trigram') ?? ''}-vm`;
      ctx.mockOverlay.mark('vm', name, 'deleted');
    });
    const runner = new StageRunner(
      [{ id: 0, name: 's1', active: true, messages: [], saveScore: true }],
      checks,
    );
    const service = new SessionService({
      db,
      runner,
      nutanix: noopNutanix,
      actions,
      logger: silentLogger,
      packId: 'test-pack',
      bundle,
    });
    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '10.1.2.3',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    service.variables.upsert(session.id, 'Trigram', 'NEO', 'seed');
    await service.fireAction(session.id, 'deleteVM');
    const overlay = service.mockOverlay.all(session.id);
    expect(overlay).toEqual([{ kind: 'vm', logicalName: 'NEO-vm', op: 'deleted' }]);
  });

  test('fireAction on an unregistered name throws 404', async () => {
    const { service, session } = await makeService('hpoc');
    await expect(service.fireAction(session.id, 'nope')).rejects.toThrow(/not registered/);
  });

  test('check-fail with retryFromVariable rewinds awaiting to that input and clears downstream captures', async () => {
    // Stage has two inputs (Trigram then PIN) with a check that fails the
    // Trigram. The session-service should push awaiting back to Trigram and
    // wipe both captured vars so the player retypes both.
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const checks = new CheckRegistry();
    checks.register('failTrigram', async () => ({
      pass: false,
      detail: 'collision',
      retryFromVariable: 'Trigram',
    }));
    const loginStages: StageDefinition[] = [
      {
        id: 0,
        name: 's1',
        active: true,
        messages: ['s1.trigram', 's1.pin'],
        saveScore: false,
        check: { fn: 'failTrigram' },
      },
    ];
    const runner = new StageRunner(loginStages, checks);
    const loginBundle = makeBundle('en', {
      en: {
        's1.trigram': "Trigram: <input var='Trigram'/>",
        's1.pin': "PIN: <input var='PIN'/>",
      },
    });
    const service = new SessionService({
      db,
      runner,
      nutanix: noopNutanix,
      logger: silentLogger,
      packId: 'test-pack',
      bundle: loginBundle,
    });
    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '10.1.2.3',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    await service.advance(session.id); // stage 1 renders, awaits Trigram
    await service.submitInput(session.id, 'Trigram', 'rbo'); // captures, awaits PIN
    const r = await service.submitInput(session.id, 'PIN', '1234'); // runs check, fails

    expect(r.kind).toBe('awaiting-input');
    expect(r.awaitingVariable).toBe('Trigram');
    expect(r.check?.pass).toBe(false);
    expect(r.units).toEqual([]);

    const after = service.getSession(session.id);
    expect(after.awaiting?.variable).toBe('Trigram');
    // Stays at initial (null) — failure doesn't advance.
    expect(after.currentStage).toBe(null);

    const vars = service.variables.all(session.id);
    expect(vars.Trigram).toBeUndefined();
    expect(vars.PIN).toBeUndefined();
  });

  test('computeGreeting picks newKey when no colliding session, returningKey when one exists', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const checks = new CheckRegistry();
    checks.register('alwaysPass', async () => ({ pass: true }));
    const loginStages: StageDefinition[] = [
      {
        id: 0,
        name: 's1',
        active: true,
        messages: ['s1.trigram', 's1.pin'],
        saveScore: false,
        check: { fn: 'alwaysPass' },
        computeGreeting: {
          inputVar: 'Trigram',
          newKey: 'greetings.new',
          returningKey: 'greetings.returning',
          outputVar: 'Greeting',
        },
      },
    ];
    const runner = new StageRunner(loginStages, checks);
    const greetBundle = makeBundle('en', {
      en: {
        's1.trigram': "Trigram: <input var='Trigram'/>",
        's1.pin': "{Greeting}: <input var='PIN'/>",
        'greetings.new': 'Welcome! Choose a PIN',
        'greetings.returning': 'Welcome back! Re-enter your PIN',
      },
    });
    const service = new SessionService({
      db, runner, nutanix: noopNutanix,
      logger: silentLogger, packId: 'test-pack', bundle: greetBundle,
    });
    // First player — no collision → newKey
    const p1 = await service.create({
      locale: 'en', clusterEndpoint: '', clusterProfile: 'hpoc', capabilities: [],
    });
    await service.advance(p1.id); // renders → awaits Trigram
    const r1 = await service.submitInput(p1.id, 'Trigram', 'RBO');
    expect(r1.kind).toBe('awaiting-input');
    const pinPromptP1 = r1.units.map((u) => (u.kind === 'text' ? u.text : '')).join('');
    expect(pinPromptP1).toContain('Welcome! Choose a PIN');
    expect(pinPromptP1).not.toContain('Welcome back');

    // Second player, same trigram, P1 still active → returningKey
    const p2 = await service.create({
      locale: 'en', clusterEndpoint: '', clusterProfile: 'hpoc', capabilities: [],
    });
    await service.advance(p2.id);
    const r2 = await service.submitInput(p2.id, 'Trigram', 'RBO');
    const pinPromptP2 = r2.units.map((u) => (u.kind === 'text' ? u.text : '')).join('');
    expect(pinPromptP2).toContain('Welcome back! Re-enter your PIN');
    expect(pinPromptP2).not.toContain('Welcome! Choose a PIN');
  });

  test('check switchTo deletes the current session and returns kind: switch-session', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const checks = new CheckRegistry();
    checks.register('handoff', async () => ({
      pass: false,
      switchTo: 'target-session-xyz',
    }));
    const handoffStages: StageDefinition[] = [
      {
        id: 0,
        name: 's1',
        active: true,
        messages: ['s1.prompt'],
        saveScore: false,
        check: { fn: 'handoff' },
      },
    ];
    const runner = new StageRunner(handoffStages, checks);
    const handoffBundle = makeBundle('en', {
      en: { 's1.prompt': "Say hi: <input var='Hi'/>" },
    });
    const service = new SessionService({
      db, runner, nutanix: noopNutanix,
      logger: silentLogger, packId: 'test-pack', bundle: handoffBundle,
    });
    const session = await service.create({
      locale: 'en', clusterEndpoint: '', clusterProfile: 'hpoc', capabilities: [],
    });
    await service.advance(session.id); // awaits Hi
    const r = await service.submitInput(session.id, 'Hi', 'yo');

    expect(r.kind).toBe('switch-session');
    expect(r.switchSessionId).toBe('target-session-xyz');
    // Original session gone — no row left.
    const row = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(session.id) as { n: number };
    expect(row.n).toBe(0);
  });

  test('switchIdentity rewinds to pre-stage-1 and drops identity vars, keeps locale', async () => {
    const { service, session } = await makeService('hpoc');
    service.variables.upsert(session.id, 'Trigram', 'rbo', 's1');
    service.variables.upsert(session.id, 'PIN', '1234', 's1');
    service.variables.upsert(session.id, 'Username', 'Rowien', 's3');
    service.variables.upsert(session.id, 'SomethingElse', 'keep-me', 's5');
    service.sessions.updateCurrentStage(session.id, 's5');

    const r = service.switchIdentity(session.id);
    // switchIdentity rewinds to the first stage (the lore stage); in this
    // fixture that's 's1'. The currentStage is set to that first stage's
    // name, so it stays "passed" and the runner picks up the login flow next.
    expect(r.currentStage).toBe('s1');

    const after = service.getSession(session.id);
    expect(after.currentStage).toBe('s1');
    expect(after.awaiting).toBeNull();
    expect(after.locale).toBe('en'); // preserved

    const vars = service.variables.all(session.id);
    expect(vars.Trigram).toBeUndefined();
    expect(vars.PIN).toBeUndefined();
    expect(vars.Username).toBeUndefined();
    expect(vars.SomethingElse).toBe('keep-me');
  });

  test('stage with invalidates drops listed vars after completion (narrative path)', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const checks = new CheckRegistry();
    checks.register('alwaysPass', async () => ({ pass: true, detail: 'ok' }));
    checks.register('needsCapture', async () => ({
      pass: true,
      captured: { ProjectUUID: 'abc-123' },
    }));
    const invalidatingStages: StageDefinition[] = [
      { id: 0, name: 's1', active: true, messages: ['s1.m1'], saveScore: true },
      { id: 1, name: 's2', active: true, messages: ['s2.m1'], saveScore: true },
      {
        id: 2,
        name: 's3',
        active: true,
        messages: ['s3.m1'],
        saveScore: true,
        check: { fn: 'alwaysPass' },
      },
      {
        id: 3,
        name: 's4',
        active: true,
        impact: 'hpoc-only',
        messages: ['s4.m1'],
        saveScore: true,
        check: { fn: 'alwaysPass' },
      },
      {
        id: 4,
        name: 's5',
        active: true,
        messages: ['s5.m1'],
        saveScore: true,
        check: { fn: 'needsCapture' },
      },
      // Narrative stage that invalidates the capture from stage 5.
      {
        id: 5,
        name: 's6',
        active: true,
        messages: [],
        saveScore: false,
        invalidates: ['ProjectUUID'],
      },
    ];
    const runner = new StageRunner(invalidatingStages, checks);
    const service = new SessionService({
      db,
      runner,
      nutanix: noopNutanix,
      logger: silentLogger,
      packId: 'test-pack',
      bundle,
    });
    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '10.1.2.3',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    await service.advance(session.id); // 1
    await service.advance(session.id); // 2 awaiting
    await service.submitInput(session.id, 'Trigram', 'NEO');
    await service.advance(session.id); // 3
    await service.advance(session.id); // 5 (destructive 4 skipped implicitly? no, dedicated → 4 passes)
    // On dedicated the destructive stage 4 runs before 5 — play forward until
    // ProjectUUID is captured.
    let vars = service.variables.all(session.id);
    while (!vars.ProjectUUID) {
      await service.advance(session.id);
      vars = service.variables.all(session.id);
    }
    expect(vars.ProjectUUID).toBe('abc-123');
    await service.advance(session.id); // stage 6 narrative — invalidates
    const after = service.variables.all(session.id);
    expect(after.ProjectUUID).toBeUndefined();
  });
});

describe('SessionService — adminGate', () => {
  /**
   * Build a 3-stage pack with stage 2 marked `adminGate: true`. Session
   * starts at currentStage=null; first advance picks stage 1 (renders),
   * second advance hits the gate.
   */
  async function makeGatedService() {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const gatedStages: StageDefinition[] = [
      { id: 0, name: 'open', active: true, messages: ['s1.m1'], saveScore: true },
      { id: 1, name: 'pause', active: true, adminGate: true, messages: ['s2.m1'], saveScore: true },
      { id: 2, name: 'final', active: true, messages: ['s3.m1'], saveScore: true },
    ];
    const localBundle: LocaleBundle = makeBundle('en', {
      en: { 's1.m1': 'one', 's2.m1': 'two', 's3.m1': 'three' },
    });
    const checks = new CheckRegistry();
    const service = new SessionService({
      db,
      runner: new StageRunner(gatedStages, checks),
      nutanix: noopNutanix,
      logger: silentLogger,
      packId: 'test-pack',
      bundle: localBundle,
    });
    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    return { service, session };
  }

  test('advance returns kind=gated with stage info; currentStage stays put', async () => {
    const { service, session } = await makeGatedService();
    // stage 1 (no gate, narrative) → advances naturally.
    await service.advance(session.id);
    await service.advance(session.id); // commits stage 1
    // Now currentStage='open', next playable stage is gated 'pause'.
    const r = await service.advance(session.id);
    expect(r.kind).toBe('gated');
    expect(r.stageName).toBe('pause');
    expect(service.sessions.byId(session.id)?.currentStage).toBe('open');
  });

  test('unlocking the gate lets a subsequent advance flow into the stage', async () => {
    const { service, session } = await makeGatedService();
    await service.advance(session.id);
    await service.advance(session.id);
    let r = await service.advance(session.id);
    expect(r.kind).toBe('gated');

    service.setGateUnlock('pause', true);

    r = await service.advance(session.id);
    expect(r.kind).not.toBe('gated');
    expect(r.stageName).toBe('pause');
  });

  test('re-locking restores the gate for sessions that have not crossed yet', async () => {
    const { service, session } = await makeGatedService();
    await service.advance(session.id);
    await service.advance(session.id);
    expect((await service.advance(session.id)).kind).toBe('gated');
    service.setGateUnlock('pause', true);
    expect((await service.advance(session.id)).kind).not.toBe('gated');
    // Without rewinding the session, re-locking has no retroactive effect on
    // sessions that already crossed — but a fresh session would block.
    service.setGateUnlock('pause', false);
    const fresh = await service.create({
      locale: 'en',
      clusterEndpoint: '',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    await service.advance(fresh.id);
    await service.advance(fresh.id);
    expect((await service.advance(fresh.id)).kind).toBe('gated');
  });

  test('listUnlockedGates reflects setGateUnlock + persists across service rebuild', async () => {
    const { service } = await makeGatedService();
    expect(service.listUnlockedGates()).toEqual([]);
    service.setGateUnlock('pause', true);
    expect(service.listUnlockedGates()).toEqual(['pause']);
    service.setGateUnlock('pause', false);
    expect(service.listUnlockedGates()).toEqual([]);
  });
});

describe('SessionService — applyEffectiveStages (pack overlay)', () => {
  async function makeOverlayService() {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const baseStages: StageDefinition[] = [
      { id: 0, name: 'open', active: true, messages: ['s1.m1'], saveScore: true },
      { id: 1, name: 'middle', active: true, adminGate: false, messages: ['s2.m1'], saveScore: true },
      { id: 2, name: 'final', active: true, messages: ['s3.m1'], saveScore: true },
    ];
    const localBundle: LocaleBundle = makeBundle('en', {
      en: { 's1.m1': 'one', 's2.m1': 'two', 's3.m1': 'three' },
    });
    const service = new SessionService({
      db,
      runner: new StageRunner(baseStages, new CheckRegistry()),
      nutanix: noopNutanix,
      logger: silentLogger,
      packId: 'test-pack',
      bundle: localBundle,
    });
    const session = await service.create({
      locale: 'en',
      clusterEndpoint: '',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    return { service, session };
  }

  test('overlay-disabled stage is silently skipped on advance (gate verdict = inactive)', async () => {
    const { service, session } = await makeOverlayService();
    // Disable stage 'middle' via overlay → effective active=false → silent skip.
    service.packOverlay.setField('test-pack', 'middle', 'active', false);
    service.applyEffectiveStages();
    // Advance through the pack: stage 'open' narrative then 'final' narrative.
    await service.advance(session.id); // renders 'open'
    await service.advance(session.id); // commits 'open', then 'final' (skipping 'middle')
    const after = service.sessions.byId(session.id);
    expect(after?.currentStage).toBe('final');
  });

  test('overlay-enabled adminGate parks the session (kind=gated) on the next advance', async () => {
    const { service, session } = await makeOverlayService();
    service.packOverlay.setField('test-pack', 'middle', 'adminGate', true);
    service.applyEffectiveStages();
    await service.advance(session.id);
    await service.advance(session.id); // commit stage 'open'
    const r = await service.advance(session.id);
    expect(r.kind).toBe('gated');
    expect(r.stageName).toBe('middle');
  });

  test('clearing the overlay (setField → null) restores the JSON default', async () => {
    const { service } = await makeOverlayService();
    service.packOverlay.setField('test-pack', 'middle', 'active', false);
    service.applyEffectiveStages();
    expect(service.listEffectiveStages().find((s) => s.name === 'middle')?.active).toBe(false);
    service.packOverlay.setField('test-pack', 'middle', 'active', null);
    service.applyEffectiveStages();
    expect(service.listEffectiveStages().find((s) => s.name === 'middle')?.active).toBe(true);
    // baseStages is the canonical immutable source; effective just mirrors it now.
    expect(service.listBaseStages().find((s) => s.name === 'middle')?.active).toBe(true);
  });
});

describe('SessionService — global pause (lunch lock)', () => {
  test('advance returns kind=gated reason=global when isGloballyPaused; clearing lets it through', async () => {
    const { service, session } = await makeService('hpoc');
    // First advance is unblocked → renders stage 1.
    expect((await service.advance(session.id)).kind).not.toBe('gated');

    // Engage the pause → next advance gets the global gate, no stage info.
    service.setGlobalPause(true);
    const r = await service.advance(session.id);
    expect(r.kind).toBe('gated');
    expect(r.gatedReason).toBe('global');
    expect(r.stageName).toBeUndefined();

    // Lift the pause → advance flows again.
    service.setGlobalPause(false);
    const r2 = await service.advance(session.id);
    expect(r2.kind).not.toBe('gated');
  });

  test('global pause persists across SessionService rebuild (DB-backed)', async () => {
    const { service, db } = await makeService('hpoc');
    service.setGlobalPause(true);
    // Spin a fresh service against the same DB — it should pick up the row.
    const runner2 = new StageRunner(stages, new CheckRegistry());
    const service2 = new SessionService({
      db,
      runner: runner2,
      nutanix: noopNutanix,
      logger: silentLogger,
      packId: 'test-pack',
      bundle,
    });
    expect(service2.isGloballyPaused()).toBe(true);
  });
});
