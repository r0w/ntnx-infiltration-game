import { expect, spyOn, test } from 'bun:test';
import { VariableStore, type ActContext, type CheckContext } from '@ntnx-game/engine';
import { acts } from '../../../packs/ntnx-infiltration/acts';
import { checks } from '../../../packs/ntnx-infiltration/checks';

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

test('category check rejects missing, wrong or merely shared ownership for either value', async () => {
  for (const owner of [undefined, 'other']) {
    const categories = pair('project');
    categories[1]!.projectExtId = owner;
    Object.assign(categories[1]!, { sharedProjects: ['project'] });
    const result = await checks.CheckCat(context(categories) as CheckContext);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('Owner Project');
  }
  expect((await checks.CheckCat(context(pair('project')) as CheckContext)).pass).toBe(true);
});

test('category act creates both values with Owner Project and verifies persistence', async () => {
  const categories: any[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toEndWith('/api/prism/v4.4/config/categories');
    const body = JSON.parse(String(init?.body));
    expect(body.projectExtId).toBe('project');
    categories.push({ ...body, extId: body.value });
    return Response.json({ data: categories.at(-1) });
  });
  try {
    await acts['create-category']!(context(categories));
    expect(categories.map(c => c.value)).toEqual(['Critical', 'Test']);
  } finally { fetch.mockRestore(); }
});

test('category act refuses existing wrong ownership without deletion or sharing', async () => {
  const fetch = spyOn(globalThis, 'fetch');
  try {
    await expect(acts['create-category']!(context(pair('other')))).rejects.toThrow('Owner Project');
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});

test('category act rejects a successful response that did not persist ownership', async () => {
  const categories: any[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { projectExtId: _ignored, ...body } = JSON.parse(String(init?.body));
    categories.push(body);
    return Response.json({ data: body });
  });
  try { await expect(acts['create-category']!(context(categories))).rejects.toThrow('Owner Project'); }
  finally { fetch.mockRestore(); }
});

for (const stage of ['create-microseg-policy', 'create-protection-policy']) {
  test(`${stage} propagates a rejected asynchronous task`, async () => {
    const ctx = context(pair('project'));
    ctx.nutanix.sdk = {
      prism: { categories: { listCategories: async () => ({ data: { data: pair('project') } }) } },
      microseg: { policies: { listNetworkSecurityPolicies: async () => ({ data: { data: [] } }) } },
      datapolicies: { protection: { listProtectionPolicies: async () => ({ data: { data: [] } }) } },
    };
    ctx.nutanix.rest.request = async (_method: string, path: string): Promise<any> => {
      if (path.includes('/categories')) return { data: pair('project') };
      if (path.includes('/tasks/')) return { data: { status: 'FAILED', errorMessages: ['Project category rejected'] } };
      return { data: [{ extId: 'cluster' }] };
    };
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (stage === 'create-microseg-policy') {
        expect(String(url)).toContain('/microseg/v4.3/');
        expect(JSON.parse(String(init?.body)).projectExtId).toBe('project');
      }
      return Response.json({ data: { extId: 'task', $objectType: 'prism.v4.config.TaskReference' } });
    });
    try { await expect(acts[stage]!(ctx)).rejects.toThrow('Project category rejected'); }
    finally { fetch.mockRestore(); }
  });
}
