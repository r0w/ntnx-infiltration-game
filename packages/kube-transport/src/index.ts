// Read-only Kubernetes transport for the NKP pack. Mirrors @ntnx-game/nutanix:
// a mock adapter backed by the pack's fixtures.json (for mock/dev/auto-play, no
// cluster), and a live adapter that reads a real cluster over the k8s API with a
// client-cert kubeconfig. The engine only knows the KubeClient interface.
import { readFileSync } from 'node:fs';
import type { KubeClient, KubeResourceRef } from '@ntnx-game/engine';

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
// Reads the `kube` section of fixtures.json:
//   { "kube": { "apps/v1/deployments": [ {k8s object}, ... ], "v1/services": [...] } }
// Namespace filtering is applied here; per-session `{Var}` interpolation is added
// by withVariableInterpolation() (mirrors the nutanix mock).
function createMockKube(fixturesPath: string): KubeClient {
  let store: Record<string, Array<Record<string, unknown>>> = {};
  try {
    const raw = JSON.parse(readFileSync(fixturesPath, 'utf8')) as { kube?: typeof store };
    store = raw.kube ?? {};
  } catch {
    store = {};
  }
  return {
    mode: 'mock',
    async list(ref) {
      const items = store[keyOf(ref)] ?? [];
      return items.filter((it) => inNamespace(it, ref.namespace));
    },
  };
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

function createLiveKube(cfg: KubeLiveConfig): KubeClient {
  const tls = { cert: cfg.certPem, key: cfg.keyPem, ...(cfg.caPem ? { ca: cfg.caPem } : { rejectUnauthorized: false }) };
  return {
    mode: 'live',
    async list(ref) {
      const base = ref.group ? `/apis/${ref.group}/${ref.version}` : `/api/${ref.version}`;
      const path = ref.namespace ? `${base}/namespaces/${ref.namespace}/${ref.plural}` : `${base}/${ref.plural}`;
      // `tls` is a Bun-specific fetch option (client-cert mTLS), not in the DOM RequestInit type.
      const res = await fetch(cfg.server + path, { tls } as unknown as RequestInit);
      // A missing namespace or unknown resource kind means "nothing there yet",
      // not a transport failure — the player simply hasn't created it.
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`k8s GET ${path} -> ${res.status}`);
      const body = (await res.json()) as { items?: Array<Record<string, unknown>> };
      return body.items ?? [];
    },
  };
}

/**
 * Build a live client from a client-cert kubeconfig (the `nkp-admin` kubeconfig
 * copied off the boot VM). Minimal regex parse: pulls the server URL + the three
 * base64 cert blocks. Good enough for the single-cluster kubeconfig NKP emits;
 * not a general kubeconfig parser (no contexts/multi-cluster).
 */
export function createLiveKubeFromKubeconfig(kubeconfigText: string): KubeClient {
  const grab = (key: string): string | undefined => kubeconfigText.match(new RegExp(`${key}:\\s*(\\S+)`))?.[1];
  const server = grab('server');
  const caData = grab('certificate-authority-data');
  const certData = grab('client-certificate-data');
  const keyData = grab('client-key-data');
  if (!server || !certData || !keyData) {
    throw new Error('kube-transport: kubeconfig missing server or client-certificate/key data');
  }
  const dec = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');
  return createLiveKube({
    server,
    caPem: caData ? dec(caData) : undefined,
    certPem: dec(certData),
    keyPem: dec(keyData),
  });
}

export interface CreateKubeOptions {
  mode: 'mock' | 'live';
  fixtures?: string; // mock: path to the pack fixtures.json
  live?: KubeLiveConfig; // live: kubeconfig-derived cert material
}

export function createKubeClient(opts: CreateKubeOptions): KubeClient {
  if (opts.mode === 'live') {
    if (!opts.live) throw new Error('kube-transport: live mode requires live cert config');
    return createLiveKube(opts.live);
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
