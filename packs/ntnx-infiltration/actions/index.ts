import type { ActionContext } from '@ntnx-game/engine';

/**
 * Server-side action handlers referenced by `<action name='foo'/>` tags in
 * stage messages. Mock-mode handlers mutate the session's mock overlay so
 * fixture responses shadow the action's effect; live-mode handlers would
 * hit the Nutanix API to do the real thing. Live wiring is deferred until
 * a cluster is available — right now every handler is a mock-only no-op
 * when `ctx.nutanix.mode !== 'mock'`.
 */

function trigram(ctx: ActionContext): string {
  const t = ctx.vars.get('Trigram');
  return typeof t === 'string' ? t : '';
}

/**
 * Stage 23 `incident-freeze` — simulates the villains deleting the player's
 * VM. In mock mode, marks `{Trigram}-vm` as deleted in the overlay so
 * subsequent queries against the VM list endpoint drop it. Paired with
 * `stage.invalidates: ['VMUUID', 'HostUUID']` which handles the session-var
 * side.
 */
async function deleteVM(ctx: ActionContext): Promise<void> {
  const name = `${trigram(ctx)}-vm`;
  if (ctx.nutanix.mode === 'mock') {
    ctx.mockOverlay.mark('vm', name, 'deleted');
    ctx.logger.info('mock: deleteVM marked entity deleted', { name });
    return;
  }
  ctx.logger.warn('deleteVM live-mode handler not implemented yet', { name });
}

/**
 * Inverse of `deleteVM` — un-marks the VM so the mock fixture reappears in
 * list responses. Fired manually via `POST /api/session/:id/action/restoreVM`
 * during mock validation (no stage emits it in the default pack) to unblock
 * stage 26's `CheckRestoreVM` once the tester has observed it fail.
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
 * Stage 37 `modify-blueprint` — clones the cluster's `*-source` blueprint
 * (typically `BlankVM-source`) into `bp-blankvm-prd{Vlanid}` so the
 * subsequent player edit (add `foo` task) has a target. Equivalent to
 * `actions.DeployBP` in the original `r0w/ntnx-escape-game` Python.
 *
 * In mock mode, the fixture already exposes `bp-blankvm-prd{Vlanid}` so
 * we just log. In live mode, list blueprints, find the one whose name
 * ends in `source`, and POST `/clone` with the target name.
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
    ctx.logger.warn(`deployBlueprint: no '*-source' blueprint to clone — skipping`);
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
 * Stage 13 `verify-prod-user-isolation` — silent action that fires right
 * after `create-vm` passes. Creates a VM recovery point so the later
 * `incident-freeze` (stage 23, delete) → `restore-vm-from-recovery` (stage
 * 26) chain can actually restore from a snapshot. The original Python
 * `CheckVM` in `r0w/ntnx-escape-game` baked this into the check function
 * itself; we keep the cleaner separation by exposing it as an action and
 * triggering via the locale's `<action name='createRecoveryPoint'/>` tag.
 *
 * Endpoint: `POST /api/dataprotection/v4.0/config/recovery-points` with
 * `{vmRecoveryPoints: [{vmExtId: <VMUUID>}]}`. Idempotent: skip if VMUUID
 * isn't set (CheckVM hasn't run) — silent no-op so it doesn't pollute logs
 * during the lore/login stages.
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
