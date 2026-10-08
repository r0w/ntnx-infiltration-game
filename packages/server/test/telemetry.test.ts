import { afterAll, describe, expect, spyOn, test } from 'bun:test';
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
        deploymentIp: '10.38.66.43',
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
        deployment: { id: string; ip: string; packId: string; packTitle: string; mode: string };
        events: Array<{ type: string; stageId?: string; ts: number }>;
      };
      expect(payload.deployment.id).toBe(t.deploymentId);
      expect(payload.deployment.ip).toBe('10.38.66.43');
      expect(payload.deployment.id).toStartWith('10.38.66.43-');
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

  test('different VMs booted on the same day have distinct Central identities', () => {
    const firstDb = openDatabase({ path: ':memory:' });
    const secondDb = openDatabase({ path: ':memory:' });
    const first = new Telemetry({ ...baseDeps, db: firstDb, url: 'http://127.0.0.1:9', deploymentIp: '10.38.66.43' });
    const second = new Telemetry({ ...baseDeps, db: secondDb, url: 'http://127.0.0.1:9', deploymentIp: '10.38.66.93' });
    const restarted = new Telemetry({ ...baseDeps, db: firstDb, url: 'http://127.0.0.1:9', deploymentIp: '10.38.66.43' });
    expect(first.deploymentId).not.toBe(second.deploymentId);
    expect(restarted.deploymentId).toBe(first.deploymentId);
    firstDb.close();
    secondDb.close();
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

  test('telemetry initialization failure disables statistics without throwing', () => {
    const db = openDatabase({ path: ':memory:' });
    db.exec('DROP TABLE cluster_config');
    const t = new Telemetry({ ...baseDeps, db, url: 'http://127.0.0.1:9', deploymentIp: '10.38.66.43' });
    expect(t.enabled).toBe(false);
    expect(() => { t.record({ type: 'session_started', sessionId: 's1' }); t.start(); t.stop(); }).not.toThrow();
    expect(outboxCount(db)).toBe(0);
    db.close();
  });

  test('broken outbox never propagates an error to the game', async () => {
    const db = openDatabase({ path: ':memory:' });
    const t = new Telemetry({ ...baseDeps, db, url: 'http://127.0.0.1:9', deploymentIp: '10.38.66.43' });
    db.exec('DROP TABLE telemetry_outbox');
    expect(() => t.record({ type: 'session_started', sessionId: 's1' })).not.toThrow();
    await expect(t.flush()).resolves.toBeUndefined();
    db.close();
  });

  test('logging failures cannot escape telemetry startup or error handling', async () => {
    const db = openDatabase({ path: ':memory:' });
    const fail = () => { throw new Error('log output unavailable'); };
    const deps = { ...baseDeps, db, logger: { debug: fail, info: fail, warn: fail, error: fail }, url: 'http://127.0.0.1:9' };
    const t = new Telemetry(deps);
    db.exec('DROP TABLE telemetry_outbox');
    expect(() => t.start()).not.toThrow();
    expect(() => t.record({ type: 'session_started', sessionId: 's1' })).not.toThrow();
    await expect(t.flush()).resolves.toBeUndefined();
    t.stop();
    db.exec('DROP TABLE cluster_config');
    expect(() => new Telemetry(deps)).not.toThrow();
    db.close();
  });

  test('a stalled send runs in the background and times out without blocking new events', async () => {
    const db = openDatabase({ path: ':memory:' });
    const t = new Telemetry({ ...baseDeps, db, url: 'http://central.invalid', deploymentIp: '10.38.66.43' });
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(20));
    let sending = false;
    const request = spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      sending = true;
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    try {
      t.record({ type: 'session_started', sessionId: 's1' });
      t.start();
      expect(sending).toBe(true);
      t.record({ type: 'stage_passed', sessionId: 's1', stageId: 'eg-001' });
      expect(outboxCount(db)).toBe(2);
      expect(timeout).toHaveBeenCalledWith(5000);
      await Bun.sleep(40);
      expect(outboxCount(db)).toBe(2);
      request.mockResolvedValue(Response.json({ ok: true }));
      await t.flush();
      expect(outboxCount(db)).toBe(0);
    } finally {
      t.stop(); request.mockRestore(); timeout.mockRestore(); db.close();
    }
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
