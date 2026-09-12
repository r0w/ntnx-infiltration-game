import { expect, test } from 'bun:test';
import type { ActContext } from '@ntnx-game/engine';
import { assignVmOwnership } from '../../../packs/ntnx-infiltration/acts/vm-ownership';

function scenario(outcomes: string[]) {
  const writes: any[] = [];
  let applied = false;
  let reads = 0;
  const ctx = {nutanix: {rest: {async request(method: string, path: string, body: any) {
    if (method === 'PUT') {
      writes.push(body);
      return {status: {execution_context: {task_uuid: 'task'}}};
    }
    if (path.includes('/tasks/')) {
      const outcome = outcomes.shift() ?? 'SUCCEEDED';
      if (outcome === 'transport') throw new Error('task read failed');
      if (outcome === 'FAILED') return {status: 'FAILED', error_detail: 'Logical timestamp mismatch: (1 vs 2)', error_code: 'CONCURRENT_REQUESTS_NOT_ALLOWED'};
      if (outcome === 'denied') return {status: 'FAILED', error_detail: 'permission denied'};
      if (outcome === 'SUCCEEDED') applied = true;
      return {status: outcome};
    }
    return {metadata: {spec_version: ++reads, project_reference: {uuid: applied ? 'project' : 'old'}, owner_reference: {uuid: applied ? 'owner' : 'admin'}}, spec: {name: 'rbo-vm'}, status: {state: 'COMPLETE'}};
  }}}} as unknown as ActContext;
  return {ctx, writes};
}

test('waits for accepted ownership task and verifies project and owner', async () => {
  const {ctx, writes} = scenario(['RUNNING', 'SUCCEEDED']);
  await assignVmOwnership(ctx, 'vm', 'project', 'owner', async () => {});
  expect(writes).toHaveLength(1);
  expect(writes[0].status).toBeUndefined();
});
test('retries an asynchronous concurrency failure with fresh metadata', async () => {
  const {ctx, writes} = scenario(['FAILED', 'SUCCEEDED']);
  await assignVmOwnership(ctx, 'vm', 'project', 'owner', async () => {});
  expect(writes).toHaveLength(2);
  expect(writes[1].metadata.spec_version).toBeGreaterThan(writes[0].metadata.spec_version);
});
test('does not retry a non-concurrency failure', async () => {
  const {ctx, writes} = scenario(['denied']);
  await expect(assignVmOwnership(ctx, 'vm', 'project', 'owner', async () => {})).rejects.toThrow('permission denied');
  expect(writes).toHaveLength(1);
});
test('does not repeat a write when the task result is unknown', async () => {
  const {ctx, writes} = scenario(['transport']);
  await expect(assignVmOwnership(ctx, 'vm', 'project', 'owner', async () => {})).rejects.toThrow('task read failed');
  expect(writes).toHaveLength(1);
});
test('limits retries of confirmed concurrency failures', async () => {
  const {ctx, writes} = scenario(Array(5).fill('FAILED'));
  await expect(assignVmOwnership(ctx, 'vm', 'project', 'owner', async () => {})).rejects.toThrow('timestamp mismatch');
  expect(writes).toHaveLength(5);
});
