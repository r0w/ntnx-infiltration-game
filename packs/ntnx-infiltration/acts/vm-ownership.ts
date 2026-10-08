import type { ActContext } from '@ntnx-game/engine';

type RecordValue = Record<string, any>;
class OwnershipConflict extends Error {}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Serialize ownership updates before power operations and retry confirmed conflicts only. */
export async function assignVmOwnership(
  ctx: ActContext,
  vmUuid: string,
  projectUuid: string | undefined,
  ownerUuid: string | undefined,
  pause = delay,
): Promise<void> {
  const path = `/api/nutanix/v3/vms/${vmUuid}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const vm = await ctx.nutanix.rest.request<RecordValue>('GET', path);
      const metadata = { ...vm.metadata };
      if ((!projectUuid || metadata.project_reference?.uuid === projectUuid) &&
          (!ownerUuid || metadata.owner_reference?.uuid === ownerUuid)) return;
      if (projectUuid) metadata.project_reference = { kind: 'project', uuid: projectUuid };
      if (ownerUuid) metadata.owner_reference = { kind: 'user', name: 'theprojectmanager', uuid: ownerUuid };
      const { status: _status, ...body } = vm;
      let accepted: RecordValue;
      try {
        accepted = await ctx.nutanix.rest.request<RecordValue>('PUT', path, { ...body, metadata });
      } catch (err) {
        if (/409|CONCURRENT_REQUESTS/i.test(String(err))) throw new OwnershipConflict(String(err));
        throw err;
      }
      const taskRef = accepted?.status?.execution_context?.task_uuid;
      const taskUuid = Array.isArray(taskRef) ? taskRef[0] : taskRef;
      // HTTP acceptance alone is not success. Without a task, do not repeat an unknown write.
      if (!taskUuid) throw new Error('VM ownership update returned no task; verify its outcome before retrying');
      let succeeded = false;
      for (let poll = 0; poll < 60; poll++) {
        const task = await ctx.nutanix.rest.request<RecordValue>('GET', `/api/nutanix/v3/tasks/${taskUuid}`);
        if (task.status === 'SUCCEEDED') { succeeded = true; break; }
        if (['FAILED', 'ABORTED', 'CANCELLED'].includes(task.status)) {
          const detail = JSON.stringify(task.error_detail ?? task.error_code ?? task.message ?? task);
          const message = `VM ownership task ${task.status}: ${detail}`;
          if (task.status === 'FAILED' && /CONCURRENT_REQUESTS|Logical timestamp mismatch/i.test(detail)) {
            throw new OwnershipConflict(message);
          }
          throw new Error(message);
        }
        await pause(2000);
      }
      if (!succeeded) throw new Error('VM ownership task timed out; verify its outcome before retrying');
      const updated = await ctx.nutanix.rest.request<RecordValue>('GET', path);
      if ((projectUuid && updated.metadata?.project_reference?.uuid !== projectUuid) ||
          (ownerUuid && updated.metadata?.owner_reference?.uuid !== ownerUuid)) {
        throw new Error('VM ownership task succeeded but project or owner was not applied');
      }
      return;
    } catch (err) {
      if (err instanceof OwnershipConflict && attempt < 4) {
        await pause(3000);
        continue;
      }
      throw err;
    }
  }
}
