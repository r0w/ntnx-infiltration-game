import { expect, spyOn, test } from 'bun:test';
import { VariableStore, type ActContext } from '@ntnx-game/engine';
import { acts } from '../../../packs/ntnx-infiltration/acts';

function context(categories: any[]) {
  const vars = new VariableStore();
  for (const [key, value] of Object.entries({ Trigram: 'own', PC: 'https://pc.invalid', PCUser: 'admin', PCPassword: 'test' })) vars.set(key, value, 'test');
  return {
    vars, session: { locale: 'en' }, cache: { set() {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    nutanix: { sdk: {}, rest: { request: async (_method: string, path: string) => {
      if (path.includes('/projects/list')) return { entities: [{ metadata: { uuid: 'project' }, spec: { name: 'own-proj' } }] };
      if (path.includes('/categories')) return { data: categories };
      throw new Error(`Unexpected ${path}`);
    } } },
  } as unknown as ActContext;
}
const pair = (projectExtId?: string) => ['Critical', 'Test'].map(value => ({ extId: value, key: 'own-cat', value, projectExtId }));

for (const stage of ['create-microseg-policy', 'create-protection-policy']) {
  test(`${stage} propagates a rejected asynchronous task`, async () => {
    const ctx = context(pair());
    ctx.nutanix.sdk = {
      prism: { categories: { listCategories: async () => ({ data: { data: pair() } }) } },
      microseg: { policies: { listNetworkSecurityPolicies: async () => ({ data: { data: [] } }) } },
      datapolicies: { protection: { listProtectionPolicies: async () => ({ data: { data: [] } }) } },
    };
    ctx.nutanix.rest.request = async (_method: string, path: string): Promise<any> => {
      if (path.includes('/categories')) return { data: pair() };
      if (path.includes('/tasks/')) return { data: { status: 'FAILED', errorMessages: ['Project category rejected'] } };
      return { data: [{ extId: 'cluster' }] };
    };
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (stage === 'create-microseg-policy') {
        expect(String(url)).toContain('/microseg/v4.0/');
        expect(JSON.parse(String(init?.body)).projectExtId).toBeUndefined();
      }
      return Response.json({ data: { extId: 'task', $objectType: 'prism.v4.config.TaskReference' } });
    });
    try { await expect(acts[stage]!(ctx)).rejects.toThrow('Project category rejected'); }
    finally { fetch.mockRestore(); }
  });
}
