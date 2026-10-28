import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRegistry,
  ActRegistry,
  CheckRegistry,
  CleanupRegistry,
  makeBundle,
  type NutanixClient,
  type StageDefinition,
} from '@ntnx-game/engine';
import { buildApp } from '../src/app';
import type { LoadedPack } from '../src/pack-loader';
import { Telemetry } from '../src/telemetry';

// What NIG Central learns about a run beyond the raw wall-clock times: how much
// of each stage the operator held the player (admin gate, lunch lock), the
// playing time that is left, and the use of the step-by-step help. `wallMs` and
// `totalMs` keep their meaning, since Central's dashboard reads them.

const SCHEMA = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql'),
  'utf8',
);
const ADMIN_PW = 'test-pw';
const PACK_ID = 'playing-time-pack';
const MIN = 60_000;

// `paid` is gated by the operator, so a wait falls inside its window; its help
// costs time. `free` has a help that costs nothing.
const stages: StageDefinition[] = [
  { index: 0, id: 'intro', name: 'intro', active: true, messages: ['intro.m1'] },
  {
    index: 1, id: 'paid', name: 'paid', active: true, adminGate: true, messages: ['paid.m1'],
    check: { fn: 'flaky' }, help: ['paid.h1'], helpPenaltySec: 120,
  },
  {
    index: 2, id: 'free', name: 'free', active: true, messages: ['free.m1'],
    check: { fn: 'alwaysPass' }, help: ['free.h1'],
  },
  { index: 3, id: 'finale', name: 'finale', active: true, messages: ['finale.m1'] },
];
const bundle = makeBundle('en', {
  en: {
    'intro.m1': 'Intro.',
    'paid.m1': 'Do it <input/>',
    'paid.h1': 'Step 1.',
    'free.m1': 'Do it too <input/>',
    'free.h1': 'Hint.',
    'finale.m1': 'The end.',
  },
});

const noopNutanix: NutanixClient = { mode: 'mock', request: async () => ({}) };
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** `flaky` fails its first call and passes afterwards: one failed attempt. */
function boot() {
  const checks = new CheckRegistry();
  let calls = 0;
  checks.register('flaky', async () => ({ pass: calls++ > 0, detail: 'flaky' }));
  checks.register('alwaysPass', async () => ({ pass: true, detail: 'ok' }));
  const pack: LoadedPack = {
    manifest: {
      id: PACK_ID,
      name: 'Playing time pack',
      version: '0.0.0',
      checks: './checks',
      stages: './stages',
      defaultLocale: 'en',
      supportedLocales: ['en'],
    },
    dir: '/tmp/playing-time-pack',
    stages,
    checks,
    actions: new ActionRegistry(),
    acts: new ActRegistry(),
    cleanups: new CleanupRegistry(),
    bundle,
  };
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const telemetry = new Telemetry({
    db,
    logger: silent,
    // Never dialled: the test reads the outbox, which is what a flush would send.
    url: 'http://127.0.0.1:9',
    packId: PACK_ID,
    packVersion: '0.0.0',
    serverMode: 'test',
    clusterProfile: 'hpoc',
  });
  const { app, service } = buildApp({
    db,
    pack,
    nutanix: noopNutanix,
    clusterEndpoint: '10.0.0.1',
    clusterProfile: 'hpoc',
    capabilities: [],
    adminPassword: ADMIN_PW,
    telemetry,
  });
  service.setHelpEnabledGlobally(true);
  return { db, app, service };
}
type Booted = ReturnType<typeof boot>;
type Event = Record<string, unknown>;

function outbox(db: Database): Event[] {
  return (db.prepare('SELECT event_json FROM telemetry_outbox ORDER BY id').all() as Array<{
    event_json: string;
  }>).map((r) => JSON.parse(r.event_json) as Event);
}

const of = (events: Event[], type: string, stage?: string): Event[] =>
  events.filter((e) => e.type === type && (stage === undefined || e.stageName === stage));

/** Wall-clock ms for a time of day on the test day. */
const at = (hh: number, mm: number): Date => new Date(Date.UTC(2026, 9, 28, hh, mm, 0));

beforeEach(() => setSystemTime(at(14, 0)));
afterEach(() => setSystemTime());

/**
 * One whole run, with the clock set at every step:
 *
 *   14:00 starts            14:02 intro passes (2 min on the stage)
 *   14:05 held at `paid`    14:25 the operator unlocks (20 min held)
 *   14:30 `paid` renders    14:33 asks for help (costs 120 s)
 *   14:37 fails the check   14:39 passes it
 *   14:40 `free` renders    14:41 asks for help (free)   14:43 passes
 *   14:44 `finale` passes   14:45 finishes
 */
async function playTheRun({ app, service }: Booted): Promise<string> {
  const sid = (await service.create({
    locale: 'en', clusterEndpoint: '', clusterProfile: 'hpoc', capabilities: [],
  })).id;
  // The player has identified themselves: nothing of it may reach the events.
  service.variables.upsert(sid, 'Trigram', 'ZZZ', 'seed');
  const step = async (hh: number, mm: number, fn: () => Promise<unknown> | unknown) => {
    setSystemTime(at(hh, mm));
    return fn();
  };
  await step(14, 2, () => service.advance(sid));
  await step(14, 5, () => service.advance(sid)); // held at the gate
  await step(14, 25, () => app.request('/api/admin/gates/paid/unlock', {
    method: 'POST', headers: { 'X-Admin-Password': ADMIN_PW },
  }));
  await step(14, 30, () => service.advance(sid));
  await step(14, 33, () => service.requestHelp(sid, { confirm: true }));
  await step(14, 36, () => service.submitInput(sid, '$continue', ''));
  await step(14, 37, () => service.resolvePendingCheck(sid)); // fails
  await step(14, 38, () => service.submitInput(sid, '$continue', ''));
  await step(14, 39, () => service.resolvePendingCheck(sid)); // passes
  await step(14, 40, () => service.advance(sid));
  await step(14, 41, () => service.requestHelp(sid));
  await step(14, 42, () => service.submitInput(sid, '$continue', ''));
  await step(14, 43, () => service.resolvePendingCheck(sid));
  await step(14, 44, () => service.advance(sid));
  await step(14, 45, () => service.advance(sid)); // finished
  return sid;
}

describe('playing time in the telemetry events', () => {
  test('a stage passed after a gate reports its wall-clock time, the wait inside it and what is left', async () => {
    const booted = boot();
    await playTheRun(booted);
    const events = outbox(booted.db);

    const intro = of(events, 'stage_passed', 'intro')[0]!;
    expect(intro).toMatchObject({ wallMs: 2 * MIN, waitMs: 0, netMs: 2 * MIN });

    // 14:02 -> 14:39 on the stage, of which 14:05 -> 14:25 held at the gate.
    const paid = of(events, 'stage_passed', 'paid')[0]!;
    expect(paid).toMatchObject({ stageId: 'paid', stageIndex: 1 });
    expect(paid.wallMs).toBe(37 * MIN);
    expect(paid.waitMs).toBe(20 * MIN);
    expect(paid.netMs).toBe(17 * MIN);

    // The wait is behind this one: nothing to take off.
    expect(of(events, 'stage_passed', 'free')[0]).toMatchObject({ wallMs: 4 * MIN, waitMs: 0, netMs: 4 * MIN });
  });

  test('a failed attempt keeps its old shape: no wall-clock, wait or help fields', async () => {
    const booted = boot();
    await playTheRun(booted);
    const failed = of(outbox(booted.db), 'stage_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ stageName: 'paid', stageIndex: 1 });
    for (const key of ['wallMs', 'waitMs', 'netMs', 'helpUsed', 'helpPenaltySec']) {
      expect(Object.keys(failed[0]!)).not.toContain(key);
    }
    expect(typeof failed[0]!.checkMs).toBe('number');
  });

  test('the finish reports the total, the time held and the playing time', async () => {
    const booted = boot();
    await playTheRun(booted);
    const finished = of(outbox(booted.db), 'session_finished');
    expect(finished).toHaveLength(1);
    // totalMs still counts everything from the start, as Central's dashboard expects.
    expect(finished[0]!.totalMs).toBe(45 * MIN);
    expect(finished[0]!.waitMs).toBe(20 * MIN);
    expect(finished[0]!.netMs).toBe(25 * MIN);
  });

  test('a session with no stage entry stamp reports no timing but still reports help', async () => {
    const booted = boot();
    const sid = (await booted.service.create({
      locale: 'en', clusterEndpoint: '', clusterProfile: 'hpoc', capabilities: [],
    })).id;
    booted.db.prepare('UPDATE sessions SET stage_entered_at = NULL WHERE id = $id').run({ $id: sid });
    setSystemTime(at(14, 5));
    await booted.service.advance(sid);
    const intro = of(outbox(booted.db), 'stage_passed', 'intro')[0]!;
    expect(intro.helpUsed).toBe(false);
    for (const key of ['wallMs', 'waitMs', 'netMs']) expect(Object.keys(intro)).not.toContain(key);
  });
});

describe('help in the telemetry events', () => {
  test('help_used is sent once, at the first display, with the playing time before asking', async () => {
    const booted = boot();
    await playTheRun(booted);
    const used = of(outbox(booted.db), 'help_used');
    expect(used).toHaveLength(2);

    // Asked at 14:33 in a window that started at 14:02 and holds the 20 min wait.
    expect(used[0]).toMatchObject({ stageId: 'paid', stageName: 'paid', stageIndex: 1, penaltySec: 120 });
    expect(used[0]!.afterMs).toBe(11 * MIN);
    // A free help is reported too, with a penalty of 0.
    expect(used[1]).toMatchObject({ stageId: 'free', stageName: 'free', penaltySec: 0 });
    expect(used[1]!.afterMs).toBe(2 * MIN);
  });

  test('showing a help again, or asking without confirming a costly one, reports nothing', async () => {
    const booted = boot();
    const { service, db } = booted;
    const sid = (await service.create({
      locale: 'en', clusterEndpoint: '', clusterProfile: 'hpoc', capabilities: [],
    })).id;
    service.sessions.updateCurrentStage(sid, 'intro');
    service.sessions.setAwaiting(sid, { variable: '$continue', stageName: 'paid', renderOffset: 1 });

    expect(service.requestHelp(sid).status).toBe('confirm-required');
    expect(of(outbox(db), 'help_used')).toHaveLength(0);

    service.requestHelp(sid, { confirm: true });
    service.requestHelp(sid);
    service.requestHelp(sid);
    expect(of(outbox(db), 'help_used')).toHaveLength(1);
  });

  test('stage_passed says whether the stage help was shown and what it cost', async () => {
    const booted = boot();
    await playTheRun(booted);
    const events = outbox(booted.db);
    expect(of(events, 'stage_passed', 'intro')[0]).toMatchObject({ helpUsed: false, helpPenaltySec: 0 });
    expect(of(events, 'stage_passed', 'paid')[0]).toMatchObject({ helpUsed: true, helpPenaltySec: 120 });
    expect(of(events, 'stage_passed', 'free')[0]).toMatchObject({ helpUsed: true, helpPenaltySec: 0 });
    expect(of(events, 'stage_passed', 'finale')[0]).toMatchObject({ helpUsed: false, helpPenaltySec: 0 });
  });

  test('the finish totals the helps displayed and their penalties', async () => {
    const booted = boot();
    await playTheRun(booted);
    expect(of(outbox(booted.db), 'session_finished')[0]).toMatchObject({ helpUses: 2, helpPenaltySec: 120 });
  });
});

describe('what the events never carry', () => {
  test('no event names the player', async () => {
    const booted = boot();
    await playTheRun(booted);
    const events = outbox(booted.db);
    expect(events.length).toBeGreaterThan(8);
    for (const e of events) {
      for (const key of ['trigram', 'username', 'userNum', 'pin']) {
        expect(Object.keys(e).map((k) => k.toLowerCase())).not.toContain(key.toLowerCase());
      }
      expect(JSON.stringify(e)).not.toContain('ZZZ');
    }
  });
});
