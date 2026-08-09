// Kubernetes transport for the NKP pack. Mirrors @ntnx-game/nutanix:
// a mock adapter backed by the pack's fixtures.json (for mock/dev/auto-play, no
// cluster), and a live adapter that reads real clusters over the k8s API with
// client-cert kubeconfigs. The engine only knows the KubeClient interface.
//
// An NKP fleet is several clusters, so a client is a small router: the
// management cluster plus one entry per workload cluster, keyed by NKP name.
// `ref.cluster` picks one; omitting it means the management cluster.
import { readFileSync } from 'node:fs';
import type { KubeClient, KubeResourceRef } from '@ntnx-game/engine';

/** The key a ref with no explicit `cluster` routes to. */
export const MANAGEMENT = 'management';

/** Fixture key for a resource kind: `<group>/<version>/<plural>`, group omitted for core. */
function keyOf(ref: KubeResourceRef): string {
  return `${ref.group ? ref.group + '/' : ''}${ref.version}/${ref.plural}`;
}

function inNamespace(item: Record<string, unknown>, ns?: string): boolean {
  if (!ns) return true;
  const md = item.metadata as { namespace?: string } | undefined;
  return md?.namespace === ns;
}

// ── mock ────────────────────────────────────────────────────────────────────
// Reads the `kube` section of fixtures.json, keyed by cluster then by kind:
//   { "kube": { "management": { "v1/namespaces": [ ... ] },
//               "workload01": { "apps/v1/deployments": [ ... ] } } }
// Namespace filtering is applied here; per-session `{Var}` interpolation is added
// by withVariableInterpolation() (mirrors the nutanix mock).
type MockStore = Record<string, Record<string, Array<Record<string, unknown>>>>;

function nameOf(item: Record<string, unknown>): string | undefined {
  return (item.metadata as { name?: string } | undefined)?.name;
}

function createMockKube(fixturesPath: string): KubeClient {
  let store: MockStore = {};
  try {
    const raw = JSON.parse(readFileSync(fixturesPath, 'utf8')) as { kube?: MockStore };
    store = raw.kube ?? {};
  } catch {
    store = {};
  }
  // Management first, then the workload clusters in fixture order.
  const names = [MANAGEMENT, ...Object.keys(store).filter((n) => n !== MANAGEMENT)];

  /** The bucket a ref addresses, created on demand so a write can land in a
   *  cluster or kind the fixture never mentioned. */
  const bucket = (ref: KubeResourceRef): Array<Record<string, unknown>> => {
    const cluster = ref.cluster ?? MANAGEMENT;
    const forCluster = (store[cluster] ??= {});
    return (forCluster[keyOf(ref)] ??= []);
  };
  const indexOf = (items: Array<Record<string, unknown>>, ref: KubeResourceRef) =>
    items.findIndex((it) => nameOf(it) === ref.name && inNamespace(it, ref.namespace));

  return {
    mode: 'mock',
    clusters: names,
    async list(ref) {
      const items = store[ref.cluster ?? MANAGEMENT]?.[keyOf(ref)] ?? [];
      return items.filter((it) => inNamespace(it, ref.namespace));
    },
    // The mock store is mutable so auto-play works with no cluster at all: the
    // act writes here, and the check that follows reads what it wrote. That is
    // the whole reason a mock run can exercise a stage end to end.
    async apply(ref, manifest) {
      const items = bucket(ref);
      const merged = {
        ...manifest,
        metadata: {
          ...(manifest.metadata as Record<string, unknown> | undefined),
          name: ref.name ?? nameOf(manifest),
          ...(ref.namespace ? { namespace: ref.namespace } : {}),
        },
      };
      const at = indexOf(items, ref);
      if (at >= 0) items[at] = merged;
      else items.push(merged);
    },
    async patch(ref, patch) {
      const items = bucket(ref);
      const at = indexOf(items, ref);
      if (at < 0) throw new Error(`kube mock: no ${ref.plural}/${ref.name} to patch`);
      items[at] = deepMerge(items[at]!, patch);
    },
    async remove(ref) {
      const items = bucket(ref);
      const at = indexOf(items, ref);
      if (at >= 0) items.splice(at, 1);
    },
  };
}

/** JSON merge patch semantics, enough for what the acts patch. */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out;
}

// ── live ──────────────────────────────────────────────────────────────────
// Client-cert kubeconfig against the k8s API. Bun's fetch takes a `tls` option
// with cert/key/ca (PEM). Read-only: GETs the collection and returns `.items`.
export interface KubeLiveConfig {
  server: string; // https://<vip>:6443
  caPem?: string;
  certPem: string;
  keyPem: string;
}

interface ClusterOps {
  list: (ref: KubeResourceRef) => Promise<Array<Record<string, unknown>>>;
  apply: (ref: KubeResourceRef, manifest: Record<string, unknown>) => Promise<void>;
  patch: (ref: KubeResourceRef, patch: Record<string, unknown>) => Promise<void>;
  remove: (ref: KubeResourceRef) => Promise<void>;
}

/** Field manager recorded on every object the game applies. */
const FIELD_MANAGER = 'ntnx-game';

function collectionPath(ref: KubeResourceRef): string {
  const base = ref.group ? `/apis/${ref.group}/${ref.version}` : `/api/${ref.version}`;
  return ref.namespace ? `${base}/namespaces/${ref.namespace}/${ref.plural}` : `${base}/${ref.plural}`;
}

function objectPath(ref: KubeResourceRef): string {
  if (!ref.name) throw new Error(`kube-transport: ${ref.plural} write needs ref.name`);
  return `${collectionPath(ref)}/${encodeURIComponent(ref.name)}`;
}

/** Talks to exactly one cluster. The router below composes these. */
function createSingleClusterKube(cfg: KubeLiveConfig): ClusterOps {
  const tls = { cert: cfg.certPem, key: cfg.keyPem, ...(cfg.caPem ? { ca: cfg.caPem } : { rejectUnauthorized: false }) };
  // `tls` is a Bun-specific fetch option (client-cert mTLS), not in the DOM RequestInit type.
  const call = (path: string, init: RequestInit = {}) =>
    fetch(cfg.server + path, { ...init, tls } as unknown as RequestInit);

  return {
    async list(ref) {
      const path = collectionPath(ref);
      const res = await call(path);
      // A missing namespace or unknown resource kind means "nothing there yet",
      // not a transport failure — the player simply hasn't created it.
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`k8s GET ${path} -> ${res.status}`);
      const body = (await res.json()) as { items?: Array<Record<string, unknown>> };
      return body.items ?? [];
    },
    // Server-side apply: one verb that both creates and reconciles, so an act
    // can run twice, or after the learner did half the step by hand, without
    // a conflict. `force` takes ownership of fields another manager set, which
    // is what makes a re-run converge instead of erroring.
    async apply(ref, manifest) {
      const path = `${objectPath(ref)}?fieldManager=${FIELD_MANAGER}&force=true`;
      const res = await call(path, {
        method: 'PATCH',
        headers: { 'content-type': 'application/apply-patch+yaml' },
        body: JSON.stringify(manifest),
      });
      if (!res.ok) throw new Error(`k8s APPLY ${path} -> ${res.status} ${await res.text()}`);
    },
    async patch(ref, patch) {
      const path = objectPath(ref);
      const res = await call(path, {
        method: 'PATCH',
        headers: { 'content-type': 'application/merge-patch+json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`k8s PATCH ${path} -> ${res.status} ${await res.text()}`);
    },
    async remove(ref) {
      const path = objectPath(ref);
      const res = await call(path, { method: 'DELETE' });
      // Already gone is the state cleanup wanted.
      if (res.status === 404) return;
      if (!res.ok) throw new Error(`k8s DELETE ${path} -> ${res.status}`);
    },
  };
}

/**
 * Minimal regex parse of a kubeconfig: the server URL plus the three base64
 * cert blocks. Good enough for the single-cluster kubeconfigs NKP emits (both
 * the `nkp-admin` one and the CAPI per-cluster secrets); not a general
 * kubeconfig parser (no contexts, no multi-cluster files).
 */
export function parseKubeconfig(kubeconfigText: string): KubeLiveConfig {
  const grab = (key: string): string | undefined => kubeconfigText.match(new RegExp(`${key}:\\s*(\\S+)`))?.[1];
  const server = grab('server');
  const caData = grab('certificate-authority-data');
  const certData = grab('client-certificate-data');
  const keyData = grab('client-key-data');
  if (!server || !certData || !keyData) {
    throw new Error('kube-transport: kubeconfig missing server or client-certificate/key data');
  }
  const dec = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');
  return {
    server,
    caPem: caData ? dec(caData) : undefined,
    certPem: dec(certData),
    keyPem: dec(keyData),
  };
}

/** Routes a ref to the ops for `ref.cluster`, or the management cluster. */
function createRouter(clusters: Map<string, ClusterOps>): KubeClient {
  const pick = (ref: KubeResourceRef): ClusterOps => {
    const name = ref.cluster ?? MANAGEMENT;
    const ops = clusters.get(name);
    // Naming a cluster the deployment does not have is a setup problem, not
    // a player mistake — say which ones exist rather than returning a silent
    // empty list that would read as "you haven't created it yet".
    if (!ops) {
      throw new Error(`kube-transport: no cluster named "${name}" (have: ${[...clusters.keys()].join(', ')})`);
    }
    return ops;
  };
  return {
    mode: 'live',
    clusters: [...clusters.keys()],
    list: (ref) => pick(ref).list(ref),
    apply: (ref, manifest) => pick(ref).apply(ref, manifest),
    patch: (ref, patch) => pick(ref).patch(ref, patch),
    remove: (ref) => pick(ref).remove(ref),
  };
}

/**
 * Build a live client for the whole fleet from the management kubeconfig alone.
 *
 * NKP keeps a kubeconfig for every cluster it manages in a CAPI secret named
 * `<cluster>-kubeconfig`, so the one credential the operator already has
 * unlocks the workload clusters too. That is why deployment only asks for a
 * single kubeconfig.
 *
 * Discovery is best-effort: if the secrets cannot be read, the management
 * cluster still works and workload checks fail with a clear message.
 */
export async function createLiveKubeFleet(managementKubeconfigText: string): Promise<KubeClient> {
  const mgmt = createSingleClusterKube(parseKubeconfig(managementKubeconfigText));
  const readers = new Map<string, ClusterOps>([[MANAGEMENT, mgmt]]);

  let secrets: Array<Record<string, unknown>> = [];
  try {
    secrets = await mgmt.list({ version: 'v1', plural: 'secrets' });
  } catch {
    return createRouter(readers);
  }

  for (const secret of secrets) {
    const name = (secret.metadata as { name?: string } | undefined)?.name ?? '';
    if (!name.endsWith('-kubeconfig')) continue;
    const encoded = (secret.data as { value?: string } | undefined)?.value;
    if (!encoded) continue;
    try {
      const cfg = parseKubeconfig(Buffer.from(encoded, 'base64').toString('utf8'));
      readers.set(name.slice(0, -'-kubeconfig'.length), createSingleClusterKube(cfg));
    } catch {
      // A token-based or malformed kubeconfig is skipped; the rest still load.
    }
  }
  return createRouter(readers);
}

/** Single-cluster live client. Kept for tests and for a management-only setup. */
export function createLiveKubeFromKubeconfig(kubeconfigText: string): KubeClient {
  return createRouter(new Map<string, ClusterOps>([[MANAGEMENT, createSingleClusterKube(parseKubeconfig(kubeconfigText))]]));
}

export interface CreateKubeOptions {
  mode: 'mock' | 'live';
  fixtures?: string; // mock: path to the pack fixtures.json
  live?: KubeLiveConfig; // live: kubeconfig-derived cert material
}

export function createKubeClient(opts: CreateKubeOptions): KubeClient {
  if (opts.mode === 'live') {
    if (!opts.live) throw new Error('kube-transport: live mode requires live cert config');
    return createRouter(new Map<string, ClusterOps>([[MANAGEMENT, createSingleClusterKube(opts.live)]]));
  }
  return createMockKube(opts.fixtures ?? '');
}

/**
 * Wrap a (mock) client so fixture strings get `{Var}` tokens replaced from a
 * per-check session snapshot — mirrors the nutanix mock's interpolation, so a
 * fixture named `user{UserNum}-nkp-simple-app` matches whatever the player set.
 * Live clients hit a real cluster, so this is a passthrough for them.
 */
export function withVariableInterpolation(client: KubeClient, getVars: () => Record<string, unknown>): KubeClient {
  if (client.mode !== 'mock') return client;
  return {
    mode: client.mode,
    clusters: client.clusters,
    // Writes pass straight through: an act already has the session's variables
    // and writes concrete names, so there is nothing left to interpolate.
    apply: client.apply?.bind(client),
    patch: client.patch?.bind(client),
    remove: client.remove?.bind(client),
    async list(ref) {
      // Fetch unfiltered — the fixture's namespace may be a `{UserNum}` token
      // that only resolves after interpolation, so filter afterwards.
      const items = await client.list({ ...ref, namespace: undefined });
      const vars = getVars();
      const json = JSON.stringify(items).replace(/\{(\w+)\}/g, (m, name) => {
        const v = vars[name];
        return v === undefined || v === null ? m : String(v);
      });
      const hydrated = JSON.parse(json) as Array<Record<string, unknown>>;
      return ref.namespace ? hydrated.filter((it) => inNamespace(it, ref.namespace)) : hydrated;
    },
  };
}

export type { KubeClient, KubeResourceRef };
