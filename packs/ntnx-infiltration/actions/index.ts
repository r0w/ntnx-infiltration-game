import type { ActionContext } from '@ntnx-game/engine';
import type { NutanixSdk } from '@ntnx-game/nutanix';
import { deleteV4Entity, listAllSdk } from '../acts/helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = Record<string, any>;

/**
 * Server-side handlers for `<action name='foo'/>` tags in stage messages.
 * They run in every mode: mock handlers mutate the session's overlay so
 * fixtures shadow the effect; test/live handlers hit the real Nutanix API.
 * A couple are still mock-only no-ops where live wiring is pending.
 */

function trigram(ctx: ActionContext): string {
  const t = ctx.vars.get('Trigram');
  return typeof t === 'string' ? t : '';
}

/**
 * Stage 23 `incident-freeze`: the villains delete the player's VM. Runs in
 * every mode (the story does it, not the player): mock marks `{Trigram}-vm`
 * deleted in the overlay; test/live really DELETE it via the v4 API. The
 * stage's `invalidates: ['VMUUID', 'HostUUID']` clears the cached vars. The
 * restore half is the player's job, checked at stage 26 by `CheckRestoreVM`.
 */
async function deleteVM(ctx: ActionContext): Promise<void> {
  const name = `${trigram(ctx)}-vm`;
  if (ctx.nutanix.mode === 'mock') {
    ctx.mockOverlay.mark('vm', name, 'deleted');
    ctx.logger.info('mock: deleteVM marked entity deleted', { name });
    return;
  }
  // Find by name (SDK list is crash-safe on 200), then ETag-aware delete.
  const sdk = ctx.nutanix.sdk as NutanixSdk;
  const vms = await listAllSdk<AnyRec>(($p) => sdk.vmm.vms.listVms($p));
  const vm = vms.find((v) => v.name === name);
  if (!vm?.extId) {
    ctx.logger.info('deleteVM: no VM found to delete', { name });
    return;
  }
  await deleteV4Entity(ctx, '/api/vmm/v4.0/ahv/config/vms', vm.extId);
  ctx.logger.info('deleteVM: VM deleted', { name });
}

/**
 * Inverse of `deleteVM`, emitted by stage 26's `<action name='restoreVM'/>`.
 * Mock un-marks the VM so the fixture reappears and `CheckRestoreVM` passes.
 * In test/live it's a no-op: the player (or the stage-26 act) does the real
 * restore from a recovery point.
 */
async function restoreVM(ctx: ActionContext): Promise<void> {
  const name = `${trigram(ctx)}-vm`;
  if (ctx.nutanix.mode === 'mock') {
    ctx.mockOverlay.unmark('vm', name);
    ctx.logger.info('mock: restoreVM cleared deleted mark', { name });
    return;
  }
  ctx.logger.warn('restoreVM live-mode handler not implemented yet', { name });
}

/**
 * Stage 37 `modify-blueprint`: clones the cluster's `*-source` blueprint
 * into `bp-blankvm-prd{Vlanid}` so the player's edit has a target (the
 * `actions.DeployBP` equivalent from the original ntnx-escape-game Python).
 * Mock no-op (the fixture already exposes the target); live lists blueprints,
 * finds the `*-source` one, and POSTs `/clone` with the target name.
 */
async function deployBlueprint(ctx: ActionContext): Promise<void> {
  if (ctx.nutanix.mode === 'mock') {
    ctx.logger.info('mock: deployBlueprint noop (fixture already has target blueprint)');
    return;
  }
  const vlan = ctx.vars.get('Vlanid');
  const target = `bp-blankvm-prd${vlan ?? ''}`;
  // Already deployed?
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = await ctx.nutanix.rest.request<{ entities?: any[] }>(
    'POST',
    '/api/nutanix/v3/blueprints/list',
    { kind: 'blueprint', length: 250 },
  );
  if (
    existing.entities?.some(
      (b) => b.metadata?.name === target || b.status?.name === target,
    )
  ) {
    ctx.logger.info('deployBlueprint: target already exists', { target });
    return;
  }
  const source = existing.entities?.find((b) =>
    /source$/.test(b.metadata?.name ?? b.status?.name ?? ''),
  );
  if (!source?.metadata?.uuid) {
    ctx.logger.warn(`deployBlueprint: no '*-source' blueprint to clone, skipping`);
    return;
  }
  ctx.logger.info(`deployBlueprint: cloning ${source.metadata?.name} → ${target}`);
  await ctx.nutanix.rest.request(
    'POST',
    `/api/nutanix/v3/blueprints/${source.metadata.uuid}/clone`,
    {
      blueprint_name: target,
      metadata: { kind: 'blueprint', uuid: crypto.randomUUID() },
    },
  );
}

/**
 * Stage 13 `verify-prod-user-isolation`: silent action fired after `create-vm`.
 * Snapshots the VM (`POST .../config/recovery-points`) so the later delete
 * (stage 23) then restore (stage 26) chain has a recovery point to work from.
 * Mock no-op. Idempotent: skips quietly if VMUUID isn't captured yet.
 */
async function createRecoveryPoint(ctx: ActionContext): Promise<void> {
  if (ctx.nutanix.mode === 'mock') {
    ctx.logger.info('mock: createRecoveryPoint noop');
    return;
  }
  const vmUuid = ctx.vars.get('VMUUID');
  if (typeof vmUuid !== 'string' || vmUuid.length === 0) {
    ctx.logger.info('createRecoveryPoint: no VMUUID captured yet, skipping');
    return;
  }
  try {
    await ctx.nutanix.rest.request(
      'POST',
      '/api/dataprotection/v4.0/config/recovery-points',
      { vmRecoveryPoints: [{ vmExtId: vmUuid }] },
    );
    ctx.logger.info('createRecoveryPoint: snapshot created', { vmUuid });
  } catch (err) {
    ctx.logger.warn('createRecoveryPoint: snapshot failed', {
      err: String(err).slice(0, 200),
    });
  }
}

export const actions = {
  deleteVM,
  restoreVM,
  deployBlueprint,
  createRecoveryPoint,
};
