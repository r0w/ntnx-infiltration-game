import { describe, expect, spyOn, test } from 'bun:test';
import { VariableStore, type CheckContext } from '@ntnx-game/engine';
import { checks } from '../../../packs/ntnx-infiltration/checks';
import { autoFill } from '../../../packs/ntnx-infiltration/acts/auto-fill';

function context(mode: 'mock' | 'live', value: string | number): CheckContext {
  const vars = new VariableStore();
  for (const [name, val] of Object.entries({
    Runway: value, OldPC: 'legacy.invalid', OldPCUsername: 'planner', OldPCPassword: 'unused',
  })) vars.set(name, val, 1);
  return {
    vars,
    nutanix: { mode, async request() { throw new Error('Unexpected cluster request'); } },
    cache: { get: () => undefined, set: () => {}, all: () => [] },
    args: {},
    session: { id: 'runway', trigram: 'runway', locale: 'en', clusterProfile: 'other' },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

describe('Planner Runway', () => {
  test('accepts different day counts without contacting Planner, including with live transport', async () => {
    // Both test and live server modes use the live transport.
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unexpected external request');
    });
    try {
      for (const mode of ['mock', 'live'] as const) {
        for (const value of ['0', '42', '365', '999', 120]) {
          expect((await checks.CheckRunway(context(mode, value))).pass).toBe(true);
        }
      }
      expect(await autoFill.Runway()).toBe('120');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('keeps format validation for invalid answers', async () => {
    for (const value of ['', 'abc', '-1', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await checks.CheckRunway(context('live', value))).toMatchObject({
        pass: false, retryFromVariable: 'Runway',
      });
    }
  });
});
