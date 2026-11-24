import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { openDatabase } from '../src/db/database';
import { Telemetry, type TelemetryDeps } from '../src/telemetry';
import { probeSoftwareVersions, type SoftwareVersionsProbeResult } from '../src/cluster-status-probe';
import type { NutanixClient } from '@ntnx-game/engine';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const versions: SoftwareVersionsProbeResult = { rows: [
  { component: 'Prism Central', version: 'pc.2024.3', source: 'pc' },
  { component: 'AOS', version: '7.6', source: 'pc' },
] };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function harness(overrides: Partial<TelemetryDeps> = {}) {
  const db = openDatabase({ path: ':memory:' });
  const envelopes: Array<Record<string, unknown>> = [];
  const send = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    envelopes.push(JSON.parse(String(init!.body)).deployment);
    return Response.json({ ok: true });
  });
  const telemetry = new Telemetry({ db, logger, url: 'https://central.invalid',
    deploymentIp: '10.0.0.1', packId: 'pack', packVersion: '1',
    serverMode: 'test', clusterProfile: 'other', ...overrides });
  cleanup.push(() => { telemetry.stop(); send.mockRestore(); db.close(); });
  async function flush() {
    telemetry.record({ type: 'session_started', sessionId: 'test' });
    await telemetry.flush();
  }
  return { telemetry, envelopes, flush };
}

// Drain promise continuations without relying on a real timer or network.
async function settled() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

describe('telemetry software versions', () => {
  test('startup probes even with an empty outbox and caches successful versions', async () => {
    let calls = 0;
    const { telemetry, envelopes, flush } = harness({ probeVersions: async () => { calls++; return versions; } });
    telemetry.start();
    await settled();
    expect(calls).toBe(1);
    await flush();
    await flush();
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({ pcVersion: 'pc.2024.3', aosVersion: '7.6' });
    expect(calls).toBe(1);
  });

  test('a hanging probe never blocks startup, delivery, or causes overlapping probes', async () => {
    let calls = 0;
    let resolve!: (result: SoftwareVersionsProbeResult) => void;
    const { telemetry, envelopes, flush } = harness({ probeVersions: () => {
      calls++; return new Promise((done) => { resolve = done; });
    } });
    telemetry.start();
    await flush();
    await flush();
    expect(calls).toBe(1);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).not.toHaveProperty('pcVersion');
    expect(envelopes[0]).not.toHaveProperty('aosVersion');
    resolve(versions);
    await settled();
    await flush();
    expect(envelopes[2]).toMatchObject({ pcVersion: 'pc.2024.3', aosVersion: '7.6' });
  });

  test.each(['throw', 'reject', 'empty'] as const)('a %s failure is retried only on a later flush', async (failure) => {
    let calls = 0;
    const { telemetry, envelopes, flush } = harness({ probeVersions: () => {
      calls++;
      if (calls > 1) return Promise.resolve(versions);
      if (failure === 'throw') throw new Error('unreachable');
      if (failure === 'reject') return Promise.reject(new Error('unreachable'));
      return Promise.resolve({ rows: [], error: 'unreachable' });
    } });
    telemetry.start();
    await settled();
    expect(calls).toBe(1);
    await settled();
    expect(calls).toBe(1);
    await flush();
    await settled();
    expect(calls).toBe(2);
    expect(envelopes[0]).not.toHaveProperty('pcVersion');
    await flush();
    expect(envelopes[1]).toMatchObject({ pcVersion: 'pc.2024.3', aosVersion: '7.6' });
  });

  test('partial results are included while a missing component is retried', async () => {
    let calls = 0;
    const { telemetry, envelopes, flush } = harness({ probeVersions: async () => {
      calls++;
      return calls === 1 ? { rows: [versions.rows[0]!] } : versions;
    } });
    telemetry.start();
    await settled();
    await flush();
    expect(envelopes[0]).toHaveProperty('pcVersion', 'pc.2024.3');
    expect(envelopes[0]).not.toHaveProperty('aosVersion');
    await settled();
    await flush();
    expect(envelopes[1]).toHaveProperty('aosVersion', '7.6');
    expect(calls).toBe(2);
  });

  test.each(['disabled', 'mock'] as const)('%s telemetry makes no probe requests', async (mode) => {
    let calls = 0;
    const { telemetry, envelopes, flush } = harness({
      ...(mode === 'disabled' ? { url: '' } : { serverMode: 'mock' }),
      probeVersions: async () => { calls++; return versions; },
    });
    telemetry.start();
    await flush();
    await settled();
    expect(calls).toBe(0);
    if (mode === 'mock') expect(envelopes[0]).not.toHaveProperty('pcVersion');
    else expect(envelopes).toHaveLength(0);
  });

  test('the existing probe feeds actual PC/AOS data, preserving mixed AOS versions', async () => {
    const requests: string[] = [];
    const nutanix = { mode: 'live', request: async (_method: string, path: string) => {
      requests.push(path);
      if (path.includes('/clusters/list')) return { entities: [
        { status: { resources: { config: { build: { version: 'pc.7.3' }, service_list: ['PRISM_CENTRAL'] } } } },
        ...['7.6', '7.5', '7.6'].map((version) => ({ status: { resources: { config: { build: { version } } } } })),
      ] };
      return { data: [{ entityType: 'SOFTWARE', entityModel: 'Files', entityVersion: '5.0' }] };
    } } as unknown as NutanixClient;
    const { telemetry, envelopes, flush } = harness({
      probeVersions: () => probeSoftwareVersions({ nutanix, logger }),
    });
    telemetry.start();
    await settled();
    await flush();
    expect(requests.filter((path) => path.includes('/clusters/list'))).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ pcVersion: 'pc.7.3', aosVersion: '7.5, 7.6' });
    expect(envelopes[0]).not.toHaveProperty('Files');
  });
});
