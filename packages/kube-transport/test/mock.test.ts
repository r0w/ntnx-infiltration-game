import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createKubeClient, withVariableInterpolation } from '../src/index';

const FIXTURES = resolve(import.meta.dir, '../../../packs/nkp-bootcamp/fixtures.json');
const PVCS = { version: 'v1', plural: 'persistentvolumeclaims' } as const;

describe('mock kube transport', () => {
  test('lists resources from the fixtures kube section', async () => {
    const kube = createKubeClient({ mode: 'mock', fixtures: FIXTURES });
    const items = await kube.list(PVCS);
    expect(items).toHaveLength(1);
    expect((items[0].metadata as { name: string }).name).toBe('mysql-pv-claim');
  });

  test('interpolation replaces {Var} tokens and then filters by namespace', async () => {
    const base = createKubeClient({ mode: 'mock', fixtures: FIXTURES });
    const kube = withVariableInterpolation(base, () => ({ UserNum: '7' }));

    const mine = await kube.list({ ...PVCS, namespace: 'user7' });
    expect(mine).toHaveLength(1);
    expect((mine[0].metadata as { namespace: string }).namespace).toBe('user7');

    // A different learner's namespace sees nothing (per-namespace isolation).
    const other = await kube.list({ ...PVCS, namespace: 'user8' });
    expect(other).toHaveLength(0);
  });

  test('unknown resource kind returns empty, not an error', async () => {
    const kube = createKubeClient({ mode: 'mock', fixtures: FIXTURES });
    const items = await kube.list({ version: 'v1', plural: 'services' });
    expect(items).toEqual([]);
  });
});
