import { describe, expect, test } from 'bun:test';
import { listAllSdk, checkSdk } from '../../../packs/ntnx-infiltration/checks/sdk';
import { createMockAdapter } from '../src/mock-adapter';

describe('check SDK pagination', () => {
  test('finds a resource beyond the first page', async () => {
    const data = Array.from({length: 241}, (_, i) => ({extId: String(i)}));
    const pages: number[] = [];
    const result = await listAllSdk<{extId: string}>(async p => {
      pages.push(p.$page);
      return {data: {data: data.slice(p.$page * p.$limit, (p.$page + 1) * p.$limit), metadata: {totalAvailableResults: data.length}}};
    });
    expect(pages).toEqual([0, 1, 2]);
    expect(result.at(-1)?.extId).toBe('240');
  });
  test('stops at a known total even on a full final page', async () => {
    let calls = 0;
    const result = await listAllSdk(async () => { calls++; return {data: {data: Array(100).fill({}), metadata: {totalAvailableResults: 100}}}; });
    expect(result).toHaveLength(100);
    expect(calls).toBe(1);
  });
  test('accepts the empty envelope returned by PC for zero VPCs or policies', async () => {
    expect(await listAllSdk(async () => ({data: {metadata: {totalAvailableResults: 0}}}))).toEqual([]);
  });
  test('does not hide API failures or malformed inventories as an empty list', async () => {
    await expect(listAllSdk(async () => ({data: {data: {error: 'denied'}}}))).rejects.toThrow('Invalid SDK list');
    await expect(listAllSdk(async () => ({data: {}}))).rejects.toThrow('Invalid SDK list');
    await expect(listAllSdk(async () => { throw new Error('HTTP 503'); })).rejects.toThrow('HTTP 503');
  });
  test('bounds an endpoint that never exhausts', async () => {
    let calls = 0;
    await expect(listAllSdk(async () => { calls++; return {data: {data: Array(100).fill({})}}; })).rejects.toThrow('200 pages');
    expect(calls).toBe(200);
  });
  test('mock SDK honors pages instead of returning the first page repeatedly', async () => {
    const client = createMockAdapter({'GET /api/vmm/v4.0/ahv/config/vms': {data: Array.from({length: 201}, (_, i) => ({extId: String(i)}))}});
    const result = await listAllSdk(p => checkSdk(client).vmm.vms.listVms(p));
    expect(result).toHaveLength(201);
    expect(new Set(result.map((x: any) => x.extId)).size).toBe(201);
  });
  test('microseg detail retains the same envelope as the real SDK', async () => {
    const policy = {extId: 'policy', rules: [{spec: {isAllProtocolAllowed: true}}]};
    const client = createMockAdapter({'GET /api/microseg/v4.0/config/policies/policy': {data: policy}});
    const result: any = await checkSdk(client).microseg.policies.getNetworkSecurityPolicyById('policy');
    expect(result.data.data).toEqual(policy);
  });
});

test('approval check filters by name because the SDK omits page parameters', async () => {
  const { checks } = await import('../../../packs/ntnx-infiltration/checks');
  let options: unknown;
  const result = await checks.CheckApprovalPolicy({
    vars: { get: () => 'abc' },
    cache: { set() {} },
    nutanix: { sdk: {
      datapolicies: { protection: { listProtectionPolicies: async () => ({data: {data: [{extId: 'protection', name: 'abc-prot-policy'}]}}) } },
      security: { approvals: { listApprovalPolicies: async (opts: unknown) => {
        options = opts;
        return {data: {data: [{name: 'master-appr-policy', securedPolicies: [{policyExtId: 'protection'}]}]}};
      } } },
    } },
  } as any);
  expect(result.pass).toBe(true);
  expect(options).toEqual({$filter: "name eq 'master-appr-policy'"});
});
