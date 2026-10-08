import { describe, expect, test } from 'bun:test';
import { checks } from '../../../packs/nkp-bootcamp/checks/index';
import type { CheckContext } from '@ntnx-game/engine';

/**
 * The admin Users tab shows `detail`, never `hint`. A bootcamp check that only
 * wrote a hint left the operator with an empty chip, which is what this locks.
 */

function ctx(vars: Record<string, unknown>, list: () => Promise<unknown[]>): CheckContext {
  return {
    vars: { get: (n: string) => vars[n], set: () => {} },
    kube: { list },
  } as unknown as CheckContext;
}

describe('NKP checks talk to the operator too', () => {
  test('a failing check carries its hint as detail', async () => {
    // No PVC in the namespace: the check fails with its own sentence.
    const r = await checks.CheckBlockStorage(ctx({ UserNum: '42' }, async () => []));
    expect(r.pass).toBe(false);
    expect(r.hint).toContain('mysql-pv-claim');
    expect(r.detail).toBe(r.hint);
  });

  test('every check exported still answers', () => {
    expect(Object.keys(checks).length).toBe(12);
    for (const fn of Object.values(checks)) expect(typeof fn).toBe('function');
  });
});
