import { expect, test } from 'bun:test';
import { VariableStore, type CheckContext, type NutanixClient } from '@ntnx-game/engine';
import { acts } from '../../../packs/ntnx-infiltration/acts';
import { checks } from '../../../packs/ntnx-infiltration/checks';

function context(states: Array<string | undefined>, vpc = true) {
  const vars = new VariableStore();
  vars.set('Trigram', 'rbo', 1);
  let reads = 0;
  const ctx: CheckContext = {
    vars, args: {},
    session: { id: 's', trigram: 'rbo', locale: 'en', clusterProfile: 'hpoc' },
    cache: { get: () => undefined, set() {}, all: () => [] },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    nutanix: {
      mode: 'live',
      rest: {
        async request(_method: string, path: string) {
          if (path.includes('/apps/list')) {
            const state = states[Math.min(reads++, states.length - 1)];
            return { entities: [{ metadata: { uuid: 'app' }, status: {
              name: 'rbo-app', state,
              resources: { app_blueprint_reference: { name: 'CloneProd' } },
            } }] };
          }
          if (path.includes('/vpcs')) return { data: vpc ? [{ name: 'rbo-vpc', extId: 'vpc' }] : [] };
          throw new Error(`Unexpected request: ${path}`);
        },
      },
    } as unknown as NutanixClient,
  };
  ctx.nutanix.request = ctx.nutanix.rest.request.bind(ctx.nutanix.rest);
  return { ctx, reads: () => reads };
}

for (const state of ['error', 'provisioning', 'deleted', undefined]) {
  test(`check rejects ${state} even when VPC exists`, async () => {
    const result = await checks.CheckCloneApp(context([state]).ctx);
    expect(result.pass).toBe(false);
    expect(result.captured).toBeUndefined();
  });
}

test('check accepts running application with its VPC', async () => {
  const result = await checks.CheckCloneApp(context(['running']).ctx);
  expect(result.pass).toBe(true);
  expect(result.captured).toEqual({ VpcUUID: 'vpc' });
});

test('check still requires the VPC after provisioning succeeds', async () => {
  expect((await checks.CheckCloneApp(context(['running'], false).ctx)).pass).toBe(false);
});

test('auto-play fails immediately when cloning failed after VPC creation', async () => {
  await expect(acts['clone-app-blueprint'](context(['error']).ctx)).rejects.toThrow('application rbo-app is error');
});

test('auto-play refreshes provisioning state before accepting an existing VPC', async () => {
  const c = context(['provisioning', 'provisioning', 'running']);
  await acts['clone-app-blueprint'](c.ctx);
  expect(c.reads()).toBe(3);
}, 12_000);
