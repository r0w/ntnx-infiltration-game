import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NutanixClient } from '@ntnx-game/engine';
import { ClusterConfigQueries } from '../src/db/queries';
import { refreshLcmCount } from '../src/cluster-config-probe';

const SCHEMA = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql'),
  'utf8',
);

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** PC answering the LCM reads. `busy` = an inventory is rebuilding the list. */
function fakePc(count: number, busy = false): NutanixClient {
  const rows = Array.from({ length: count }, (_, i) => ({
    entityType: 'SOFTWARE',
    entityModel: `component-${i}`,
    clusterExtId: 'pe-1',
    availableVersions: busy ? [] : ['1.0'],
  }));
  return {
    mode: 'live',
    async request<T>(_m: string, path: string, _b?: unknown, headers?: Record<string, string>): Promise<T> {
      if (path.includes('lcm-summaries')) {
        return {
          data: [{ clusterExtId: 'pe-1', clusterType: 'AOS', hasAvailableUpgrades: !busy }],
        } as T;
      }
      if (path.includes('resources/status')) {
        const forPe = headers?.['X-Cluster-Id'] === 'pe-1';
        return { data: { inProgressOperation: busy && forPe ? { operationType: 'INVENTORY' } : {} } } as T;
      }
      if (path.includes('resources/entities')) {
        return { data: path.includes('$page=0') ? rows : [] } as T;
      }
      throw new Error(`unexpected path ${path}`);
    },
  } as unknown as NutanixClient;
}

function newCfg(): ClusterConfigQueries {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return new ClusterConfigQueries(db);
}

// Stage 29 judges against this row while an inventory rebuilds the live count,
// so it must stay true: refreshed whenever LCM is quiet, never with noise, and
// never over the operator's own value — that value IS the escape hatch for the
// day our count stops matching the LCM page.
describe('refreshLcmCount', () => {
  test('refreshes the probe value when LCM is quiet', async () => {
    const cfg = newCfg();
    cfg.set('lcm_available_updates', 4, 'probe');
    await refreshLcmCount({ nutanix: fakePc(6), cfg, logger: silentLogger });
    expect(cfg.get('lcm_available_updates')).toBe(6);
  });

  test('writes nothing while an inventory is rebuilding the list', async () => {
    const cfg = newCfg();
    cfg.set('lcm_available_updates', 6, 'probe');
    await refreshLcmCount({ nutanix: fakePc(6, true), cfg, logger: silentLogger });
    expect(cfg.get('lcm_available_updates')).toBe(6); // kept, not overwritten with the wiped 0
  });

  test('never overwrites the operator', async () => {
    const cfg = newCfg();
    cfg.set('lcm_available_updates', 7, 'admin');
    await refreshLcmCount({ nutanix: fakePc(6), cfg, logger: silentLogger });
    const row = cfg.getRow<number>('lcm_available_updates');
    expect(row).toEqual({ value: 7, source: 'admin' });
  });

  test('is a no-op in mock mode', async () => {
    const cfg = newCfg();
    const mock = { mode: 'mock', request: async () => ({}) } as unknown as NutanixClient;
    await refreshLcmCount({ nutanix: mock, cfg, logger: silentLogger });
    expect(cfg.get('lcm_available_updates')).toBeUndefined();
  });
});
