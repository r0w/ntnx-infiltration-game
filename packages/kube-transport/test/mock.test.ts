import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createKubeClient, parseKubeconfig, withVariableInterpolation, MANAGEMENT } from '../src/index';

const FIXTURES = resolve(import.meta.dir, '../../../packs/nkp-bootcamp/fixtures.json');
const PVCS = { version: 'v1', plural: 'persistentvolumeclaims', cluster: 'workload01' } as const;
const PROJECTS = {
  group: 'workspaces.kommander.mesosphere.io',
  version: 'v1alpha1',
  plural: 'projects',
} as const;

describe('mock kube transport', () => {
  test('lists resources from the fixtures kube section', async () => {
    const kube = createKubeClient({ mode: 'mock', fixtures: FIXTURES });
    const items = await kube.list(PVCS);
    expect(items.map((i) => (i.metadata as { name: string }).name).sort()).toEqual([
      'mysql-pv-claim',
      'wp-pv-claim',
    ]);
  });

  test('interpolation replaces {Var} tokens and then filters by namespace', async () => {
    const base = createKubeClient({ mode: 'mock', fixtures: FIXTURES });
    const kube = withVariableInterpolation(base, () => ({ UserNum: '7' }));

    const mine = await kube.list({ ...PVCS, namespace: 'user7' });
    expect(mine).toHaveLength(2);
    expect((mine[0].metadata as { namespace: string }).namespace).toBe('user7');

    // A different learner's namespace sees nothing (per-namespace isolation).
    const other = await kube.list({ ...PVCS, namespace: 'user8' });
    expect(other).toHaveLength(0);
  });

  test('unknown resource kind returns empty, not an error', async () => {
    const kube = createKubeClient({ mode: 'mock', fixtures: FIXTURES });
    expect(await kube.list({ version: 'v1', plural: 'configmaps', cluster: 'workload01' })).toEqual([]);
  });

  // The fleet routing is the reason these fixtures are nested by cluster: a
  // Project is a management object, the namespace it federates is a workload
  // one, and a check that reads the wrong cluster must come back empty rather
  // than silently matching something with the same name elsewhere.
  test('a ref with no cluster reads the management cluster', async () => {
    const kube = createKubeClient({ mode: 'mock', fixtures: FIXTURES });
    const projects = await kube.list(PROJECTS);
    expect(projects).toHaveLength(1);
    expect(await kube.list({ ...PROJECTS, cluster: 'workload01' })).toEqual([]);
  });

  test('each cluster has its own view of the same resource kind', async () => {
    const kube = createKubeClient({ mode: 'mock', fixtures: FIXTURES });
    const deps = { group: 'apps', version: 'v1', plural: 'deployments' } as const;
    const one = await kube.list({ ...deps, cluster: 'workload01' });
    const two = await kube.list({ ...deps, cluster: 'workload02' });
    // workload01 also carries WordPress and the simple app; workload02 only
    // gets what GitOps federated to it.
    expect(one.length).toBeGreaterThan(two.length);
    expect(two.length).toBeGreaterThan(0);
    expect(await kube.list({ ...deps, cluster: 'workload03' })).toEqual([]);
  });

  test('the client reports its clusters, management first', () => {
    const kube = createKubeClient({ mode: 'mock', fixtures: FIXTURES });
    expect(kube.clusters[0]).toBe(MANAGEMENT);
    expect(kube.clusters).toContain('workload01');
    expect(kube.clusters).toContain('workload02');
  });
});

describe('kubeconfig parsing', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const kubeconfig = `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${b64('CA-PEM')}
    server: https://10.0.0.1:6443
  name: nkp
users:
- name: nkp-admin
  user:
    client-certificate-data: ${b64('CERT-PEM')}
    client-key-data: ${b64('KEY-PEM')}
`;

  test('pulls the server and decodes the three cert blocks', () => {
    const cfg = parseKubeconfig(kubeconfig);
    expect(cfg.server).toBe('https://10.0.0.1:6443');
    expect(cfg.caPem).toBe('CA-PEM');
    expect(cfg.certPem).toBe('CERT-PEM');
    expect(cfg.keyPem).toBe('KEY-PEM');
  });

  // A token-based kubeconfig has no client cert. Failing loudly here is what
  // lets the fleet builder skip that cluster instead of producing a client
  // that 401s on every check.
  test('rejects a kubeconfig with no client certificate', () => {
    expect(() => parseKubeconfig('apiVersion: v1\nclusters: []\n')).toThrow(/client-certificate/);
  });
});
