import { describe, expect, test } from 'bun:test';
import { countLcmAvailableUpdates, dedupedUpdateCount, isReadingSettled, readLcmUpdates } from '../src/lcm-updates';
import type { NutanixClient } from '../src/types';

/**
 * Fake PC serving the two LCM endpoints the reader hits. `busy` mimics an
 * inventory running on the PE cluster: the status endpoint reports it (only
 * when asked with the right `X-Cluster-Id`), LCM drops `hasAvailableUpgrades`,
 * and the entity rows lose their `availableVersions` — the live behaviour
 * measured in issue #60.
 */
const fakePc = (opts: { busy?: boolean; entities?: unknown[]; summaries?: unknown[] } = {}) => {
  const seenHeaders: Array<Record<string, string> | undefined> = [];
  const client = {
    mode: 'live',
    sdk: {},
    rest: { request: async () => ({}) },
    async request<T>(_m: string, path: string, _b?: unknown, headers?: Record<string, string>): Promise<T> {
      seenHeaders.push(headers);
      if (path.includes('lcm-summaries')) {
        return {
          data: opts.summaries ?? [
            { clusterExtId: 'pe-1', clusterType: 'AOS', hasAvailableUpgrades: !opts.busy },
            { clusterExtId: 'pc-1', clusterType: 'PRISM_CENTRAL', hasAvailableUpgrades: true },
          ],
        } as T;
      }
      if (path.includes('resources/status')) {
        const forPe = headers?.['X-Cluster-Id'] === 'pe-1';
        return {
          data: { inProgressOperation: opts.busy && forPe ? { operationType: 'INVENTORY' } : {} },
        } as T;
      }
      if (path.includes('resources/entities')) {
        // Page 1+ is always empty; the reader stops on a short page.
        if (!path.includes('$page=0')) return { data: [] } as T;
        const rows = opts.entities ?? [
          { entityType: 'SOFTWARE', entityModel: 'AOS', clusterExtId: 'pe-1', availableVersions: ['7.5.1.2'] },
          { entityType: 'SOFTWARE', entityModel: 'NCC', clusterExtId: 'pe-1', availableVersions: ['5.3.1.1'] },
          { entityType: 'SOFTWARE', entityModel: 'PC', clusterExtId: 'pc-1', availableVersions: ['pc.7.5.1.4'] },
        ];
        // Mid-inventory, availableVersions are wiped but the rows stay.
        return { data: opts.busy ? rows.map((r) => ({ ...r, availableVersions: [] })) : rows } as T;
      }
      throw new Error(`unexpected path ${path}`);
    },
  } as unknown as NutanixClient;
  return { client, seenHeaders };
};

describe('dedupedUpdateCount', () => {
  const pe = new Set(['pe-1']);

  test('counts one update per component, not per node', () => {
    const entities = [
      { entityType: 'FIRMWARE', entityModel: 'NIC X550T', clusterExtId: 'pe-1', availableVersions: ['0x18a5'] },
      { entityType: 'FIRMWARE', entityModel: 'NIC X550T', clusterExtId: 'pe-1', availableVersions: ['0x18a5'] },
      { entityType: 'FIRMWARE', entityModel: 'NIC X550T', clusterExtId: 'pe-1', availableVersions: ['0x18a5'] },
    ];
    expect(dedupedUpdateCount(entities, pe)).toBe(1);
  });

  test('ignores entities with no available version and non-PE clusters', () => {
    const entities = [
      { entityType: 'SOFTWARE', entityModel: 'AOS', clusterExtId: 'pe-1', availableVersions: ['7.5.1.2'] },
      { entityType: 'SOFTWARE', entityModel: 'Foundation', clusterExtId: 'pe-1', availableVersions: [] },
      { entityType: 'SOFTWARE', entityModel: 'PC', clusterExtId: 'pc-1', availableVersions: ['pc.7.5.1.4'] },
    ];
    expect(dedupedUpdateCount(entities, pe)).toBe(1);
  });
});

describe('isReadingSettled', () => {
  const withUpgrades = [{ extId: 'pe-1', hasAvailableUpgrades: true }];
  const withoutUpgrades = [{ extId: 'pe-1', hasAvailableUpgrades: false }];

  test('an in-progress operation condemns the reading', () => {
    expect(isReadingSettled(withUpgrades, 6, true)).toBe(false);
  });

  test('zero while LCM says the cluster has upgrades is mid-rebuild', () => {
    expect(isReadingSettled(withUpgrades, 0, false)).toBe(false);
  });

  test('zero on a cluster LCM says is up to date is a real zero', () => {
    expect(isReadingSettled(withoutUpgrades, 0, false)).toBe(true);
  });

  test('counting updates LCM says do not exist is mid-rebuild', () => {
    expect(isReadingSettled(withoutUpgrades, 4, false)).toBe(false);
  });

  test('no flag (older PC, mock fixtures) never condemns the reading', () => {
    expect(isReadingSettled([{ extId: 'pe-1' }], 0, false)).toBe(true);
  });
});

describe('readLcmUpdates', () => {
  test('counts PE updates and reports them settled on an idle cluster', async () => {
    const { client, seenHeaders } = fakePc();
    expect(await readLcmUpdates(client)).toEqual({ count: 2, settled: true });
    // The status call must carry the cluster scope, or PC answers for the PCVM
    // and reports idle right through a PE inventory.
    expect(seenHeaders).toContainEqual({ 'X-Cluster-Id': 'pe-1' });
  });

  test('reports the wiped mid-inventory count as unsettled', async () => {
    const { client } = fakePc({ busy: true });
    expect(await readLcmUpdates(client)).toEqual({ count: 0, settled: false });
  });

  test('countLcmAvailableUpdates withholds a mid-inventory count', async () => {
    expect(await countLcmAvailableUpdates(fakePc({ busy: true }).client)).toBeNull();
    expect(await countLcmAvailableUpdates(fakePc().client)).toBe(2);
  });
});
