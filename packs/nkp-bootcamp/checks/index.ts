import type { CheckContext, CheckResult, KubeClient, KubeResourceRef } from '@ntnx-game/engine';

// ── the fleet, as the bootcamp stages it ────────────────────────────────────
// Names verified live on DM3-POC102 (NKP 2.17): the Default Workspace's
// namespace on the management cluster, and the two workload clusters the labs
// federate into.
const WORKSPACE_NS = 'kommander-default-workspace';
const WORKLOAD1 = 'workload01';
const WORKLOAD2 = 'workload02';

const PROJECTS = {
  group: 'workspaces.kommander.mesosphere.io',
  version: 'v1alpha1',
  plural: 'projects',
  namespace: WORKSPACE_NS,
} as const satisfies KubeResourceRef;

const GITREPOS = {
  group: 'source.toolkit.fluxcd.io',
  version: 'v1',
  plural: 'gitrepositories',
} as const satisfies KubeResourceRef;

/** The repository the GitOps lab syncs. */
const BOUTIQUE_REPO = 'https://github.com/nutanixdev/nkp-microservices-demo.git';
/** 11 microservices plus redis, per the lab text. */
const BOUTIQUE_DEPLOYMENTS = 12;
/** The label the dynamic-assignment lab selects clusters on. */
const DYNAMIC_LABEL = { key: 'infraId', value: 'pc' };

// ── small helpers ───────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function name(item: Obj): string {
  return (item.metadata as { name?: string } | undefined)?.name ?? '';
}

function namespaceOf(item: Obj): string {
  return (item.metadata as { namespace?: string } | undefined)?.namespace ?? '';
}

function findByName(items: Obj[], wanted: string): Obj | undefined {
  return items.find((i) => name(i) === wanted);
}

/**
 * Every stage after the first is scoped to the learner's `user##` identity.
 * A missing number or an absent transport is a broken session rather than a
 * wrong answer, so both fail neutral and cost the player nothing.
 */
type Scope = { ns: string; num: string } | { fail: CheckResult };

function scope(ctx: CheckContext): Scope {
  const n = String(ctx.vars.get('UserNum') ?? '').trim();
  if (!/^\d{1,2}$/.test(n)) {
    return { fail: { pass: false, neutral: true, hint: 'Missing user number, restart the first step.' } };
  }
  if (!ctx.kube) {
    return { fail: { pass: false, neutral: true, hint: 'Kubernetes transport unavailable, tell your instructor.' } };
  }
  return { ns: `user${n}`, num: n };
}

function kubeOf(ctx: CheckContext): KubeClient {
  // Only reached after scope() has proved ctx.kube is present.
  return ctx.kube as KubeClient;
}

// ── stage 1: identity ───────────────────────────────────────────────────────

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

// ── multi-tenancy ───────────────────────────────────────────────────────────

/**
 * The learner created an NKP Project named `user##` on workload01.
 *
 * A Project is a management-cluster object; the namespace it federates out is
 * what shows up on the workload cluster. We assert the Project itself, so a
 * hand-made namespace does not pass, and then that its namespace really landed
 * on workload01.
 */
async function CheckProject(ctx: CheckContext): Promise<CheckResult> {
  const s = scope(ctx);
  if ('fail' in s) return s.fail;
  const kube = kubeOf(ctx);

  const projects = await kube.list(PROJECTS);
  const project = findByName(projects, s.ns);
  if (!project) {
    const others = projects.map(name).filter(Boolean);
    return {
      pass: false,
      hint: others.length
        ? `No project named "${s.ns}" in the Default Workspace yet. Projects there: ${others.join(', ')}.`
        : `No project named "${s.ns}" in the Default Workspace yet.`,
    };
  }

  const spec = project.spec as
    | { namespaceName?: string; placement?: { clusters?: Array<{ name?: string }> } }
    | undefined;
  if (spec?.namespaceName && spec.namespaceName !== s.ns) {
    return {
      pass: false,
      hint: `Project "${s.ns}" uses namespace "${spec.namespaceName}". ID / Namespace must match the project name.`,
    };
  }

  const placed = (spec?.placement?.clusters ?? []).map((c) => c.name).filter(Boolean) as string[];
  if (placed.length > 0 && !placed.includes(WORKLOAD1)) {
    return { pass: false, hint: `Project "${s.ns}" targets ${placed.join(', ')}. Select ${WORKLOAD1}.` };
  }

  const namespaces = await kube.list({ version: 'v1', plural: 'namespaces', cluster: WORKLOAD1 });
  if (!findByName(namespaces, s.ns)) {
    return {
      pass: false,
      neutral: true,
      hint: `Project "${s.ns}" exists but its namespace has not reached ${WORKLOAD1} yet. Give it a few seconds.`,
    };
  }

  return { pass: true, detail: `project ${s.ns} federated to ${WORKLOAD1}` };
}

// ── persistent storage ──────────────────────────────────────────────────────

/**
 * Block storage lab: the learner pasted the MySQL manifest into the Kubernetes
 * Dashboard with their `user##` namespace selected. We assert the resulting
 * objects on workload01: a Bound PVC on the default `nutanix-volume`
 * StorageClass and the MySQL Deployment.
 */
async function CheckBlockStorage(ctx: CheckContext): Promise<CheckResult> {
  const s = scope(ctx);
  if ('fail' in s) return s.fail;
  const kube = kubeOf(ctx);

  const pvcs = await kube.list({ version: 'v1', plural: 'persistentvolumeclaims', namespace: s.ns, cluster: WORKLOAD1 });
  const pvc = findByName(pvcs, 'mysql-pv-claim');
  if (!pvc) return { pass: false, hint: `No PersistentVolumeClaim "mysql-pv-claim" in namespace ${s.ns} yet.` };

  const status = pvc.status as { phase?: string } | undefined;
  if (status?.phase !== 'Bound') {
    return {
      pass: false,
      hint: `PVC mysql-pv-claim is ${status?.phase ?? 'not Bound'}, the volume has not been provisioned yet.`,
    };
  }

  const spec = pvc.spec as
    | { storageClassName?: string; resources?: { requests?: { storage?: string } } }
    | undefined;
  if (spec?.storageClassName && spec.storageClassName !== 'nutanix-volume') {
    return {
      pass: false,
      hint: `PVC is bound to "${spec.storageClassName}", expected the default block StorageClass nutanix-volume.`,
    };
  }

  const deps = await kube.list({ group: 'apps', version: 'v1', plural: 'deployments', namespace: s.ns, cluster: WORKLOAD1 });
  const dep = findByName(deps, 'wordpress-mysql');
  if (!dep) return { pass: false, hint: 'PVC is Bound, but the wordpress-mysql Deployment is missing. Apply the whole manifest.' };

  const containers =
    ((dep.spec as { template?: { spec?: { containers?: Array<{ image?: string }> } } })?.template?.spec?.containers) ?? [];
  if (!containers.some((c) => c.image === 'mysql:8.0')) {
    return { pass: false, hint: 'wordpress-mysql Deployment found, but not running the mysql:8.0 image.' };
  }

  const size = spec?.resources?.requests?.storage ?? '?';
  return { pass: true, detail: `mysql-pv-claim Bound (${size}, nutanix-volume) + wordpress-mysql running in ${s.ns}` };
}

/**
 * File storage lab: the WordPress frontend needs ReadWriteMany, which only
 * Nutanix Files provides here. The access mode and the StorageClass are the
 * assertions that matter, because a learner who leaves the defaults gets a
 * working single-replica app on block storage and misses the point of the lab.
 */
async function CheckFileStorage(ctx: CheckContext): Promise<CheckResult> {
  const s = scope(ctx);
  if ('fail' in s) return s.fail;
  const kube = kubeOf(ctx);

  const pvcs = await kube.list({ version: 'v1', plural: 'persistentvolumeclaims', namespace: s.ns, cluster: WORKLOAD1 });
  const pvc = findByName(pvcs, 'wp-pv-claim');
  if (!pvc) return { pass: false, hint: `No PersistentVolumeClaim "wp-pv-claim" in namespace ${s.ns} yet.` };

  const spec = pvc.spec as { storageClassName?: string; accessModes?: string[] } | undefined;
  if (spec?.storageClassName !== 'nutanix-files') {
    return {
      pass: false,
      hint: `wp-pv-claim uses "${spec?.storageClassName ?? 'the default class'}". WordPress needs storageClassName: nutanix-files.`,
    };
  }
  if (!(spec?.accessModes ?? []).includes('ReadWriteMany')) {
    return { pass: false, hint: 'wp-pv-claim is not ReadWriteMany, so the frontend replicas cannot share it.' };
  }

  const status = pvc.status as { phase?: string } | undefined;
  if (status?.phase !== 'Bound') {
    return {
      pass: false,
      hint: `PVC wp-pv-claim is ${status?.phase ?? 'not Bound'}, Nutanix Files has not provisioned the share yet.`,
    };
  }

  const deps = await kube.list({ group: 'apps', version: 'v1', plural: 'deployments', namespace: s.ns, cluster: WORKLOAD1 });
  const dep = findByName(deps, 'wordpress');
  if (!dep) return { pass: false, hint: 'The share is ready, but the wordpress Deployment is missing. Apply the whole manifest.' };

  const replicas = (dep.spec as { replicas?: number } | undefined)?.replicas ?? 1;
  if (replicas < 2) {
    return {
      pass: false,
      hint: `The wordpress Deployment asks for ${replicas} replica. The manifest runs 2, which is what shared storage buys you.`,
    };
  }

  return { pass: true, detail: `wp-pv-claim Bound (ReadWriteMany, nutanix-files) + wordpress x${replicas} in ${s.ns}` };
}

/**
 * The WordPress Ingress. Its host carries the learner's own number, so this is
 * also the check that proves they customised the manifest instead of pasting
 * the example verbatim.
 */
async function CheckWordpressIngress(ctx: CheckContext): Promise<CheckResult> {
  const s = scope(ctx);
  if ('fail' in s) return s.fail;
  const kube = kubeOf(ctx);

  const ingresses = await kube.list({
    group: 'networking.k8s.io',
    version: 'v1',
    plural: 'ingresses',
    namespace: s.ns,
    cluster: WORKLOAD1,
  });
  const ing = findByName(ingresses, 'wordpress');
  if (!ing) return { pass: false, hint: `No Ingress named "wordpress" in namespace ${s.ns} yet.` };

  const spec = ing.spec as
    | {
        ingressClassName?: string;
        rules?: Array<{ host?: string; http?: { paths?: Array<{ backend?: { service?: { name?: string } } }> } }>;
      }
    | undefined;

  if (spec?.ingressClassName !== 'kommander-traefik') {
    return { pass: false, hint: `Ingress class is "${spec?.ingressClassName ?? 'unset'}", expected kommander-traefik.` };
  }

  const rule = spec?.rules?.[0];
  const host = rule?.host ?? '';
  if (!host) return { pass: false, hint: 'The Ingress has no host rule.' };
  if (!host.startsWith(`wordpress${s.num}.`)) {
    return {
      pass: false,
      hint: `Host is "${host}". It must start with wordpress${s.num}. so it is yours and not another learner's.`,
    };
  }
  if (!host.endsWith('.sslip.io')) {
    return { pass: false, hint: `Host "${host}" does not end in .sslip.io, so it will not resolve to the ingress IP.` };
  }

  const backend = rule?.http?.paths?.[0]?.backend?.service?.name;
  if (backend !== 'wordpress') {
    return { pass: false, hint: `The rule points at service "${backend ?? 'nothing'}", expected wordpress.` };
  }

  return { pass: true, detail: `https://${host} -> wordpress:80` };
}

// ── GitOps ──────────────────────────────────────────────────────────────────

/**
 * The learner added a GitOps source on their project's Continuous Deployment
 * tab, which lands as a Flux GitRepository. We search the management cluster
 * across namespaces so a source created in the wrong scope produces a useful
 * hint rather than a bare "not found".
 */
async function CheckGitOpsSource(ctx: CheckContext): Promise<CheckResult> {
  const s = scope(ctx);
  if ('fail' in s) return s.fail;
  const kube = kubeOf(ctx);

  const repos = await kube.list(GITREPOS);
  const named = repos.filter((r) => name(r) === 'online-boutique');
  if (named.length === 0) {
    return {
      pass: false,
      hint: 'No GitOps source named "online-boutique" yet. Add it on your project\'s Continuous Deployment tab.',
    };
  }

  const repo = named.find((r) => namespaceOf(r) === s.ns);
  if (!repo) {
    return {
      pass: false,
      hint: `A source named "online-boutique" exists in ${named.map(namespaceOf).join(', ')}, but not in your project ${s.ns}. Create it from your own project.`,
    };
  }

  const spec = repo.spec as { url?: string; ref?: { branch?: string } } | undefined;
  const url = (spec?.url ?? '').replace(/\.git$/, '');
  if (url !== BOUTIQUE_REPO.replace(/\.git$/, '')) {
    return { pass: false, hint: `The source points at "${spec?.url ?? 'nothing'}". Expected ${BOUTIQUE_REPO}.` };
  }
  if (spec?.ref?.branch && spec.ref.branch !== 'main') {
    return { pass: false, hint: `Branch is "${spec.ref.branch}", expected main.` };
  }

  // Flux reports its own sync health; a source that cannot clone never deploys.
  const conditions =
    ((repo.status as { conditions?: Array<{ type?: string; status?: string; message?: string }> } | undefined)?.conditions) ?? [];
  const ready = conditions.find((c) => c.type === 'Ready');
  if (ready && ready.status !== 'True') {
    return { pass: false, neutral: true, hint: `Flux has not synced the repository yet: ${ready.message ?? 'still reconciling'}.` };
  }

  return { pass: true, detail: `online-boutique synced in ${s.ns}` };
}

/**
 * Counts the boutique's own available Deployments on a cluster.
 *
 * The learner's namespace also holds the WordPress stack from the storage labs,
 * so counting everything in it would report the boutique as running before Flux
 * had pulled a single microservice. Flux stamps what it applies with
 * `kustomize.toolkit.fluxcd.io/name`, which is precisely "deployed from Git
 * rather than by hand" — the distinction this whole chapter is about.
 */
const FLUX_OWNED = 'kustomize.toolkit.fluxcd.io/name';

async function boutiqueOn(kube: KubeClient, ns: string, cluster: string): Promise<{ total: number; ready: number }> {
  const all = await kube.list({ group: 'apps', version: 'v1', plural: 'deployments', namespace: ns, cluster });
  const deps = all.filter((d) => {
    const labels = (d.metadata as { labels?: Record<string, string> } | undefined)?.labels ?? {};
    return FLUX_OWNED in labels;
  });
  const ready = deps.filter((d) => ((d.status as { availableReplicas?: number } | undefined)?.availableReplicas ?? 0) > 0);
  return { total: deps.length, ready: ready.length };
}

/**
 * The boutique app, deployed by Flux rather than by hand. We count Deployments
 * instead of naming all eleven microservices: the lab's own success criterion
 * is "12 deployments running", and hardcoding the service list would break the
 * game every time the upstream demo repo adds one.
 */
async function CheckBoutiqueRunning(ctx: CheckContext): Promise<CheckResult> {
  const s = scope(ctx);
  if ('fail' in s) return s.fail;
  const kube = kubeOf(ctx);

  const { total, ready } = await boutiqueOn(kube, s.ns, WORKLOAD1);
  if (total === 0) {
    return { pass: false, hint: `Nothing deployed in ${s.ns} on ${WORKLOAD1} yet. Flux may still be syncing.` };
  }
  if (ready < BOUTIQUE_DEPLOYMENTS) {
    return {
      pass: false,
      neutral: true,
      hint: `${ready} of ${BOUTIQUE_DEPLOYMENTS} boutique deployments are up on ${WORKLOAD1}. Give the pods a moment to start.`,
    };
  }

  const services = await kube.list({ version: 'v1', plural: 'services', namespace: s.ns, cluster: WORKLOAD1 });
  const frontend = findByName(services, 'frontend-external');
  if (!frontend) {
    return { pass: false, hint: 'The pods are running but the frontend-external service is missing.' };
  }
  const lbIngress =
    ((frontend.status as { loadBalancer?: { ingress?: Array<{ ip?: string }> } } | undefined)?.loadBalancer?.ingress) ?? [];
  const ip = lbIngress[0]?.ip;
  if (!ip) {
    return { pass: false, neutral: true, hint: 'frontend-external has no external IP yet. MetalLB is still assigning one.' };
  }

  return { pass: true, detail: `${ready} deployments up, boutique at http://${ip}` };
}

/**
 * Dynamic assignment: the project switches from a hand-picked cluster list to
 * a label selector, and workload02 joins on its own. Asserting the selector as
 * well as the outcome matters, because manually adding workload02 to the list
 * produces the same namespace without teaching anything.
 */
async function CheckDynamicProject(ctx: CheckContext): Promise<CheckResult> {
  const s = scope(ctx);
  if ('fail' in s) return s.fail;
  const kube = kubeOf(ctx);

  const projects = await kube.list(PROJECTS);
  const project = findByName(projects, s.ns);
  if (!project) {
    return { pass: false, hint: `No project named "${s.ns}" to edit. Create it in the multi-tenancy lab first.` };
  }

  const placement = (
    project.spec as
      | { placement?: { clusterSelector?: { matchLabels?: Record<string, string> }; clusters?: Array<{ name?: string }> } }
      | undefined
  )?.placement;
  const labels = placement?.clusterSelector?.matchLabels;
  if (!labels || Object.keys(labels).length === 0) {
    return { pass: false, hint: 'The project still selects clusters manually. Switch the assignment method to Dynamic.' };
  }
  const value = labels[DYNAMIC_LABEL.key];
  if (value === undefined) {
    return {
      pass: false,
      hint: `The selector uses ${Object.keys(labels).join(', ')} but not "${DYNAMIC_LABEL.key}". Mind the capital I in infraId.`,
    };
  }
  if (value !== DYNAMIC_LABEL.value) {
    return { pass: false, hint: `The selector reads ${DYNAMIC_LABEL.key}: ${value}, expected ${DYNAMIC_LABEL.value}.` };
  }

  const namespaces = await kube.list({ version: 'v1', plural: 'namespaces', cluster: WORKLOAD2 });
  if (!findByName(namespaces, s.ns)) {
    return {
      pass: false,
      neutral: true,
      hint: `The selector is right, but ${s.ns} has not reached ${WORKLOAD2} yet. Give it a few seconds.`,
    };
  }

  const { ready } = await boutiqueOn(kube, s.ns, WORKLOAD2);
  if (ready === 0) {
    return { pass: false, neutral: true, hint: `${WORKLOAD2} joined your project, but the boutique pods are still starting there.` };
  }

  return { pass: true, detail: `${WORKLOAD2} joined on ${DYNAMIC_LABEL.key}=${DYNAMIC_LABEL.value}, ${ready} deployments up` };
}

// ── optional labs: the simple NGINX app ─────────────────────────────────────
//
// These four run from a terminal, where the namespace depends on whatever
// context the learner's kubeconfig carries, and the bootcamp's own output
// shows `default`. The object name already carries the learner's number, so we
// search workload01 across namespaces and match on the name rather than
// insisting on a namespace the lab never asks them to set.

function simpleAppName(num: string): string {
  return `user${num}-nkp-simple-app`;
}

async function findSimpleApp(kube: KubeClient, num: string, plural: string, group?: string): Promise<Obj | undefined> {
  const items = await kube.list({ group, version: 'v1', plural, cluster: WORKLOAD1 });
  return findByName(items, simpleAppName(num));
}

/** `kubectl create deployment user##-nkp-simple-app --image=nginx:1.27` */
async function CheckSimpleApp(ctx: CheckContext): Promise<CheckResult> {
  const s = scope(ctx);
  if ('fail' in s) return s.fail;

  const dep = await findSimpleApp(kubeOf(ctx), s.num, 'deployments', 'apps');
  if (!dep) return { pass: false, hint: `No Deployment named "${simpleAppName(s.num)}" on ${WORKLOAD1} yet.` };

  const containers =
    ((dep.spec as { template?: { spec?: { containers?: Array<{ image?: string }> } } })?.template?.spec?.containers) ?? [];
  const images = containers.map((c) => c.image ?? '');
  if (!images.some((i) => i.startsWith('nginx:'))) {
    return { pass: false, hint: `The deployment runs ${images.join(', ') || 'no image'}, expected nginx:1.27.` };
  }

  const available = (dep.status as { availableReplicas?: number } | undefined)?.availableReplicas ?? 0;
  if (available < 1) return { pass: false, neutral: true, hint: 'The deployment exists but no pod is ready yet.' };

  return { pass: true, detail: `${simpleAppName(s.num)} ready in ${namespaceOf(dep)}` };
}

/** `kubectl expose deployment/... --type="NodePort" --port 80` */
async function CheckNodePort(ctx: CheckContext): Promise<CheckResult> {
  const s = scope(ctx);
  if ('fail' in s) return s.fail;

  const svc = await findSimpleApp(kubeOf(ctx), s.num, 'services');
  if (!svc) return { pass: false, hint: `No Service named "${simpleAppName(s.num)}" yet. Expose the deployment first.` };

  const spec = svc.spec as { type?: string; ports?: Array<{ port?: number; nodePort?: number }> } | undefined;
  // LoadBalancer is a superset of NodePort, so a learner who has run ahead to
  // the next lab has still done this one. Only ClusterIP means they omitted
  // --type and never opened a node port.
  if (spec?.type !== 'NodePort' && spec?.type !== 'LoadBalancer') {
    return { pass: false, hint: `The service is type ${spec?.type ?? 'unknown'}. Expose it with --type="NodePort".` };
  }
  const port = spec.ports?.[0];
  if (port?.port !== 80) return { pass: false, hint: `The service listens on port ${port?.port ?? '?'}, expected 80.` };
  if (!port.nodePort) return { pass: false, neutral: true, hint: 'No node port has been allocated yet.' };

  return { pass: true, detail: `${simpleAppName(s.num)} on nodePort ${port.nodePort}` };
}

/** `kubectl patch service ... -p '{"spec":{"type":"LoadBalancer"}}'` */
async function CheckLoadBalancer(ctx: CheckContext): Promise<CheckResult> {
  const s = scope(ctx);
  if ('fail' in s) return s.fail;

  const svc = await findSimpleApp(kubeOf(ctx), s.num, 'services');
  if (!svc) return { pass: false, hint: `No Service named "${simpleAppName(s.num)}" found.` };

  const type = (svc.spec as { type?: string } | undefined)?.type;
  if (type !== 'LoadBalancer') {
    return { pass: false, hint: `The service is still type ${type ?? 'unknown'}. Patch it to LoadBalancer.` };
  }

  const lbIngress =
    ((svc.status as { loadBalancer?: { ingress?: Array<{ ip?: string }> } } | undefined)?.loadBalancer?.ingress) ?? [];
  const ip = lbIngress[0]?.ip;
  if (!ip) return { pass: false, neutral: true, hint: 'MetalLB has not assigned an external IP yet. Watch the EXTERNAL-IP column.' };

  return { pass: true, detail: `http://${ip}` };
}

/** The Traefik Ingress for the simple app, hostname carrying the user number. */
async function CheckSimpleAppIngress(ctx: CheckContext): Promise<CheckResult> {
  const s = scope(ctx);
  if ('fail' in s) return s.fail;

  const ing = await findSimpleApp(kubeOf(ctx), s.num, 'ingresses', 'networking.k8s.io');
  if (!ing) return { pass: false, hint: `No Ingress named "${simpleAppName(s.num)}" yet.` };

  const spec = ing.spec as
    | {
        ingressClassName?: string;
        rules?: Array<{ host?: string; http?: { paths?: Array<{ backend?: { service?: { name?: string } } }> } }>;
      }
    | undefined;

  if (spec?.ingressClassName !== 'kommander-traefik') {
    return { pass: false, hint: `Ingress class is "${spec?.ingressClassName ?? 'unset'}", expected kommander-traefik.` };
  }

  const rule = spec?.rules?.[0];
  const host = rule?.host ?? '';
  if (!host.startsWith(`user${s.num}.`)) {
    return { pass: false, hint: `Host is "${host || 'unset'}". It must start with user${s.num}. so it is yours.` };
  }
  if (!host.endsWith('.sslip.io')) {
    return { pass: false, hint: `Host "${host}" does not end in .sslip.io, so it will not resolve.` };
  }

  const backend = rule?.http?.paths?.[0]?.backend?.service?.name;
  if (backend !== simpleAppName(s.num)) {
    return { pass: false, hint: `The rule points at service "${backend ?? 'nothing'}", expected ${simpleAppName(s.num)}.` };
  }

  return { pass: true, detail: `https://${host}` };
}

export const checks = {
  CheckUserNum,
  CheckProject,
  CheckBlockStorage,
  CheckFileStorage,
  CheckWordpressIngress,
  CheckGitOpsSource,
  CheckBoutiqueRunning,
  CheckDynamicProject,
  CheckSimpleApp,
  CheckNodePort,
  CheckLoadBalancer,
  CheckSimpleAppIngress,
};
