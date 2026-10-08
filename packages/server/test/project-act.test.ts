import { expect, test } from 'bun:test';
import { VariableStore, type CheckContext, type NutanixClient } from '@ntnx-game/engine';
import { createMockAdapter } from '@ntnx-game/nutanix';
import { acts } from '../../../packs/ntnx-infiltration/acts';

function setup(existing = true, failure = false, member = false) {
  const vars = new VariableStore(); vars.set('Trigram', 'rbo', 1);
  const calls: Array<{method: string; path: string; body: any}> = [];
  let submitted = false;
  let created = existing;
  const resources = {
    account_reference_list: [{uuid: 'account'}],
    user_reference_list: [{uuid: 'existing-user', name: 'alice'}, ...(member ? [{uuid: 'pm', name: 'theprojectmanager'}] : [])],
    directory_reference_list: [{uuid: 'other-directory'}],
    subnet_reference_list: [{uuid: 'custom-subnet'}],
    enable_directory_and_identity_provider_shortlist: true,
  };
  const project = () => ({metadata: {uuid: 'project', spec_version: 3}, spec: {name: 'rbo-proj', resources}, status: {state: 'COMPLETE', resources}});
  const sdk = createMockAdapter({
    'GET /api/iam/v4.0/authn/users': {data: [{extId: 'pm', username: 'theprojectmanager'}]},
    'GET /api/networking/v4.0/config/subnets': {data: [{extId: 'secondary', name: 'secondary'}]},
  }).sdk;
  const ctx: CheckContext = {
    vars, args: {}, session: {id: 's', trigram: 'rbo', locale: 'en', clusterProfile: 'hpoc'},
    cache: {get: () => undefined, set() {}, all: () => []},
    logger: {debug() {}, info() {}, warn() {}, error() {}},
    nutanix: {mode: 'live', sdk, rest: {async request(method: string, path: string, body: any) {
      calls.push({method, path, body});
      if (path.endsWith('/projects/list')) return {entities: created ? [project()] : []};
      if (path.endsWith('/clusters')) return {data: [{extId: 'cluster'}]};
      if (path.endsWith('/accounts/list')) return {entities: [{metadata: {uuid: 'account'}, status: {resources: {type: 'nutanix_pc'}}}]};
      if (path.endsWith('/directory-services')) return {data: [{extId: 'directory'}]};
      if (path.endsWith('/roles/list')) return {entities: [{metadata: {uuid: 'role'}, status: {name: 'Project Admin'}}]};
      if (path.endsWith('/projects') && method === 'POST') { created = true; return {}; }
      if (path.endsWith('/projects_internal/project')) { submitted = true; return {}; }
      if (path.endsWith('/projects/project')) {
        if (!submitted) return project();
        if (failure) return {status: {state: 'ERROR', message_list: [{message: 'directory not whitelisted'}]}};
        return {status: {state: 'COMPLETE', resources: {user_reference_list: [{uuid: 'pm'}]}}};
      }
      throw new Error(`Unexpected ${method} ${path}`);
    }}} as unknown as NutanixClient,
  };
  return {ctx, calls};
}

test('auto-play repairs an existing project and preserves members and infrastructure', async () => {
  const {ctx, calls} = setup();
  await acts['create-project'](ctx);
  expect(calls.some(c => c.path.endsWith('/projects') && c.method === 'POST')).toBe(false);
  const resources = calls.find(c => c.method === 'PUT')!.body.spec.project_detail.resources;
  expect(resources.user_reference_list.map((u: any) => u.uuid)).toEqual(['existing-user', 'pm']);
  expect(resources.directory_reference_list.map((d: any) => d.uuid)).toEqual(['other-directory', 'directory']);
  expect(resources.subnet_reference_list).toEqual([{uuid: 'custom-subnet'}]);
  expect(resources.enable_directory_and_identity_provider_shortlist).toBe(true);
});

test('auto-play reports an asynchronous project failure instead of success', async () => {
  await expect(acts['create-project'](setup(true, true).ctx)).rejects.toThrow('directory not whitelisted');
});

test('auto-play still creates a missing project and assigns its member', async () => {
  const {ctx, calls} = setup(false);
  await acts['create-project'](ctx);
  expect(calls.filter(c => c.path.endsWith('/projects') && c.method === 'POST')).toHaveLength(1);
  expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1);
});

test('auto-play does not duplicate an existing project membership', async () => {
  const {ctx, calls} = setup(true, false, true);
  await acts['create-project'](ctx);
  expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0);
});
