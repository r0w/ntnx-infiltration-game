import { describe, expect, test } from 'bun:test';
import { selectSecondarySubnet } from '../../../packs/ntnx-infiltration/network';
import { loadConfig } from '../src/config';

describe('secondary network selection', () => {
  test('defaults to the existing HPoC network convention', () => {
    expect(loadConfig({}).gameSecondaryNetwork).toBe('secondary');
    expect(loadConfig({GAME_SECONDARY_NETWORK: '  '}).gameSecondaryNetwork).toBe('secondary');
    expect(selectSecondarySubnet([{name: 'SECONDARY-hpoc'}]).name).toBe('SECONDARY-hpoc');
  });
  test('custom names match exactly, ignoring case', () => {
    const name = loadConfig({GAME_SECONDARY_NETWORK: ' Workshop VLAN '}).gameSecondaryNetwork;
    expect(selectSecondarySubnet([{name: 'secondary'}, {name: 'WORKSHOP VLAN'}], name).name).toBe('WORKSHOP VLAN');
    expect(() => selectSecondarySubnet([{name: 'Workshop VLAN-other'}], name)).toThrow('not found');
  });
  test('exact match wins; ambiguous names require an explicit choice', () => {
    expect(selectSecondarySubnet([{name: 'secondary-a'}, {name: 'secondary'}]).name).toBe('secondary');
    expect(() => selectSecondarySubnet([{name: 'secondary-a'}, {name: 'secondary-b'}])).toThrow('multiple matches');
    expect(() => selectSecondarySubnet([{name: 'Workshop'}, {name: 'WORKSHOP'}], 'Workshop')).toThrow('multiple matches');
  });
});

import { spyOn } from 'bun:test';
import { VariableStore, type CheckContext } from '@ntnx-game/engine';
import { createMockAdapter } from '@ntnx-game/nutanix';
import { readFileSync } from 'node:fs';
import { checks } from '../../../packs/ntnx-infiltration/checks';
import { acts } from '../../../packs/ntnx-infiltration/acts';

function context(wrongNic = false): CheckContext {
  const fixture = JSON.parse(readFileSync(new URL('../../../packs/ntnx-infiltration/fixtures.json', import.meta.url), 'utf8')
    .replaceAll('{Trigram}', 'xy9').replaceAll('"secondary"', '"Workshop VLAN"'));
  if (wrongNic) fixture['GET /api/vmm/v4.0/ahv/config/vms'].data[0].nics[0].nicNetworkInfo.subnet.extId = 'wrong-network';
  const vars = new VariableStore();
  for (const [name, value] of Object.entries({Trigram: 'xy9', SecondaryNetwork: 'Workshop VLAN', PC: 'https://pc.invalid:9440', PCUser: 'admin', PCPassword: 'test'})) vars.set(name, value, 0);
  return {
    vars, args: {},
    session: {id: 's', trigram: 'xy9', locale: 'en', clusterProfile: 'hpoc'},
    cache: {get: () => undefined, set() {}, all: () => []},
    logger: {debug() {}, info() {}, warn() {}, error() {}},
    nutanix: createMockAdapter(fixture),
  };
}

test('VM check accepts the configured network and rejects another second NIC', async () => {
  expect((await checks.CheckVM(context())).pass).toBe(true);
  const wrong = await checks.CheckVM(context(true));
  expect(wrong.pass).toBe(false);
  expect(wrong.detail).toContain('Workshop VLAN');
});

test('auto-play puts the configured network in the VM creation request', async () => {
  const ctx = context();
  (ctx.nutanix.sdk as any).vmm.vms.listVms = async () => ({data: {data: []}});
  let body: any;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    throw new Error('captured creation request');
  });
  try {
    await expect(acts['create-vm'](ctx)).rejects.toThrow('captured creation request');
    expect(body.nics.map((n: any) => n.networkInfo.subnet.extId)).toEqual(['subnet-xy9', 'subnet-secondary']);
  } finally { fetch.mockRestore(); }
});
