import type { ActContext, KubeClient, KubeResourceRef } from '@ntnx-game/engine';

/**
 * Acts: the cluster-side step a learner would have performed by hand, done for
 * them so auto-play can walk the whole bootcamp on a real fleet.
 *
 * Every act writes exactly what its check reads, and nothing else. They are
 * idempotent by construction — server-side apply reconciles rather than
 * conflicts — so a re-run, or a run over a stage the learner half-did, lands
 * in the same place.
 *
 * A note on waiting. Several checks assert cluster-filled status (`Bound`,
 * `availableReplicas`, an assigned `EXTERNAL-IP`) that arrives seconds after
 * the spec does. The acts poll briefly for those so one auto-play pass usually
 * suffices; when the wait runs out they return anyway, because the matching
 * check fails *neutral* on "not yet" and auto-play simply asks again.
 */

const WORKSPACE_NS = 'kommander-default-workspace';
const WORKLOAD1 = 'workload01';
const WORKLOAD2 = 'workload02';
/**
 * Where the optional terminal labs land: `default` on the *management* cluster.
 * The web IDE's kubeconfig is the management one (the lab's own `kubectl get
 * ingresses -A` output lists `kommander/dex` and friends), and the Ingress host
 * it has the learner write is the management Traefik address — so the app must
 * live on the cluster that answers there, or the URL 404s.
 */
const SIMPLE_APP_NS = 'default';

type Obj = Record<string, unknown>;

function kubeOf(ctx: ActContext): KubeClient {
  const kube = ctx.kube;
  if (!kube?.apply || !kube.patch || !kube.remove) {
    throw new Error('nkp acts need a write-capable Kubernetes transport');
  }
  return kube;
}

/** `01` — the same normalisation CheckUserNum captures. */
function userNum(ctx: ActContext): string {
  const raw = String(ctx.vars.get('UserNum') ?? '').trim().toLowerCase().replace(/^user/, '');
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    throw new Error(`nkp acts: no usable UserNum (got "${raw}")`);
  }
  return String(n).padStart(2, '0');
}

function nameOf(item: Obj): string {
  return (item.metadata as { name?: string } | undefined)?.name ?? '';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `ready` says so. Returns whether it did, and never throws on
 * timeout: the stage's own check owns the verdict, and it words "not yet"
 * far better than an act's exception would.
 */
async function waitFor(
  kube: KubeClient,
  ref: KubeResourceRef,
  ready: (items: Obj[]) => boolean,
  { tries = 30, everyMs = 2000 }: { tries?: number; everyMs?: number } = {},
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (ready(await kube.list(ref))) return true;
    await sleep(everyMs);
  }
  return false;
}

/**
 * The address Traefik answers on for a cluster, read the way the bootcamp
 * teaches: every platform Ingress shares one. Falls back to the ingress
 * controller's own LoadBalancer service.
 */
async function ingressIp(kube: KubeClient, cluster?: string): Promise<string> {
  const ingresses = await kube.list({ group: 'networking.k8s.io', version: 'v1', plural: 'ingresses', cluster });
  for (const ing of ingresses) {
    const lb = (ing.status as { loadBalancer?: { ingress?: Array<{ ip?: string }> } } | undefined)?.loadBalancer?.ingress;
    if (lb?.[0]?.ip) return lb[0].ip;
  }
  const services = await kube.list({ version: 'v1', plural: 'services', cluster });
  for (const svc of services) {
    if (!nameOf(svc).includes('traefik')) continue;
    const lb = (svc.status as { loadBalancer?: { ingress?: Array<{ ip?: string }> } } | undefined)?.loadBalancer?.ingress;
    if (lb?.[0]?.ip) return lb[0].ip;
  }
  throw new Error(`nkp acts: could not find the ingress IP for ${cluster ?? 'management'}`);
}

// ── multi-tenancy ───────────────────────────────────────────────────────────

/**
 * The NKP Project, which is a management-cluster object. Creating the
 * namespace on the workload cluster directly would pass a namespace check and
 * fail the project one — federation is the thing being taught.
 */
async function actCreateProject(ctx: ActContext): Promise<void> {
  const kube = kubeOf(ctx);
  const ns = `user${userNum(ctx)}`;
  const at = {
    group: 'workspaces.kommander.mesosphere.io', version: 'v1alpha1', plural: 'projects', namespace: WORKSPACE_NS, name: ns,
  } as const satisfies KubeResourceRef;

  // A replay must not walk the run backwards. If the dynamic-assignment lab
  // has already switched this project to a label selector, forcing the manual
  // list back un-federates workload02, and its namespace spends the next
  // minutes terminating while every later act tries to write into it.
  const existing = (await kube.list({ ...at, name: undefined })).find((p) => nameOf(p) === ns);
  const selector = (existing?.spec as { placement?: { clusterSelector?: unknown } } | undefined)
    ?.placement?.clusterSelector;
  const placement = selector ? { clusterSelector: selector } : { clusters: [{ name: WORKLOAD1 }] };

  await kube.apply!(at, {
    apiVersion: 'workspaces.kommander.mesosphere.io/v1alpha1',
    kind: 'Project',
    metadata: { name: ns, namespace: WORKSPACE_NS },
    // `workspaceRef` names the Workspace CR (`default-workspace`), not the
    // namespace it lives in — read off a project the console itself made.
    spec: { namespaceName: ns, placement, workspaceRef: { name: 'default-workspace' } },
  });
  // The namespace has to reach workload01 before any later act can write into it.
  await waitFor(
    kube,
    { version: 'v1', plural: 'namespaces', cluster: WORKLOAD1 },
    (items) => items.some((i) => nameOf(i) === ns),
  );
}

// ── persistent storage ──────────────────────────────────────────────────────

/** The MySQL half of the WordPress stack, on the default block StorageClass. */
async function actBlockStorage(ctx: ActContext): Promise<void> {
  const kube = kubeOf(ctx);
  const ns = `user${userNum(ctx)}`;
  const at = (plural: string, name: string, group?: string): KubeResourceRef => ({
    group, version: 'v1', plural, namespace: ns, cluster: WORKLOAD1, name,
  });

  await kube.apply!(at('secrets', 'mysql-pass'), {
    apiVersion: 'v1', kind: 'Secret', metadata: { name: 'mysql-pass', namespace: ns },
    type: 'Opaque', stringData: { password: 'nutanix/4u' },
  });
  await kube.apply!(at('services', 'wordpress-mysql'), {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: 'wordpress-mysql', namespace: ns, labels: { app: 'wordpress' } },
    spec: { ports: [{ port: 3306 }], selector: { app: 'wordpress', tier: 'mysql' }, clusterIP: 'None' },
  });
  await kube.apply!(at('persistentvolumeclaims', 'mysql-pv-claim'), {
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { name: 'mysql-pv-claim', namespace: ns, labels: { app: 'wordpress' } },
    // No storageClassName on purpose: the lab's point is that the default
    // class catches a claim that names none.
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '20Gi' } } },
  });
  await kube.apply!(at('deployments', 'wordpress-mysql', 'apps'), {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'wordpress-mysql', namespace: ns, labels: { app: 'wordpress' } },
    spec: {
      selector: { matchLabels: { app: 'wordpress', tier: 'mysql' } },
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels: { app: 'wordpress', tier: 'mysql' } },
        spec: {
          containers: [{
            image: 'mysql:8.0', name: 'mysql',
            env: [
              { name: 'MYSQL_ROOT_PASSWORD', valueFrom: { secretKeyRef: { name: 'mysql-pass', key: 'password' } } },
              { name: 'MYSQL_DATABASE', value: 'wordpress' },
              { name: 'MYSQL_USER', value: 'wordpress' },
              { name: 'MYSQL_PASSWORD', valueFrom: { secretKeyRef: { name: 'mysql-pass', key: 'password' } } },
            ],
            ports: [{ containerPort: 3306, name: 'mysql' }],
            volumeMounts: [{ name: 'mysql-persistent-storage', mountPath: '/var/lib/mysql' }],
          }],
          volumes: [{ name: 'mysql-persistent-storage', persistentVolumeClaim: { claimName: 'mysql-pv-claim' } }],
        },
      },
    },
  });

  await waitFor(
    kube,
    { version: 'v1', plural: 'persistentvolumeclaims', namespace: ns, cluster: WORKLOAD1 },
    (items) => items.some((i) => nameOf(i) === 'mysql-pv-claim' && (i.status as { phase?: string } | undefined)?.phase === 'Bound'),
  );
}

/** The WordPress frontend: two replicas sharing one ReadWriteMany volume. */
async function actFileStorage(ctx: ActContext): Promise<void> {
  const kube = kubeOf(ctx);
  const ns = `user${userNum(ctx)}`;
  const at = (plural: string, name: string, group?: string): KubeResourceRef => ({
    group, version: 'v1', plural, namespace: ns, cluster: WORKLOAD1, name,
  });

  await kube.apply!(at('services', 'wordpress'), {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: 'wordpress', namespace: ns, labels: { app: 'wordpress' } },
    spec: { ports: [{ port: 80 }], selector: { app: 'wordpress', tier: 'frontend' }, clusterIP: 'None' },
  });
  await kube.apply!(at('persistentvolumeclaims', 'wp-pv-claim'), {
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { name: 'wp-pv-claim', namespace: ns, labels: { app: 'wordpress' } },
    spec: { storageClassName: 'nutanix-files', accessModes: ['ReadWriteMany'], resources: { requests: { storage: '20Gi' } } },
  });
  await kube.apply!(at('deployments', 'wordpress', 'apps'), {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'wordpress', namespace: ns, labels: { app: 'wordpress' } },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: 'wordpress', tier: 'frontend' } },
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels: { app: 'wordpress', tier: 'frontend' } },
        spec: {
          containers: [{
            image: 'wordpress:apache', name: 'wordpress',
            env: [
              { name: 'WORDPRESS_DB_HOST', value: 'wordpress-mysql' },
              { name: 'WORDPRESS_DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'mysql-pass', key: 'password' } } },
              { name: 'WORDPRESS_DB_USER', value: 'wordpress' },
            ],
            ports: [{ containerPort: 80, name: 'wordpress' }],
            volumeMounts: [{ name: 'wordpress-persistent-storage', mountPath: '/var/www/html' }],
          }],
          volumes: [{ name: 'wordpress-persistent-storage', persistentVolumeClaim: { claimName: 'wp-pv-claim' } }],
        },
      },
    },
  });

  await waitFor(
    kube,
    { version: 'v1', plural: 'persistentvolumeclaims', namespace: ns, cluster: WORKLOAD1 },
    (items) => items.some((i) => nameOf(i) === 'wp-pv-claim' && (i.status as { phase?: string } | undefined)?.phase === 'Bound'),
  );
}

/** The WordPress Ingress, hostname carrying the learner's own number. */
async function actWordpressIngress(ctx: ActContext): Promise<void> {
  const kube = kubeOf(ctx);
  const num = userNum(ctx);
  const ns = `user${num}`;
  const ip = await ingressIp(kube, WORKLOAD1);
  await kube.apply!(
    { group: 'networking.k8s.io', version: 'v1', plural: 'ingresses', namespace: ns, cluster: WORKLOAD1, name: 'wordpress' },
    {
      apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
      metadata: { name: 'wordpress', namespace: ns },
      spec: {
        ingressClassName: 'kommander-traefik',
        rules: [{
          host: `wordpress${num}.${ip}.sslip.io`,
          http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'wordpress', port: { number: 80 } } } }] },
        }],
      },
    },
  );
}

// ── GitOps ──────────────────────────────────────────────────────────────────

/**
 * The GitOps source and the deployment it drives.
 *
 * The console's Continuous Deployment tab does not create these objects on the
 * clusters directly: it writes the project's CD config into Kommander's own
 * management git repository, which the per-cluster `apps-<project>`
 * Kustomization then renders. That repo is not reachable over the API, and
 * KubeFed federates only core types (no GitRepository, no Kustomization), so
 * an act cannot walk the console's path. It writes the same Flux objects
 * itself instead, on every cluster the app must reach, which leaves the
 * cluster in the state the lab describes and the checks assert.
 *
 * `serviceAccountName` is the namespace name on purpose. Kommander creates one
 * SA per project namespace under that name, and its Gatekeeper policy
 * (`kustomization-must-have-sa`) defaults to it — an invented account is
 * rejected, or lacks the rights to create the boutique's own accounts.
 */
async function deployBoutiqueOn(kube: KubeClient, ns: string, cluster: string | undefined): Promise<void> {
  await kube.apply!(
    { group: 'source.toolkit.fluxcd.io', version: 'v1', plural: 'gitrepositories', namespace: ns, cluster, name: 'online-boutique' },
    {
      apiVersion: 'source.toolkit.fluxcd.io/v1', kind: 'GitRepository',
      metadata: { name: 'online-boutique', namespace: ns },
      spec: { interval: '1m', url: 'https://github.com/nutanixdev/nkp-microservices-demo.git', ref: { branch: 'main' } },
    },
  );
  // Only where the app actually runs: on the management cluster the source is
  // the record the console shows, not something to deploy from.
  if (!cluster) return;
  await kube.apply!(
    { group: 'kustomize.toolkit.fluxcd.io', version: 'v1', plural: 'kustomizations', namespace: ns, cluster, name: 'online-boutique' },
    {
      apiVersion: 'kustomize.toolkit.fluxcd.io/v1', kind: 'Kustomization',
      metadata: { name: 'online-boutique', namespace: ns },
      spec: {
        interval: '1m',
        path: './release/without-istio',
        prune: true,
        targetNamespace: ns,
        serviceAccountName: ns,
        sourceRef: { kind: 'GitRepository', name: 'online-boutique' },
      },
    },
  );
}

/**
 * Adds the GitOps source, and starts the deployment it drives.
 */
async function actGitOpsSource(ctx: ActContext): Promise<void> {
  const kube = kubeOf(ctx);
  const ns = `user${userNum(ctx)}`;
  await deployBoutiqueOn(kube, ns, undefined);
  await deployBoutiqueOn(kube, ns, WORKLOAD1);
  await waitFor(
    kube,
    { group: 'source.toolkit.fluxcd.io', version: 'v1', plural: 'gitrepositories', namespace: ns },
    (items) => {
      const repo = items.find((i) => nameOf(i) === 'online-boutique');
      const conditions = (repo?.status as { conditions?: Array<{ type?: string; status?: string }> } | undefined)?.conditions ?? [];
      return conditions.some((c) => c.type === 'Ready' && c.status === 'True');
    },
  );
}

/** Nothing to create: Flux deploys the boutique. This only waits for it. */
async function actBoutiqueRunning(ctx: ActContext): Promise<void> {
  const kube = kubeOf(ctx);
  const ns = `user${userNum(ctx)}`;
  await waitFor(
    kube,
    { group: 'apps', version: 'v1', plural: 'deployments', namespace: ns, cluster: WORKLOAD1 },
    (items) => {
      const flux = items.filter(
        (d) => 'kustomize.toolkit.fluxcd.io/name' in (((d.metadata as { labels?: Record<string, string> })?.labels) ?? {}),
      );
      const up = flux.filter((d) => ((d.status as { availableReplicas?: number } | undefined)?.availableReplicas ?? 0) > 0);
      return up.length >= 12;
    },
    // Bun caps a request at 255 s, and the bulk `/api/act/auto-play` endpoint
    // chains every act into one. No single wait may approach that: the check
    // that follows fails *neutral* on "still starting", so auto-play simply
    // asks again rather than the whole run dying on a timeout.
    { tries: 40, everyMs: 4000 },
  );
}

/** Swap the project from a hand-picked cluster list to a label selector. */
async function actDynamicProject(ctx: ActContext): Promise<void> {
  const kube = kubeOf(ctx);
  const ns = `user${userNum(ctx)}`;
  await kube.patch!(
    { group: 'workspaces.kommander.mesosphere.io', version: 'v1alpha1', plural: 'projects', namespace: WORKSPACE_NS, name: ns },
    // null drops the explicit list — merge-patch semantics, and exactly what
    // switching the UI from Manual to Dynamic does.
    { spec: { placement: { clusters: null, clusterSelector: { matchLabels: { infraId: 'pc' } } } } },
  );
  const joined = await waitFor(
    kube,
    { version: 'v1', plural: 'namespaces', cluster: WORKLOAD2 },
    (items) => items.some((i) => nameOf(i) === ns),
    { tries: 25, everyMs: 3000 },
  );
  // The namespace federates on its own; the Flux objects do not (see
  // deployBoutiqueOn), so the new cluster gets them here.
  if (joined) await deployBoutiqueOn(kube, ns, WORKLOAD2);
}

// ── optional labs: the simple NGINX app ─────────────────────────────────────

function simpleAppName(num: string): string {
  return `user${num}-nkp-simple-app`;
}

/** `kubectl create deployment user##-nkp-simple-app --image=nginx:1.27` */
async function actSimpleApp(ctx: ActContext): Promise<void> {
  const kube = kubeOf(ctx);
  const app = simpleAppName(userNum(ctx));
  await kube.apply!(
    { group: 'apps', version: 'v1', plural: 'deployments', namespace: SIMPLE_APP_NS, name: app },
    {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: app, namespace: SIMPLE_APP_NS, labels: { app } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app } },
        template: { metadata: { labels: { app } }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.27' }] } },
      },
    },
  );
  await waitFor(
    kube,
    { group: 'apps', version: 'v1', plural: 'deployments', namespace: SIMPLE_APP_NS },
    (items) => {
      const d = items.find((i) => nameOf(i) === app);
      return ((d?.status as { availableReplicas?: number } | undefined)?.availableReplicas ?? 0) >= 1;
    },
  );
}

/** `kubectl expose deployment/... --type="NodePort" --port 80` */
async function actNodePort(ctx: ActContext): Promise<void> {
  const kube = kubeOf(ctx);
  const app = simpleAppName(userNum(ctx));
  await kube.apply!(
    { version: 'v1', plural: 'services', namespace: SIMPLE_APP_NS, name: app },
    {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: app, namespace: SIMPLE_APP_NS, labels: { app } },
      spec: { type: 'NodePort', ports: [{ port: 80, targetPort: 80, protocol: 'TCP' }], selector: { app } },
    },
  );
}

/** `kubectl patch service ... -p '{"spec":{"type":"LoadBalancer"}}'` */
async function actLoadBalancer(ctx: ActContext): Promise<void> {
  const kube = kubeOf(ctx);
  const app = simpleAppName(userNum(ctx));
  await kube.patch!(
    { version: 'v1', plural: 'services', namespace: SIMPLE_APP_NS, name: app },
    { spec: { type: 'LoadBalancer' } },
  );
  await waitFor(
    kube,
    { version: 'v1', plural: 'services', namespace: SIMPLE_APP_NS },
    (items) => {
      const svc = items.find((i) => nameOf(i) === app);
      const lb = (svc?.status as { loadBalancer?: { ingress?: Array<{ ip?: string }> } } | undefined)?.loadBalancer?.ingress;
      return !!lb?.[0]?.ip;
    },
  );
}

/** The Traefik Ingress for the simple app, on the management ingress address. */
async function actSimpleAppIngress(ctx: ActContext): Promise<void> {
  const kube = kubeOf(ctx);
  const num = userNum(ctx);
  const app = simpleAppName(num);
  const ip = await ingressIp(kube);
  await kube.apply!(
    { group: 'networking.k8s.io', version: 'v1', plural: 'ingresses', namespace: SIMPLE_APP_NS, name: app },
    {
      apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
      metadata: { name: app, namespace: SIMPLE_APP_NS },
      spec: {
        ingressClassName: 'kommander-traefik',
        rules: [{
          host: `user${num}.${ip}.sslip.io`,
          http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: app, port: { number: 80 } } } }] },
        }],
      },
    },
  );
}

export const acts = {
  'create-project': actCreateProject,
  'block-storage': actBlockStorage,
  'file-storage': actFileStorage,
  'wordpress-ingress': actWordpressIngress,
  'gitops-source': actGitOpsSource,
  'gitops-app': actBoutiqueRunning,
  'dynamic-gitops': actDynamicProject,
  'deploy-app': actSimpleApp,
  'expose-service': actNodePort,
  loadbalancer: actLoadBalancer,
  ingress: actSimpleAppIngress,
};

// ── cleanups ────────────────────────────────────────────────────────────────
// Deleting the Project takes the federated namespace, and everything the labs
// put in it, with it. The simple-app objects live in `default` on workload01,
// outside the project, so they are removed one by one.

async function cleanupProject(ctx: ActContext): Promise<void> {
  const kube = kubeOf(ctx);
  const ns = `user${userNum(ctx)}`;
  await kube.remove!({
    group: 'workspaces.kommander.mesosphere.io', version: 'v1alpha1', plural: 'projects', namespace: WORKSPACE_NS, name: ns,
  });
}

async function cleanupSimpleApp(ctx: ActContext): Promise<void> {
  const kube = kubeOf(ctx);
  const app = simpleAppName(userNum(ctx));
  const at = (plural: string, group?: string): KubeResourceRef => ({
    group, version: 'v1', plural, namespace: SIMPLE_APP_NS, name: app,
  });
  await kube.remove!(at('ingresses', 'networking.k8s.io'));
  await kube.remove!(at('services'));
  await kube.remove!(at('deployments', 'apps'));
}

export const cleanups = {
  'create-project': cleanupProject,
  'deploy-app': cleanupSimpleApp,
};
