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
import { VariableQueries, HistoryQueries, HelpUsageQueries, SessionWaitQueries } from '../src/db/queries';
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

  test('orders finished before playing; within finished, shortest playing time wins', async () => {
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

  test('sorts by stagesPassed desc, then shortest playing time, then earliest start', () => {
    const merged = mergeScoreboards([
      entry({ sessionId: 'a', stagesPassed: 3, startedAt: 100, peerLabel: null }),
      entry({ sessionId: 'b', stagesPassed: 5, finishedAt: 200, startedAt: 100, peerLabel: 'remote', status: 'finished' }),
      entry({ sessionId: 'c', stagesPassed: 5, finishedAt: 150, startedAt: 100, peerLabel: null, status: 'finished' }),
      entry({ sessionId: 'd', stagesPassed: 3, startedAt: 50, peerLabel: 'remote' }),
    ]);
    expect(merged.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
    // c plays for less time than b at the same stagesPassed → ranks above.
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

// ─── Ranking on playing time ─────────────────────────────────────────

describe('ranking on playing time', () => {
  const MIN = 60_000;
  const ALL = ['login', 'recovery-gate', 'intro-tank-greet', 'outro'];
  const finished = (id: string, trigram: string, startMin: number, endMin: number) => ({
    id,
    startedAt: startMin * MIN,
    finishedAt: endMin * MIN,
    currentStage: 'outro',
    capturedTrigram: trigram,
    capturedUsername: trigram,
    passedStages: ALL,
  });

  test('a player who started later but played less ranks first', async () => {
    const db = freshDb();
    seed(db, finished('alice', 'ALI', 0, 60)); // 60 min of play
    seed(db, finished('bob', 'BOB', 20, 65)); // arrived 20 min late, 45 min of play
    expect((await fetchEntries(db)).map((e) => e.trigram)).toEqual(['BOB', 'ALI']);
  });

  test('time held at a gate is not playing time: the player who waited longer ranks first', async () => {
    const db = freshDb();
    seed(db, finished('lea', 'LEA', 0, 60));
    seed(db, finished('marc', 'MAR', 0, 60));
    const waits = new SessionWaitQueries(db);
    // Both restart at minute 30. Léa reached the gate at 10, Marc at 25.
    waits.open('lea', 'gate', 'recovery-gate', 10 * MIN);
    waits.close('lea', 30 * MIN);
    waits.open('marc', 'gate', 'recovery-gate', 25 * MIN);
    waits.close('marc', 30 * MIN);

    const entries = await fetchEntries(db);
    expect(entries.map((e) => e.trigram)).toEqual(['LEA', 'MAR']);
    expect(entries.map((e) => e.blockedMs)).toEqual([20 * MIN, 5 * MIN]);
  });

  test('help penalties still count on top of the playing time', async () => {
    const db = freshDb();
    seed(db, finished('lea', 'LEA', 0, 60));
    seed(db, finished('marc', 'MAR', 0, 60));
    const waits = new SessionWaitQueries(db);
    waits.open('lea', 'gate', 'recovery-gate', 10 * MIN);
    waits.close('lea', 30 * MIN);
    waits.open('marc', 'gate', 'recovery-gate', 25 * MIN);
    waits.close('marc', 30 * MIN);
    // Léa: 40 min of play + 25 min of help = 65. Marc: 55.
    new HelpUsageQueries(db).record('lea', 'login', 25 * 60);
    expect((await fetchEntries(db)).map((e) => e.trigram)).toEqual(['MAR', 'LEA']);
  });

  test('equal playing time falls back to the earliest finish, not the earliest start', async () => {
    const db = freshDb();
    // Seeded in this order so that, without the finish tie-break, the later
    // activity (and the earlier start) would put ESR first.
    seed(db, finished('early-finish', 'EFN', 10, 60)); // 50 min
    seed(db, finished('early-start', 'ESR', 0, 70)); // 70 - 20 held = 50 min
    new SessionWaitQueries(db).open('early-start', 'pause', null, 10 * MIN);
    new SessionWaitQueries(db).close('early-start', 30 * MIN);
    expect((await fetchEntries(db)).map((e) => e.trigram)).toEqual(['EFN', 'ESR']);
  });

  test('a wait never makes the playing time negative', async () => {
    const db = freshDb();
    seed(db, finished('odd', 'ODD', 0, 10));
    seed(db, finished('ok', 'OKK', 0, 20));
    const waits = new SessionWaitQueries(db);
    waits.open('odd', 'pause', null, 0);
    waits.close('odd', 15 * MIN); // longer than the whole session: clock skew
    expect((await fetchEntries(db)).map((e) => e.trigram)).toEqual(['ODD', 'OKK']);
  });

  test('players still playing keep their order: progress first, waits do not matter', async () => {
    const db = freshDb();
    seed(db, {
      id: 'lead', startedAt: 5 * MIN, currentStage: 'intro-tank-greet',
      capturedTrigram: 'LED', capturedUsername: 'LED', passedStages: ['login', 'recovery-gate', 'intro-tank-greet'],
    });
    seed(db, {
      id: 'behind', startedAt: 0, currentStage: 'login',
      capturedTrigram: 'BHD', capturedUsername: 'BHD', passedStages: ['login'],
    });
    const waits = new SessionWaitQueries(db);
    waits.open('lead', 'pause', null, 30 * MIN); // still held
    expect((await fetchEntries(db)).map((e) => e.trigram)).toEqual(['LED', 'BHD']);
  });

  test('entries expose the waits: closed total, running wait, reason and last release', async () => {
    const db = freshDb();
    seed(db, {
      id: 'held', startedAt: 0, currentStage: 'login',
      capturedTrigram: 'HLD', capturedUsername: 'HLD', passedStages: ['login'],
    });
    seed(db, {
      id: 'free', startedAt: 0, currentStage: 'login',
      capturedTrigram: 'FRE', capturedUsername: 'FRE', passedStages: ['login'],
    });
    const waits = new SessionWaitQueries(db);
    waits.open('held', 'gate', 'recovery-gate', 5 * MIN);
    waits.close('held', 9 * MIN);
    waits.open('held', 'pause', null, 20 * MIN);

    const byTrigram = new Map((await fetchEntries(db)).map((e) => [e.trigram, e]));
    expect(byTrigram.get('HLD')).toMatchObject({
      blockedMs: 4 * MIN,
      blockedSince: 20 * MIN,
      blockedReason: 'pause',
      lastReleasedAt: 9 * MIN,
    });
    expect(byTrigram.get('FRE')).toMatchObject({
      blockedMs: 0,
      blockedSince: null,
      blockedReason: null,
      lastReleasedAt: null,
    });
  });
});

describe('mergeScoreboards on playing time', () => {
  const MIN = 60_000;
  function row(partial: Partial<ScoreboardEntry> & { sessionId: string }) {
    return {
      rank: 0,
      trigram: partial.sessionId,
      username: null,
      stageName: null,
      stagesPassed: 4,
      stagesDisabled: 0,
      totalStages: 4,
      effectiveTotalStages: 4,
      startedAt: 0,
      finishedAt: 60 * MIN,
      lastActivityAt: null,
      status: 'finished' as const,
      peerLabel: null as string | null,
      ...partial,
    };
  }

  test('a late start and a long wait both come off the playing time', () => {
    const merged = mergeScoreboards([
      row({ sessionId: 'steady' }), // 60 min
      row({ sessionId: 'late-start', startedAt: 20 * MIN, finishedAt: 65 * MIN }), // 45 min
      row({ sessionId: 'waited', blockedMs: 25 * MIN }), // 35 min
    ]);
    expect(merged.map((e) => e.trigram)).toEqual(['waited', 'late-start', 'steady']);
  });

  test('a peer on an older version sends no waits and counts as 0', () => {
    const merged = mergeScoreboards([
      row({ sessionId: 'old-peer', peerLabel: 'old', startedAt: 0, finishedAt: 50 * MIN }),
      row({ sessionId: 'local', blockedMs: 5 * MIN, finishedAt: 52 * MIN }), // 47 min
    ]);
    expect(merged.map((e) => e.trigram)).toEqual(['local', 'old-peer']);
  });

  test('equal playing time falls back to the earliest finish, not the earliest start', () => {
    const merged = mergeScoreboards([
      row({ sessionId: 'early-start', startedAt: 0, finishedAt: 70 * MIN, blockedMs: 20 * MIN }),
      row({ sessionId: 'early-finish', startedAt: 10 * MIN, finishedAt: 60 * MIN }),
    ]);
    expect(merged.map((e) => e.trigram)).toEqual(['early-finish', 'early-start']);
  });
});
