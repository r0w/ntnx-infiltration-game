import type { ActContext } from '@ntnx-game/engine';
import type { NutanixSdk } from '@ntnx-game/nutanix';
import { getTrigram, listAllSdk, listAllV4Rest, postV4, postV4Action, waitForTask } from './helpers';

const RECOVERY = '/api/dataprotection/v4.0/config/recovery-points';
type RecoveryPoint = {
  extId?: string; name?: string; status?: string; creationTime?: string;
  sourceLocation?: { clusterExtIds?: string[] };
  vmRecoveryPoints?: Array<{ extId?: string; vmExtId?: string }>;
};

async function findRecovery(ctx: ActContext, vmUuid?: string): Promise<RecoveryPoint | undefined> {
  const points = await listAllV4Rest<RecoveryPoint>(ctx, RECOVERY);
  return points.filter(p => p.name === `${getTrigram(ctx)}-game-recovery` &&
    p.status === 'COMPLETE' && p.extId && p.vmRecoveryPoints?.some(v => v.extId && (!vmUuid || v.vmExtId === vmUuid)))
    .sort((a, b) => (b.creationTime ?? '').localeCompare(a.creationTime ?? ''))[0];
}

/** Keep a named, completed recovery point before the story deletes the VM. */
export async function ensureRecoveryPoint(ctx: ActContext, vmUuid: string): Promise<void> {
  if (ctx.nutanix.mode === 'mock') return;
  if (await findRecovery(ctx, vmUuid)) return;
  const pending = ctx.cache.get('recoveryTask', vmUuid);
  let task = pending?.uuid;
  if (!task) {
    const result = await postV4<{ data?: { extId?: string } }>(ctx, RECOVERY, {
      name: `${getTrigram(ctx)}-game-recovery`,
      vmRecoveryPoints: [{ vmExtId: vmUuid }],
    });
    task = result.data?.extId;
    if (!task) throw new Error('Recovery point creation returned no task');
    ctx.cache.set({ kind: 'recoveryTask', logicalName: vmUuid, uuid: task });
  }
  await waitForTask(ctx, task, 240_000);
  if (!await findRecovery(ctx, vmUuid)) throw new Error('Recovery task completed but the VM recovery point is not ready');
}

/** Restore disks from recovery; never substitute a newly provisioned VM. */
export async function restoreRecoveryVm(ctx: ActContext): Promise<void> {
  const name = `${getTrigram(ctx)}-vm`;
  const sdk = ctx.nutanix.sdk as NutanixSdk;
  const list = () => listAllSdk<{ extId?: string; name?: string; powerState?: string }>(p => sdk.vmm.vms.listVms(p));
  let vm = (await list()).find(v => v.name === name);
  if (!vm?.extId) {
    const point = await findRecovery(ctx);
    const vmPoint = point?.vmRecoveryPoints?.[0];
    if (!point?.extId || !vmPoint?.extId) throw new Error(`No completed game recovery point for ${name}; cannot restore`);
    let task = ctx.cache.get('restoreTask', point.extId)?.uuid;
    if (!task) {
      const result = await postV4<{ data?: { extId?: string } }>(ctx, `${RECOVERY}/${point.extId}/$actions/restore`, {
        clusterExtId: point.sourceLocation?.clusterExtIds?.[0],
        vmRecoveryPointRestoreOverrides: [{
          vmRecoveryPointExtId: vmPoint.extId,
          vmOverrideSpec: { $objectType: 'dataprotection.v4.config.AhvVmOverrideSpec', name },
        }],
      });
      task = result.data?.extId;
      if (!task) throw new Error('VM restore returned no task');
      ctx.cache.set({ kind: 'restoreTask', logicalName: point.extId, uuid: task });
    }
    await waitForTask(ctx, task, 240_000);
  }
  for (let i = 0; i < 60; i++) {
    vm = (await list()).find(v => v.name === name);
    if (vm?.extId && vm.powerState === 'ON') return;
    if (vm?.extId && vm.powerState === 'OFF') {
      const result = await postV4Action<{ data?: { extId?: string } }>(ctx,
        `/api/vmm/v4.2/ahv/config/vms/${vm.extId}`, '$actions/power-on');
      if (result.data?.extId) await waitForTask(ctx, result.data.extId, 240_000);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Restored VM ${name} is not running yet; retry to continue waiting`);
}
