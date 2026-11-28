import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { resolve } from 'node:path';
import { ActionRegistry, CheckRegistry, StageRunner, VariableStore, makeBundle, type ActionContext, type ClusterCacheEntry, type Locale, type NutanixClient, type StageDefinition } from '@ntnx-game/engine';
import { loadPack } from '../src/pack-loader';
import { SessionService } from '../src/session-service';
import { openDatabase } from '../src/db/database';

const PACKS = resolve(import.meta.dir, '../../../packs');
const logger = { debug() {}, info() {}, warn() {}, error() {} };
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = undefined; });

function recordingClient() {
  const posts: Array<{ body: any; requestId: string | null }> = [];
  const state = { vm: '', ready: false, taskStatus: 'SUCCEEDED', taskReadError: false, lostPostResponse: false };
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    state.vm = body.vmRecoveryPoints[0].vmExtId;
    posts.push({ body, requestId: new Headers(init?.headers).get('Ntnx-Request-Id') });
    if (state.lostPostResponse) { state.lostPostResponse = false; throw new Error('response lost'); }
    return Response.json({ data: { extId: 'snapshot-task' } });
  });
  const rest = { async request<T>(_method: string, path: string): Promise<T> {
    if (path.includes('/tasks/')) {
      if (state.taskReadError) { state.taskReadError = false; throw new Error('temporary task read failure'); }
      if (state.taskStatus === 'SUCCEEDED') state.ready = true;
      return { data: { status: state.taskStatus } } as T;
    }
    return { data: state.ready ? [{ name: 'xy9-game-recovery', extId: 'point', status: 'COMPLETE', vmRecoveryPoints: [{ vmExtId: state.vm, extId: 'vm-point' }] }] : [] } as T;
  } };
  return { posts, state, client: { mode: 'live', rest, request: rest.request, sdk: {} } as unknown as NutanixClient };
}

function actionContext(client: NutanixClient): ActionContext {
  const vars = new VariableStore();
  for (const [key, value] of Object.entries({ PC: 'https://pc.invalid', PCUser: 'admin', PCPassword: 'test', Trigram: 'xy9' })) vars.set(key, value, 'test');
  const cache = new Map<string, ClusterCacheEntry>();
  return { nutanix: client, vars,
    cache: { get: (kind, name) => cache.get(`${kind}:${name}`), set: entry => { cache.set(`${entry.kind}:${entry.logicalName}`, entry); }, all: () => [...cache.values()] },
    session: { id: 'session', trigram: 'xy9', locale: 'en', clusterProfile: 'other' }, logger,
    mockOverlay: { mark() {}, unmark() {}, list: () => [] },
  };
}

async function realAction() { return (await loadPack(PACKS, 'ntnx-infiltration')).actions.get('createRecoveryPoint')!; }

describe('recovery-point action', () => {
  test('pack declares the required action on VM validation, never isolation narration, in every locale', async () => {
    const pack = await loadPack(PACKS, 'ntnx-infiltration');
    expect(pack.stages.find(s => s.name === 'create-vm')?.onSuccessActions).toEqual(['createRecoveryPoint']);
    expect(pack.stages.find(s => s.name === 'incident-freeze')?.dependsOn).toEqual(['create-vm']);
    const runner = new StageRunner(pack.stages, pack.checks);
    for (const locale of ['en', 'fr', 'de', 'es', 'it'] as Locale[]) {
      const stage = pack.stages.find(s => s.name === 'verify-prod-user-isolation')!;
      expect(runner.render(stage, new VariableStore(), locale, pack.bundle).actions).not.toContain('createRecoveryPoint');
    }
  });
  test('creates the recovery point once and reuses a completed point', async () => {
    const action = await realAction();
    const { client, posts } = recordingClient();
    const ctx = actionContext(client);
    ctx.vars.set('VMUUID', 'vm-one');
    await action(ctx); await action(ctx);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ name: 'xy9-game-recovery', vmRecoveryPoints: [{ vmExtId: 'vm-one' }] });
  });
  test('missing VMUUID fails instead of silently validating a missing backup', async () => {
    const action = await realAction();
    const { client, posts } = recordingClient();
    await expect(action(actionContext(client))).rejects.toThrow('VMUUID missing');
    expect(posts).toHaveLength(0);
  });
  test('mock never posts to a cluster', async () => {
    const action = await realAction();
    const { client, posts } = recordingClient();
    await action(actionContext({ ...client, mode: 'mock' }));
    expect(posts).toHaveLength(0);
  });
  test('a transient task read error retries the same task without another POST', async () => {
    const action = await realAction();
    const { client, posts, state } = recordingClient();
    const ctx = actionContext(client); ctx.vars.set('VMUUID', 'vm-one');
    state.taskReadError = true;
    await expect(action(ctx)).rejects.toThrow('temporary task read failure');
    await action(ctx);
    expect(posts).toHaveLength(1);
  });
  test('a terminal failed task permits a fresh attempt with a new request ID', async () => {
    const action = await realAction();
    const { client, posts, state } = recordingClient();
    const ctx = actionContext(client); ctx.vars.set('VMUUID', 'vm-one');
    state.taskStatus = 'FAILED';
    await expect(action(ctx)).rejects.toThrow('terminal: FAILED');
    state.taskStatus = 'SUCCEEDED';
    await action(ctx);
    expect(posts).toHaveLength(2);
    expect(posts[0]!.requestId).not.toBe(posts[1]!.requestId);
  });
  test('lost POST response retries with the same idempotency key', async () => {
    const action = await realAction();
    const { client, posts, state } = recordingClient();
    const ctx = actionContext(client); ctx.vars.set('VMUUID', 'vm-one');
    state.lostPostResponse = true;
    await expect(action(ctx)).rejects.toThrow('response lost');
    await action(ctx);
    expect(posts).toHaveLength(2);
    expect(posts[0]!.requestId).toBeTruthy();
    expect(posts[0]!.requestId).toBe(posts[1]!.requestId);
  });
});

async function flow(options: { pass?: boolean; neutral?: boolean; action?: (ctx: ActionContext) => Promise<void> } = {}) {
  const stages: StageDefinition[] = [
    { index: 0, id: 'intro', name: 'intro', active: true, messages: ['intro'] },
    { index: 1, id: 'create-vm', name: 'create-vm', active: true, messages: ['vm'], check: { fn: 'CheckVM' }, onSuccessActions: ['backup'], invalidates: ['OldValue'] },
    { index: 2, id: 'isolation', name: 'isolation', active: true, messages: ['isolation'] },
  ];
  const checks = new CheckRegistry();
  checks.register('CheckVM', async () => ({ pass: options.pass ?? true, neutral: options.neutral, captured: { VMUUID: 'vm-one' } }));
  const actions = new ActionRegistry();
  actions.register('backup', options.action ?? (async () => {}));
  const db = openDatabase({ path: ':memory:' });
  const deps = { db, runner: new StageRunner(stages, checks), actions,
    nutanix: { mode: 'mock', async request() { throw new Error('unexpected request'); } } as NutanixClient,
    logger, packId: 'test', bundle: makeBundle('en', { en: { intro: 'Hello', vm: "Create VM<input/>", isolation: 'Check isolation' } }),
  };
  const service = new SessionService(deps);
  const session = await service.create({ locale: 'en', clusterEndpoint: '', clusterProfile: 'other', capabilities: [] });
  service.variables.upsert(session.id, 'OldValue', 'keep until success', 'intro');
  await service.advance(session.id); await service.advance(session.id);
  await service.submitInput(session.id, '$continue', '');
  return { service, id: session.id, db, deps };
}

describe('required success action flow', () => {
  test('goto and skip cannot change the flow while a required action is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await flow({ action: async () => { await gate; } });
    const resolving = f.service.resolvePendingCheck(f.id);
    await Bun.sleep(0);
    expect(() => f.service.gotoStage(f.id, 'intro')).toThrow('Stage validation is still running');
    await expect(f.service.skipTo(f.id, 'isolation')).rejects.toThrow('Stage validation is still running');
    expect(f.service.getSession(f.id).currentStage).toBe('intro');
    expect(f.service.getSession(f.id).pendingCheck?.stageName).toBe('create-vm');
    release(); await resolving;
    f.service.gotoStage(f.id, 'intro');
    expect(f.service.getSession(f.id).currentStage).toBeNull();
    f.db.close();
  });
  test('skip refuses to cross a required action before changing history or flow', async () => {
    const f = await flow();
    for (const target of ['create-vm', 'isolation']) {
      await expect(f.service.skipTo(f.id, target)).rejects.toThrow("Complete 'create-vm'");
      expect(f.service.getSession(f.id).currentStage).toBe('intro');
      expect(f.service.getSession(f.id).pendingCheck?.stageName).toBe('create-vm');
      expect(f.db.query("SELECT count(*) AS n FROM stage_history WHERE session_id = ? AND stage_name = 'create-vm'").get(f.id)).toEqual({ n: 0 });
    }
    await f.service.resolvePendingCheck(f.id);
    expect((await f.service.skipTo(f.id, 'isolation')).finalStage).toBe('isolation');
    f.db.close();
  });
  test('failed required action releases the navigation lock without allowing skip past it', async () => {
    const f = await flow({ action: async () => { throw new Error('backup unavailable'); } });
    await expect(f.service.resolvePendingCheck(f.id)).rejects.toThrow('backup unavailable');
    await expect(f.service.skipTo(f.id, 'isolation')).rejects.toThrow("Complete 'create-vm'");
    f.service.gotoStage(f.id, 'intro');
    expect(f.service.getSession(f.id).currentStage).toBeNull();
    f.db.close();
  });
  test('waits for the action after captures, before invalidations and stage completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const f = await flow({ action: async ctx => { calls++; expect(ctx.vars.get('VMUUID')).toBe('vm-one'); expect(ctx.vars.get('OldValue')).toBeTruthy(); await gate; } });
    const first = f.service.resolvePendingCheck(f.id);
    const second = f.service.resolvePendingCheck(f.id);
    await Bun.sleep(0);
    expect(calls).toBe(1);
    expect(f.service.getSession(f.id).currentStage).toBe('intro');
    expect(f.service.getSession(f.id).pendingCheck?.stageName).toBe('create-vm');
    release(); await Promise.all([first, second]);
    expect(f.service.getSession(f.id).currentStage).toBe('create-vm');
    expect(f.service.variables.all(f.id).OldValue).toBeUndefined();
    await f.service.advance(f.id);
    expect(calls).toBe(1);
    f.db.close();
  });
  test('failed or neutral checks never run the action', async () => {
    for (const neutral of [false, true]) {
      let calls = 0;
      const f = await flow({ pass: false, neutral, action: async () => { calls++; } });
      await f.service.resolvePendingCheck(f.id);
      expect(calls).toBe(0);
      expect(f.service.getSession(f.id).currentStage).toBe('intro');
      f.db.close();
    }
  });
  test('failed action retains the pending check across restart and advances only on successful retry', async () => {
    let fail = true;
    const f = await flow({ action: async () => { if (fail) throw new Error('backup unavailable'); } });
    await expect(f.service.resolvePendingCheck(f.id)).rejects.toThrow('backup unavailable');
    expect(f.service.getSession(f.id).currentStage).toBe('intro');
    expect(f.service.getSession(f.id).pendingCheck?.stageName).toBe('create-vm');
    expect(f.service.variables.all(f.id).OldValue).toBeTruthy();
    expect(f.db.query("SELECT count(*) AS n FROM stage_history WHERE session_id = ? AND stage_name = 'create-vm'").get(f.id)).toEqual({ n: 0 });
    const restarted = new SessionService(f.deps);
    fail = false;
    await restarted.resolvePendingCheck(f.id);
    expect(restarted.getSession(f.id).currentStage).toBe('create-vm');
    expect(restarted.getSession(f.id).pendingCheck).toBeNull();
    f.db.close();
  });
});
