import { expect, test } from 'bun:test';
import { VariableStore, type CheckContext } from '@ntnx-game/engine';
import { checks } from '../../../packs/ntnx-infiltration/checks';
import { createMockAdapter, withVariableInterpolation } from '@ntnx-game/nutanix';
import fixtures from '../../../packs/ntnx-infiltration/fixtures.json';

const scoped = { securedGroupCategoryAssociatedEntityType: 'VM', securedGroupCategoryReferences: ['critical'] };
const rule = (spec: any) => ({ type: 'APPLICATION', spec: { ...scoped, ...spec } });
const outbound = () => rule({ destAllowSpec: 'ALL', isAllProtocolAllowed: true });
const ssh = () => rule({ srcSubnet: { value: '10.0.0.42', prefixLength: 32 }, tcpServices: [{ startPort: 22, endPort: 22 }] });
const echo = () => rule({ srcAllowSpec: 'ALL', icmpServices: [{ type: 8, code: 0 }] });
const policy = (rules: any[]) => ({ extId: 'policy', type: 'APPLICATION', state: 'ENFORCE', isHitlogEnabled: true, rules });
function ctx(p: any): CheckContext {
  const vars = new VariableStore();
  vars.set('Trigram', 'rbo', 'test'); vars.set('frontendHost', '10.0.0.42', 'test');
  return {
    vars, args: {}, session: { id: 'test', locale: 'en' }, cache: { set() {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    nutanix: { mode: 'live', sdk: {
      prism: { categories: { listCategories: async () => ({ data: { data: [{ extId: 'critical', key: 'rbo-cat', value: 'Critical' }] } }) } },
      microseg: {
        policies: {
          listNetworkSecurityPolicies: async () => ({ data: { data: [{ extId: 'policy', name: 'rbo-mseg-policy' }] } }),
          getNetworkSecurityPolicyById: async () => ({ data: { data: p } }),
        },
        serviceGroups: { listServiceGroups: async () => ({ data: { data: [{ extId: 'ssh-service', name: 'ssh' }] } }) },
      },
    } },
  } as unknown as CheckContext;
}
const first = (p: any) => checks.CheckSecurityPolicy!(ctx(p));
const second = (p: any) => checks.CheckSecurityPolicy2!(ctx(p));

test('initial policy accepts implicit or explicit inbound denial and ignores intra-group allowance', async () => {
  for (const inbound of [[], [rule({ srcAllowSpec: 'NONE' })]]) {
    const p = policy([outbound(), ...inbound, { type: 'INTRA_GROUP', spec: { ...scoped, securedGroupAction: 'ALLOW' } }]);
    expect((await first(p)).pass).toBe(true);
  }
  expect((await first(policy([outbound(), ssh()]))).pass).toBe(false);
  expect((await first(policy([rule({ srcAllowSpec: 'ALL', isAllProtocolAllowed: true })]))).pass).toBe(false);
});

test('both stages require Enforce, Hitlogs, application type and correct category on every application rule', async () => {
  for (const check of [first, second]) {
    for (const change of [{ state: 'MONITOR' }, { state: undefined }, { type: 'ISOLATION' }, { isHitlogEnabled: false }, { isIpv6TrafficAllowed: true }]) {
      expect((await check({ ...policy(check === first ? [outbound()] : [outbound(), ssh(), echo()]), ...change })).pass).toBe(false);
    }
  }
  const p = policy([outbound(), ssh(), echo()]);
  p.rules[1].spec.securedGroupCategoryReferences = ['other'];
  expect((await second(p)).pass).toBe(false);
});

test('final policy accepts raw discovered TCP22 or ssh service and separate global echo rule', async () => {
  expect((await second(policy([outbound(), ssh(), echo()]))).pass).toBe(true);
  expect((await second(policy([outbound(), rule({ srcSubnet: { value: '10.0.0.42', prefixLength: 32 }, serviceGroupReferences: ['ssh-service'] }), echo()]))).pass).toBe(true);
});

test('rejects broad, wrong-source, mixed and wrong-direction allowances', async () => {
  const invalid = [
    { srcSubnet: { value: '10.0.0.42', prefixLength: 24 } },
    { srcSubnet: { value: '10.0.0.43', prefixLength: 32 } },
    { srcAllowSpec: 'ALL' },
    { tcpServices: [{ startPort: 1, endPort: 65535 }] },
    { isAllProtocolAllowed: true },
    { udpServices: [{ startPort: 53, endPort: 53 }] },
    { serviceGroupReferences: ['unknown'] },
    { icmpServices: [{ type: 8, code: 0 }] },
    { destAllowSpec: 'ALL' },
  ];
  for (const change of invalid) {
    const s = ssh(); Object.assign(s.spec, change);
    expect((await second(policy([outbound(), s, echo()]))).pass).toBe(false);
  }
  const broad = rule({ srcAllowSpec: 'ALL', isAllProtocolAllowed: true });
  expect((await second(policy([outbound(), ssh(), echo(), broad]))).pass).toBe(false);
  const unknownProtocol = rule({ srcAllowSpec: 'ALL', isAllProtocolAllowed: false, icmpv6Services: [{ isAllAllowed: true }] });
  expect((await first(policy([outbound(), unknownProtocol]))).pass).toBe(false);
  expect((await second(policy([outbound(), ssh(), echo(), unknownProtocol]))).pass).toBe(false);
});

test('ICMP must be inbound Echo Request from Allow All, not restricted to game IP', async () => {
  for (const change of [
    { srcAllowSpec: undefined, srcSubnet: { value: '10.0.0.42', prefixLength: 32 } },
    { icmpServices: [{ type: 0, code: 0 }] }, { icmpServices: [{ type: 8, code: 1 }] },
    { icmpServices: [{ isAllAllowed: true }] }, { icmpServices: [{ type: 8, code: 0, isAllAllowed: true }] },
    { destAllowSpec: 'ALL', srcAllowSpec: undefined },
  ]) {
    const e = echo(); Object.assign(e.spec, change);
    expect((await second(policy([outbound(), ssh(), e]))).pass).toBe(false);
  }
});

test('mock stages model the before/after policy without weakening the checks or sharing state', async () => {
  const base = createMockAdapter(fixtures);
  for (const stage of ['create-microseg-policy', 'allow-ssh-in-microseg']) {
    const c = ctx(null);
    c.nutanix = withVariableInterpolation(base, () => c.vars.snapshot(), () => stage);
    expect((await checks[stage === 'create-microseg-policy' ? 'CheckSecurityPolicy' : 'CheckSecurityPolicy2']!(c)).pass).toBe(true);
    expect((await checks[stage === 'create-microseg-policy' ? 'CheckSecurityPolicy2' : 'CheckSecurityPolicy']!(c)).pass).toBe(false);
  }
});
