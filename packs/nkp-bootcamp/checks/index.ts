import type { CheckContext, CheckResult } from '@ntnx-game/engine';

/** The learner is assigned a user number (`user01`, `user02`, ...) that scopes
 * their namespace and objects, exactly as in the bootcamp. Accepts `01`, `1`,
 * `user01`, `user1`; normalises to the zero-padded form so downstream
 * `user{UserNum}` always matches the bootcamp's `user##` namespaces. */
async function CheckUserNum(ctx: CheckContext): Promise<CheckResult> {
  const raw = String(ctx.vars.get('UserNum') ?? '').trim().toLowerCase().replace(/^user/, '');
  const num = Number.parseInt(raw, 10);
  if (String(num) === raw.replace(/^0+/, '') || /^0*\d{1,2}$/.test(raw)) {
    if (Number.isInteger(num) && num >= 1 && num <= 99) {
      const padded = String(num).padStart(2, '0');
      return { pass: true, detail: `user${padded}`, captured: { UserNum: padded } };
    }
  }
  return { pass: false, hint: 'Enter your assigned user number, for example 01 or user01.' };
}

/**
 * First real cluster-state check (bootcamp "Block storage with Nutanix Volumes").
 * The learner pasted the MySQL manifest into the Kubernetes Dashboard while their
 * `user##` namespace was selected. We assert the resulting objects on the cluster:
 * a Bound PVC on the default `nutanix-volume` StorageClass and the MySQL Deployment.
 */
async function CheckBlockStorage(ctx: CheckContext): Promise<CheckResult> {
  const n = String(ctx.vars.get('UserNum') ?? '').trim();
  if (!/^\d{1,2}$/.test(n)) return { pass: false, neutral: true, hint: 'Missing user number, restart the first step.' };
  if (!ctx.kube) return { pass: false, neutral: true, hint: 'k8s transport unavailable.' };
  const ns = `user${n}`;

  const pvcs = await ctx.kube.list({ version: 'v1', plural: 'persistentvolumeclaims', namespace: ns });
  const pvc = pvcs.find((p) => (p.metadata as { name?: string })?.name === 'mysql-pv-claim');
  if (!pvc) return { pass: false, hint: `No PersistentVolumeClaim "mysql-pv-claim" in namespace ${ns} yet.` };

  const status = pvc.status as { phase?: string } | undefined;
  if (status?.phase !== 'Bound') return { pass: false, hint: `PVC mysql-pv-claim is ${status?.phase ?? 'not Bound'} — the volume has not been provisioned yet.` };

  const spec = pvc.spec as { storageClassName?: string; resources?: { requests?: { storage?: string } } } | undefined;
  if (spec?.storageClassName && spec.storageClassName !== 'nutanix-volume') {
    return { pass: false, hint: `PVC is bound to "${spec.storageClassName}", expected the default block StorageClass nutanix-volume.` };
  }

  const deps = await ctx.kube.list({ group: 'apps', version: 'v1', plural: 'deployments', namespace: ns });
  const dep = deps.find((d) => (d.metadata as { name?: string })?.name === 'wordpress-mysql');
  if (!dep) return { pass: false, hint: 'PVC is Bound, but the wordpress-mysql Deployment is missing — apply the whole manifest.' };
  const containers =
    ((dep.spec as { template?: { spec?: { containers?: Array<{ image?: string }> } } })?.template?.spec?.containers) ?? [];
  if (!containers.some((c) => c.image === 'mysql:8.0')) {
    return { pass: false, hint: 'wordpress-mysql Deployment found, but not running the mysql:8.0 image.' };
  }

  const size = spec?.resources?.requests?.storage ?? '?';
  return { pass: true, detail: `mysql-pv-claim Bound (${size}, nutanix-volume) + wordpress-mysql running in ${ns}` };
}

export const checks = { CheckUserNum, CheckBlockStorage };
