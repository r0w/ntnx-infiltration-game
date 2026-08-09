import { afterAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../src/db/database';
import { SessionQueries } from '../src/db/queries';
import { Telemetry } from '../src/telemetry';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const baseDeps = {
  logger: silentLogger,
  packId: 'test-pack',
  packVersion: '1.0.0',
  serverMode: 'test' as const,
  clusterProfile: 'hpoc',
};

function outboxCount(db: ReturnType<typeof openDatabase>): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM telemetry_outbox').get() as { n: number };
  return row.n;
}

describe('Telemetry', () => {
  test('disabled without a url: record is a no-op', () => {
    const db = openDatabase({ path: ':memory:' });
    const t = new Telemetry({ ...baseDeps, db });
    expect(t.enabled).toBe(false);
    t.record({ type: 'session_started', sessionId: 's1' });
    expect(outboxCount(db)).toBe(0);
  });

  test('deploymentId is ip + first-boot date, stable across instances', () => {
    const db = openDatabase({ path: ':memory:' });
    const t1 = new Telemetry({ ...baseDeps, db, url: 'http://127.0.0.1:9' });
    const t2 = new Telemetry({ ...baseDeps, db, url: 'http://127.0.0.1:9' });
    expect(t1.deploymentId).toMatch(/-\d{4}-\d{2}-\d{2}$/);
    // Same DB → same persisted first-boot date → same id (restart-stable).
    expect(t2.deploymentId).toBe(t1.deploymentId);
  });

  test('record queues, flush posts the batch and empties the outbox', async () => {
    const db = openDatabase({ path: ':memory:' });
    const received: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        received.push(await req.json());
        return Response.json({ ok: true });
      },
    });
    try {
      const t = new Telemetry({
        ...baseDeps,
        db,
        url: `http://127.0.0.1:${server.port}`,
        token: 'secret',
      });
      t.record({ type: 'session_started', sessionId: 's1' });
      t.record({
        type: 'stage_passed',
        sessionId: 's1',
        stageId: 'eg-006',
        stageName: 'create-admin-user',
        stageIndex: 5,
        wallMs: 1234,
      });
      expect(outboxCount(db)).toBe(2);
      await t.flush();
      expect(outboxCount(db)).toBe(0);
      expect(received.length).toBe(1);
      const payload = received[0] as {
        deployment: { id: string; packId: string; packTitle: string; mode: string };
        events: Array<{ type: string; stageId?: string; ts: number }>;
      };
      expect(payload.deployment.id).toBe(t.deploymentId);
      expect(payload.deployment.packId).toBe('test-pack');
      // Central labels its per-game view with this; without it two packs are
      // one indistinguishable pile of numbers.
      expect(payload.deployment.packTitle).toBe('test-pack');
      expect(payload.deployment.mode).toBe('test');
      expect(payload.events.map((e) => e.type)).toEqual(['session_started', 'stage_passed']);
      expect(payload.events[1]!.stageId).toBe('eg-006');
      expect(payload.events[0]!.ts).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });

  test('unreachable central: flush swallows the error and keeps the backlog', async () => {
    const db = openDatabase({ path: ':memory:' });
    // Port 9 (discard) is closed on any sane host — connection refused.
    const t = new Telemetry({ ...baseDeps, db, url: 'http://127.0.0.1:9' });
    t.record({ type: 'session_started', sessionId: 's1' });
    await t.flush(); // must not throw
    expect(outboxCount(db)).toBe(1);
  });

  // In a container localIp() is the docker bridge, identical on every host, so
  // two deployments would merge into one record at Central.
  test('the deployment id uses the VM address when the deploy passed one', () => {
    const db = openDatabase({ path: ':memory:' });
    const t = new Telemetry({ ...baseDeps, db, url: 'http://127.0.0.1:9', hostIp: '10.54.93.123' });
    expect(t.deploymentId.startsWith('10.54.93.123-')).toBe(true);
  });

  test('a blank host address falls back to what the process can see', () => {
    const db = openDatabase({ path: ':memory:' });
    const t = new Telemetry({ ...baseDeps, db, url: 'http://127.0.0.1:9', hostIp: '  ' });
    expect(t.deploymentId).toMatch(/^[^-]+-\d{4}-\d{2}-\d{2}$/);
  });
});

describe('stage wall-time', () => {
  test('create stamps stage_entered_at; updateCurrentStage re-stamps it', async () => {
    const db = openDatabase({ path: ':memory:' });
    const sessions = new SessionQueries(db);
    const rec = sessions.create({
      id: 'sess-1',
      trigram: 'sess-1',
      pinHash: '',
      packId: 'test-pack',
      locale: 'en',
      clusterEndpoint: '',
      clusterProfile: 'hpoc',
      capabilities: [],
    });
    expect(rec.stageEnteredAt).toBe(rec.startedAt);
    await Bun.sleep(5);
    sessions.updateCurrentStage('sess-1', 'some-stage');
    const after = sessions.byId('sess-1')!;
    expect(after.currentStage).toBe('some-stage');
    expect(after.stageEnteredAt!).toBeGreaterThan(rec.stageEnteredAt!);
  });
});

afterAll(() => {});
