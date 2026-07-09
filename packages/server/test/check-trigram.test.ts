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
  type CheckContext,
  type LocaleBundle,
  type NutanixClient,
  type SessionDirectory,
  type StageDefinition,
} from '@ntnx-game/engine';
import { checks } from '../../../packs/ntnx-infiltration/checks';
import { SessionService } from '../src/session-service';
import { VariableQueries } from '../src/db/queries';

const SCHEMA = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql'),
  'utf8',
);

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};

const noopNutanix: NutanixClient = {
  mode: 'mock',
  async request() { throw new Error('noop'); },
};

function makeCtx(overrides: Partial<CheckContext> = {}): CheckContext {
  const vars = new VariableStore();
  return {
    nutanix: noopNutanix,
    vars,
    cache: {
      get: () => undefined,
      set: () => {},
      all: () => [],
    },
    args: {},
    session: { id: 'sess-1', trigram: 'sess-1', locale: 'en', clusterProfile: 'other' },
    logger: silentLogger,
    ...overrides,
  };
}

describe('CheckTrigram — shape validation (Trigram + PIN)', () => {
  test('empty trigram fails', async () => {
    const ctx = makeCtx();
    ctx.vars.set('Trigram', '', 1);
    ctx.vars.set('PIN', '1234', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/empty/i);
  });

  test('trigram length 1 fails', async () => {
    const ctx = makeCtx();
    ctx.vars.set('Trigram', 'x', 1);
    ctx.vars.set('PIN', '1234', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/exactly 3/i);
  });

  test('trigram length 4 fails (must be exactly 3)', async () => {
    const ctx = makeCtx();
    ctx.vars.set('Trigram', 'abcd', 1);
    ctx.vars.set('PIN', '1234', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/exactly 3/i);
  });

  test('trigram with illegal character fails', async () => {
    const ctx = makeCtx();
    ctx.vars.set('Trigram', 'a b', 1);
    ctx.vars.set('PIN', '1234', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/letters or digits/);
  });

  test('PIN missing fails with retry on PIN', async () => {
    const ctx = makeCtx();
    ctx.vars.set('Trigram', 'rbo', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/PIN/);
    expect(r.retryFromVariable).toBe('PIN');
  });

  test('PIN with letters fails', async () => {
    const ctx = makeCtx();
    ctx.vars.set('Trigram', 'rbo', 1);
    ctx.vars.set('PIN', '12a4', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(false);
    expect(r.retryFromVariable).toBe('PIN');
    expect(r.detail).toMatch(/4 digits/);
  });

  test('PIN length 3 fails (must be exactly 4)', async () => {
    const ctx = makeCtx();
    ctx.vars.set('Trigram', 'rbo', 1);
    ctx.vars.set('PIN', '123', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(false);
    expect(r.retryFromVariable).toBe('PIN');
  });

  test('valid Trigram + PIN passes when no sessionDirectory provided', async () => {
    const ctx = makeCtx();
    ctx.vars.set('Trigram', 'rbo', 1);
    ctx.vars.set('PIN', '1234', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/rbo/);
  });
});

describe('CheckTrigram — collision check (new)', () => {
  function mockDirectory(
    rows: Array<{ sessionId: string; finishedAt: number | null }>,
    vars: Record<string, Record<string, unknown>> = {},
  ): SessionDirectory {
    return {
      findOtherSessionsWithVariable: () =>
        rows.map((r) => ({ sessionId: r.sessionId, currentStage: 0, finishedAt: r.finishedAt })),
      getVariable: (sid: string, name: string) => vars[sid]?.[name],
    };
  }

  test('passes when no other session has this trigram', async () => {
    const ctx = makeCtx({ sessionDirectory: mockDirectory([]) });
    ctx.vars.set('Trigram', 'rbo', 1);
    ctx.vars.set('PIN', '1234', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(true);
  });

  test('collision + PIN match → switchTo the other session (returning-agent path)', async () => {
    const ctx = makeCtx({
      sessionDirectory: mockDirectory(
        [{ sessionId: 'sess-other', finishedAt: null }],
        { 'sess-other': { PIN: '1234' } },
      ),
    });
    ctx.vars.set('Trigram', 'rbo', 1);
    ctx.vars.set('PIN', '1234', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(false);
    expect(r.switchTo).toBe('sess-other');
  });

  test('collision + PIN mismatch → retryFromVariable=PIN with wrong-pin hint', async () => {
    const ctx = makeCtx({
      sessionDirectory: mockDirectory(
        [{ sessionId: 'sess-other', finishedAt: null }],
        { 'sess-other': { PIN: '1234' } },
      ),
    });
    ctx.vars.set('Trigram', 'rbo', 1);
    ctx.vars.set('PIN', '9999', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(false);
    expect(r.switchTo).toBeUndefined();
    expect(r.retryFromVariable).toBe('PIN');
    expect(r.detail).toMatch(/wrong pin/i);
    expect(r.detail).toMatch(/rbo/);
    expect(r.detail).toMatch(/switch agent/i);
  });

  test('shape failures request a Trigram rewind', async () => {
    // Shape problems on the Trigram itself rewind to Trigram so the
    // player isn't stuck re-typing PINs that aren't the issue.
    const ctx = makeCtx();
    ctx.vars.set('Trigram', 'a b', 1);
    ctx.vars.set('PIN', '1234', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(false);
    expect(r.retryFromVariable).toBe('Trigram');
  });

  test('a finished session still claims its trigram — wrong PIN is refused', async () => {
    // Cluster resources named after the trigram outlive the session, so
    // reuse would let the newcomer coast through the early checks.
    const ctx = makeCtx({
      sessionDirectory: mockDirectory(
        [{ sessionId: 'sess-done', finishedAt: 9999 }],
        { 'sess-done': { PIN: '1234' } },
      ),
    });
    ctx.vars.set('Trigram', 'rbo', 1);
    ctx.vars.set('PIN', '9999', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(false);
    expect(r.retryFromVariable).toBe('PIN');
    expect(r.detail).toMatch(/already claimed/i);
  });

  test('finished session + PIN match → switchTo it (player sees their ending)', async () => {
    const ctx = makeCtx({
      sessionDirectory: mockDirectory(
        [{ sessionId: 'sess-done', finishedAt: 9999 }],
        { 'sess-done': { PIN: '1234' } },
      ),
    });
    ctx.vars.set('Trigram', 'rbo', 1);
    ctx.vars.set('PIN', '1234', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.pass).toBe(false);
    expect(r.switchTo).toBe('sess-done');
  });

  test('an unfinished session wins over a finished one with the same trigram', async () => {
    // Legacy data: the old code let a finished trigram be re-claimed, so a
    // pack can hold both. PIN must be matched against the live session.
    const ctx = makeCtx({
      sessionDirectory: mockDirectory(
        [
          { sessionId: 'sess-done', finishedAt: 9999 },
          { sessionId: 'sess-live', finishedAt: null },
        ],
        { 'sess-done': { PIN: '1111' }, 'sess-live': { PIN: '1234' } },
      ),
    });
    ctx.vars.set('Trigram', 'rbo', 1);
    ctx.vars.set('PIN', '1234', 1);
    const r = await checks.CheckTrigram(ctx);
    expect(r.switchTo).toBe('sess-live');
  });
});

describe('SessionDirectory (integration via SessionService)', () => {
  // These tests exercise the real SQL path — JSON-encoded values in
  // session_variables, packId scoping, current-session exclusion.
  const stages: StageDefinition[] = [
    { index: 1, id: 'login', name: 'login', active: true, messages: ['stage-001'] },
  ];
  const bundle: LocaleBundle = makeBundle('en', { en: { 'stage-001': '' } });

  function makeSvc(): { db: Database; svc: SessionService } {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const runner = new StageRunner(stages, new CheckRegistry(), { logger: silentLogger });
    const svc = new SessionService({
      db,
      runner,
      nutanix: noopNutanix,
      actions: new ActionRegistry(),
      logger: silentLogger,
      packId: 'ntnx-infiltration',
      bundle,
    });
    return { db, svc };
  }

  function seedCaptured(db: Database, sessionId: string, packId: string, trigram: string, finishedAt: number | null = null) {
    db.prepare(
      `INSERT INTO sessions (id, trigram, pin_hash, pack_id, current_stage, started_at, finished_at, locale, cluster_endpoint, cluster_profile, capabilities_json)
       VALUES ($id, $id, '', $pack, 0, $ts, $finished, 'en', '', 'other', '[]')`,
    ).run({ $id: sessionId, $pack: packId, $ts: Date.now(), $finished: finishedAt });
    new VariableQueries(db).upsert(sessionId, 'Trigram', trigram, 1);
  }

  test('finds other sessions with matching captured Trigram; excludes current session', async () => {
    const { db, svc } = makeSvc();
    const me = await svc.create({ clusterEndpoint: '', clusterProfile: 'other', capabilities: [] });
    // Seed another session in the same pack with the same trigram
    seedCaptured(db, 'sess-other', 'ntnx-infiltration', 'rbo');
    // And the current session also captures it
    new VariableQueries(db).upsert(me.id, 'Trigram', 'rbo', 1);

    // Reach into the service to grab the directory for a direct call.
    // buildCheckContext is private — go through advance() or stub here.
    const dir = (svc as unknown as { sessionDirectory: SessionDirectory }).sessionDirectory;
    const rows = dir.findOtherSessionsWithVariable(me.id, 'Trigram', 'rbo');
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe('sess-other');
    expect(rows[0].finishedAt).toBeNull();
  });

  test('scopes to packId — other-pack sessions with same trigram are invisible', async () => {
    const { db, svc } = makeSvc();
    const me = await svc.create({ clusterEndpoint: '', clusterProfile: 'other', capabilities: [] });
    seedCaptured(db, 'sess-other-pack', 'some-other-pack', 'rbo');
    const dir = (svc as unknown as { sessionDirectory: SessionDirectory }).sessionDirectory;
    const rows = dir.findOtherSessionsWithVariable(me.id, 'Trigram', 'rbo');
    expect(rows).toHaveLength(0);
  });

  test('surfaces finished sessions too — caller filters by finishedAt', async () => {
    const { db, svc } = makeSvc();
    const me = await svc.create({ clusterEndpoint: '', clusterProfile: 'other', capabilities: [] });
    seedCaptured(db, 'sess-done', 'ntnx-infiltration', 'rbo', 4000);
    const dir = (svc as unknown as { sessionDirectory: SessionDirectory }).sessionDirectory;
    const rows = dir.findOtherSessionsWithVariable(me.id, 'Trigram', 'rbo');
    expect(rows).toHaveLength(1);
    expect(rows[0].finishedAt).toBe(4000);
  });

  test('probe is case-insensitive — "RBO" finds the stored "rbo"', async () => {
    // The player types whatever case they like; CheckTrigram lowercases on
    // capture, but computeGreeting probes with the raw input.
    const { db, svc } = makeSvc();
    const me = await svc.create({ clusterEndpoint: '', clusterProfile: 'other', capabilities: [] });
    seedCaptured(db, 'sess-other', 'ntnx-infiltration', 'rbo');
    const dir = (svc as unknown as { sessionDirectory: SessionDirectory }).sessionDirectory;
    expect(dir.findOtherSessionsWithVariable(me.id, 'Trigram', 'RBO')).toHaveLength(1);
    expect(dir.findOtherSessionsWithVariable(me.id, 'Trigram', 'rBo')).toHaveLength(1);
  });

  test('JSON-encoded value in session_variables matches probe exact value', async () => {
    // Guards against a regression where the query would compare raw strings
    // with JSON-quoted storage (mismatch → zero results silently).
    const { db, svc } = makeSvc();
    const me = await svc.create({ clusterEndpoint: '', clusterProfile: 'other', capabilities: [] });
    seedCaptured(db, 'sess-with-symbols', 'ntnx-infiltration', 'a-b_9');
    const dir = (svc as unknown as { sessionDirectory: SessionDirectory }).sessionDirectory;
    const rows = dir.findOtherSessionsWithVariable(me.id, 'Trigram', 'a-b_9');
    expect(rows).toHaveLength(1);
  });
});
