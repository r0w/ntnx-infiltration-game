import { describe, expect, test } from 'bun:test';
import { resolveClusterProfile } from '../src/cluster-profile';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('resolveClusterProfile', () => {
  test('explicit hpoc/other wins', () => {
    expect(resolveClusterProfile({ explicit: 'hpoc', logger: silent })).toBe('hpoc');
    expect(resolveClusterProfile({ explicit: 'other', logger: silent })).toBe('other');
  });

  test('defaults to other (fail-safe) when explicit is undefined', () => {
    expect(resolveClusterProfile({ explicit: undefined, logger: silent })).toBe('other');
  });
});
