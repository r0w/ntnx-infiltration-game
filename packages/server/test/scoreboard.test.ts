import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRegistry,
  CheckRegistry,
  makeBundle,
  type LocaleBundle,
  type StageDefinition,
} from '@ntnx-game/engine';
import { VariableQueries, HistoryQueries } from '../src/db/queries';
import { buildScoreboardRoutes, mergeScoreboards, type ScoreboardEntry } from '../src/routes/scoreboard';
import type { LoadedPack } from '../src/pack-loader';

const SCHEMA = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql'),
  'utf8',
);

const PACK_ID = 'test-pack';

const stages: StageDefinition[] = [
  { index: 1, id: 'login', name: 'login', active: true, messages: ['s1'] },
  { index: 2, id: 'recovery-gate', name: 'recovery-gate', active: true, messages: ['s2'] },
  { index: 3, id: 'intro-tank-greet', name: 'intro-tank-greet', active: true, messages: ['s3'] },
  { index: 4, id: 'outro', name: 'outro', active: true, messages: ['s4'] },
];

const bundle: LocaleBundle = makeBundle('en', {
  en: { s1: 'one', s2: 'two', s3: 'three', s4: 'four' },
});

function fakePack(): LoadedPack {
  return {
    manifest: {
      id: PACK_ID,
      name: 'Test pack',
      version: '0.0.0',
      checks: './checks',
      stages: './stages',
      defaultLocale: 'en',
      supportedLocales: ['en'],
    },
    dir: '/tmp/fake-pack',
    stages,
    checks: new CheckRegistry(),
    actions: new ActionRegistry(),
    bundle,
  };
}

interface SeedInput {
  id: string;
  startedAt: number;
  /**
   * Last-completed stage name (matches SessionRecord.currentStage). `null`
   * or omitted means pre-game.
   */
  currentStage?: string | null;
  finishedAt?: number | null;
  packId?: string;
  capturedTrigram?: string;
  capturedUsername?: string;
  /** Stage names (in pack order) this session has passed. */
  passedStages?: string[];
}

function seed(db: Database, input: SeedInput): void {
  // SessionQueries.create() stamps started_at = Date.now(); tests need
  // deterministic timestamps for sort-order assertions, so insert directly.
  db.prepare(
    `INSERT INTO sessions (id, trigram, pin_hash, pack_id, current_stage, started_at, finished_at, locale, cluster_endpoint, cluster_profile, capabilities_json)
     VALUES ($id, $trigram, '', $pack, $stage, $started, $finished, 'en', '', 'other', '[]')`,
  ).run({
    $id: input.id,
    $trigram: input.id, // UUID placeholder — matches real session-service.create()
    $pack: input.packId ?? PACK_ID,
    $stage: input.currentStage ?? null,
    $started: input.startedAt,
    $finished: input.finishedAt ?? null,
  });
  const vars = new VariableQueries(db);
  if (input.capturedTrigram !== undefined) vars.upsert(input.id, 'Trigram', input.capturedTrigram, 'seed');
  if (input.capturedUsername !== undefined) vars.upsert(input.id, 'Username', input.capturedUsername, 'seed');
  const history = new HistoryQueries(db);
  for (const name of input.passedStages ?? []) {
    history.record(input.id, name, 'passed', 42, null);
  }
}

async function fetchEntries(db: Database): Promise<ScoreboardEntry[]> {
  const router = buildScoreboardRoutes({
    db,
    pack: fakePack(),
    mode: 'mock',
    // Minimal stub — the scoreboard route only invokes
    // `effectivePlayableCount`. Returning `stages.length` mirrors the
    // pre-tightening behaviour these tests baked in.
    service: { effectivePlayableCount: () => stages.length } as unknown as Parameters<
      typeof buildScoreboardRoutes
    >[0]['service'],
    capabilities: [],
    clusterProfile: 'hpoc',
  });
  const res = await router.request('/');
  const body = (await res.json()) as {
    entries: ScoreboardEntry[];
    totalStages: number;
    mode: 'mock' | 'live';
  };
  expect(body.totalStages).toBe(stages.length);
  expect(body.mode).toBe('mock');
  return body.entries;
}

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

describe('GET /api/scoreboard', () => {
  test('empty pack returns no entries', async () => {
    const entries = await fetchEntries(freshDb());
    expect(entries).toEqual([]);
  });

  test('orders finished before playing; within finished, earliest finish wins', async () => {
    const db = freshDb();
    seed(db, {
      id: 'sess-abc', startedAt: 1000, currentStage: 'outro', finishedAt: 5000,
      capturedTrigram: 'ABC', capturedUsername: 'Alice',
      passedStages: ['login', 'recovery-gate', 'intro-tank-greet', 'outro'],
    });
    seed(db, {
      id: 'sess-xyz', startedAt: 2000, currentStage: 'outro', finishedAt: 4000,
      capturedTrigram: 'XYZ', capturedUsername: 'Bob',
      passedStages: ['login', 'recovery-gate', 'intro-tank-greet', 'outro'],
    });
    seed(db, {
      id: 'sess-def', startedAt: 3000, currentStage: 'recovery-gate',
      capturedTrigram: 'DEF', capturedUsername: 'Carol',
      passedStages: ['login', 'recovery-gate'],
    });

    const entries = await fetchEntries(db);
    expect(entries.map((e) => e.trigram)).toEqual(['XYZ', 'ABC', 'DEF']);
    expect(entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.status)).toEqual(['finished', 'finished', 'playing']);
  });

  test('playing entries expose next stageName; finished entries null it out', async () => {
    const db = freshDb();
    seed(db, {
      id: 'sess-playing', startedAt: 1000, currentStage: 'recovery-gate',
      capturedTrigram: 'PLY', passedStages: ['login', 'recovery-gate'],
    });
    seed(db, {
      id: 'sess-done', startedAt: 500, currentStage: 'outro', finishedAt: 9000,
      capturedTrigram: 'DON',
      passedStages: ['login', 'recovery-gate', 'intro-tank-greet', 'outro'],
    });

    const entries = await fetchEntries(db);
    const done = entries.find((e) => e.trigram === 'DON')!;
    const playing = entries.find((e) => e.trigram === 'PLY')!;
    expect(done.stageName).toBeNull();
    expect(playing.stageName).toBe('intro-tank-greet');
    expect(playing.stagesPassed).toBe(2);
    expect(playing.totalStages).toBe(4);
  });

  test('sessions without a captured trigram are filtered out (public scoreboard hides pre-identity rows)', async () => {
    const db = freshDb();
    // Pre-game session: no currentStage row, no trigram — should NOT appear.
    seed(db, { id: 'sess-fresh', startedAt: 1000 });
    // A second, identified session — should appear.
    seed(db, {
      id: 'sess-id', startedAt: 1500, currentStage: 'login',
      capturedTrigram: 'IDF', passedStages: ['login'],
    });
    const entries = await fetchEntries(db);
    expect(entries).toHaveLength(1);
    expect(entries[0].trigram).toBe('IDF');
    expect(entries[0].status).toBe('playing');
  });

  test('exposes captured trigram from session_variables, not the UUID placeholder', async () => {
    const db = freshDb();
    seed(db, {
      id: 'long-uuid-0000-0000-0000-000000000001',
      startedAt: 1000, currentStage: 'login',
      capturedTrigram: 'RWI', capturedUsername: 'Rowie', passedStages: ['login'],
    });
    const entries = await fetchEntries(db);
    expect(entries[0].trigram).toBe('RWI');
    expect(entries[0].trigram).not.toBe('long-uuid-0000-0000-0000-000000000001');
    expect(entries[0].username).toBe('Rowie');
  });

  test('two sessions capturing the same trigram both appear (identity-flow audit signal)', async () => {
    // UNIQUE(trigram, pack_id) is on the UUID placeholder column, not the
    // captured Trigram variable. Nothing DB-side prevents two players from
    // typing the same in-game trigram; the scoreboard should surface that so
    // it acts as a validation tool for the in-game identity flow.
    const db = freshDb();
    seed(db, {
      id: 'sess-one', startedAt: 1000, currentStage: 'recovery-gate',
      capturedTrigram: 'ABC', passedStages: ['login', 'recovery-gate'],
    });
    seed(db, {
      id: 'sess-two', startedAt: 2000, currentStage: 'login',
      capturedTrigram: 'ABC', passedStages: ['login'],
    });
    const entries = await fetchEntries(db);
    expect(entries.filter((e) => e.trigram === 'ABC')).toHaveLength(2);
  });

  test('scopes to packId — entries from other packs are excluded', async () => {
    const db = freshDb();
    seed(db, {
      id: 'other-sess', startedAt: 100, currentStage: 'login', packId: 'other-pack',
      capturedTrigram: 'ZZZ', passedStages: ['login'],
    });
    seed(db, {
      id: 'ours', startedAt: 200, currentStage: 'login',
      capturedTrigram: 'OUR', passedStages: ['login'],
    });
    const entries = await fetchEntries(db);
    expect(entries.map((e) => e.trigram)).toEqual(['OUR']);
  });
});

describe('mergeScoreboards', () => {
  function entry(
    partial: Partial<ScoreboardEntry> & { sessionId: string; peerLabel: string | null },
  ): ScoreboardEntry & { peerLabel: string | null } {
    return {
      rank: 0,
      trigram: 'AAA',
      username: 'Anon',
      stageName: null,
      stagesPassed: 0,
      stagesDisabled: 0,
      totalStages: 10,
      startedAt: 0,
      finishedAt: null,
      lastActivityAt: null,
      status: 'playing',
      ...partial,
    };
  }

  test('sorts by stagesPassed desc, then earliest finish, then earliest start', () => {
    const merged = mergeScoreboards([
      entry({ sessionId: 'a', stagesPassed: 3, startedAt: 100, peerLabel: null }),
      entry({ sessionId: 'b', stagesPassed: 5, finishedAt: 200, startedAt: 100, peerLabel: 'remote', status: 'finished' }),
      entry({ sessionId: 'c', stagesPassed: 5, finishedAt: 150, startedAt: 100, peerLabel: null, status: 'finished' }),
      entry({ sessionId: 'd', stagesPassed: 3, startedAt: 50, peerLabel: 'remote' }),
    ]);
    expect(merged.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
    // c finishes earlier than b at the same stagesPassed → ranks above.
    expect(merged[0]!.sessionId).toBe('c');
    expect(merged[1]!.sessionId).toBe('remote:b');
    // d started before a at the same stagesPassed → ranks above.
    expect(merged[2]!.sessionId).toBe('remote:d');
    expect(merged[3]!.sessionId).toBe('a');
  });

  test('namespaces peer sessionIds; keeps local sessionIds untouched', () => {
    const merged = mergeScoreboards([
      entry({ sessionId: 'uuid-local', peerLabel: null }),
      entry({ sessionId: 'uuid-peer', peerLabel: 'POC-37' }),
    ]);
    const local = merged.find((e) => e.peerLabel === null)!;
    const peer = merged.find((e) => e.peerLabel === 'POC-37')!;
    expect(local.sessionId).toBe('uuid-local');
    expect(peer.sessionId).toBe('POC-37:uuid-peer');
  });

  test('handles a sessionId collision between local + peer without dropping either', () => {
    const merged = mergeScoreboards([
      entry({ sessionId: 'same-uuid', stagesPassed: 1, peerLabel: null }),
      entry({ sessionId: 'same-uuid', stagesPassed: 2, peerLabel: 'POC-37' }),
    ]);
    // Both survive; rank order driven by stagesPassed.
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.sessionId)).toEqual(['POC-37:same-uuid', 'same-uuid']);
  });
});
