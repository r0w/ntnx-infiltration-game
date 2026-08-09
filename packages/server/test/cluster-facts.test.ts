import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NutanixClient } from '@ntnx-game/engine';
import { ClusterConfigQueries } from '../src/db/queries';
import { storeClusterFacts } from '../src/cluster-facts';
import { makePackProbes } from '../src/pack-probes';
import { readClusterFacts } from '../../../packs/ntnx-infiltration/boot/cluster-facts';

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

/**
 * The reading and the storing are now two halves — the pack asks its cluster,
 * the server decides what may be overwritten — so what these pin is the pair
 * composed, which is the only thing stage 29 actually depends on.
 *
 * Stage 29 judges against this row while an inventory rebuilds the live count,
 * so it must stay true: refreshed whenever LCM is quiet, never with noise, and
 * never over the operator's own value — that value IS the escape hatch for the
 * day our count stops matching the LCM page.
 *
 * The fake PC below answers no discover-unconfigured-nodes call, so the serials
 * fact is simply absent from every run here. That is the other half of the
 * contract: a fact the cluster will not give up is omitted, not guessed.
 */
async function probeInto(cfg: ClusterConfigQueries, nutanix: NutanixClient): Promise<void> {
  // The real boot context, probes included: the LCM reading still goes through
  // the server-side helper, which is where the mid-inventory rule lives.
  const ctx = {
    mode: nutanix.mode,
    env: {},
    logger: silentLogger,
    transports: { nutanix },
    probes: makePackProbes(nutanix, silentLogger),
  };
  await storeClusterFacts({
    facts: await readClusterFacts(ctx),
    cfg,
    logger: silentLogger,
  });
}

describe('the LCM count stage 29 judges against', () => {
  test('refreshes the probe value when LCM is quiet', async () => {
    const cfg = newCfg();
    cfg.set('lcm_available_updates', 4, 'probe');
    await probeInto(cfg, fakePc(6));
    expect(cfg.get('lcm_available_updates')).toBe(6);
  });

  test('writes nothing while an inventory is rebuilding the list', async () => {
    const cfg = newCfg();
    cfg.set('lcm_available_updates', 6, 'probe');
    await probeInto(cfg, fakePc(6, true));
    expect(cfg.get('lcm_available_updates')).toBe(6); // kept, not overwritten with the wiped 0
  });

  test('never overwrites the operator', async () => {
    const cfg = newCfg();
    cfg.set('lcm_available_updates', 7, 'admin');
    await probeInto(cfg, fakePc(6));
    const row = cfg.getRow<number>('lcm_available_updates');
    expect(row).toEqual({ value: 7, source: 'admin' });
  });

  test('is a no-op in mock mode', async () => {
    const cfg = newCfg();
    const mock = { mode: 'mock', request: async () => ({}) } as unknown as NutanixClient;
    await probeInto(cfg, mock);
    expect(cfg.get('lcm_available_updates')).toBeUndefined();
  });
});

/**
 * The storage half, tested directly rather than only through a pack.
 *
 * These three rules are the server's, and they are what stops a probe from
 * quietly undoing an operator's decision on event day. The `if-absent` path in
 * particular is never reached above, because the fake PC answers no
 * discover-unconfigured-nodes call.
 */
describe('how a cluster fact is allowed to be written', () => {
  test('if-absent caches once and never touches an existing value', async () => {
    const cfg = newCfg();
    await storeClusterFacts({
      facts: [{ key: 'discoverable_node_serials', value: ['A'], write: 'if-absent' }],
      cfg,
      logger: silentLogger,
    });
    expect(cfg.get('discoverable_node_serials')).toEqual(['A']);
    await storeClusterFacts({
      facts: [{ key: 'discoverable_node_serials', value: ['B'], write: 'if-absent' }],
      cfg,
      logger: silentLogger,
    });
    expect(cfg.get('discoverable_node_serials')).toEqual(['A']);
  });

  test('if-absent is the default, so a pack that says nothing cannot clobber', async () => {
    const cfg = newCfg();
    cfg.set('k', 'first', 'probe');
    await storeClusterFacts({ facts: [{ key: 'k', value: 'second' }], cfg, logger: silentLogger });
    expect(cfg.get('k')).toBe('first');
  });

  test('refresh replaces a probed value', async () => {
    const cfg = newCfg();
    cfg.set('k', 1, 'probe');
    await storeClusterFacts({
      facts: [{ key: 'k', value: 2, write: 'refresh' }],
      cfg,
      logger: silentLogger,
    });
    expect(cfg.get('k')).toBe(2);
  });

  test('but never the operator’s, whichever mode the pack asked for', async () => {
    for (const write of ['if-absent', 'refresh'] as const) {
      const cfg = newCfg();
      cfg.set('k', 'mine', 'admin');
      await storeClusterFacts({ facts: [{ key: 'k', value: 'theirs', write }], cfg, logger: silentLogger });
      expect(`${write}: ${cfg.get('k')}`).toBe(`${write}: mine`);
    }
  });

  test('a fact the pack omitted leaves the stored one alone', async () => {
    const cfg = newCfg();
    cfg.set('k', 'kept', 'probe');
    await storeClusterFacts({ facts: [], cfg, logger: silentLogger });
    expect(cfg.get('k')).toBe('kept');
  });
});
