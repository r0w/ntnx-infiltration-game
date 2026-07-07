import { describe, expect, test } from 'bun:test';
import type { StageDefinition } from '@ntnx-game/engine';
import { analyzeDeps, cascadeDisable } from '../src/dep-analysis';

const stage = (
  overrides: Partial<StageDefinition> & { index: number; name?: string },
): StageDefinition => ({
  index: overrides.index,
  id: overrides.name ?? `s${overrides.index}`,
  name: overrides.name ?? `s${overrides.index}`,
  active: true,
  messages: [],
  ...overrides,
});

describe('analyzeDeps', () => {
  test('reports no broken stages when every need is satisfied', () => {
    const stages = [
      stage({ index: 1, captures: ['ProjectUUID'] }),
      stage({ index: 2, needs: ['ProjectUUID'], captures: ['VMUUID'] }),
      stage({ index: 3, needs: ['VMUUID'] }),
    ];
    const r = analyzeDeps({ stages });
    expect(r.broken).toEqual([]);
    expect(r.off.size).toBe(0);
  });

  test('flags downstream when an upstream producer is disabled via stage.active=false', () => {
    const stages = [
      stage({ index: 1, active: false, captures: ['ProjectUUID'] }),
      stage({ index: 2, needs: ['ProjectUUID'] }),
    ];
    const r = analyzeDeps({ stages });
    expect(r.broken.map((b) => b.stageName)).toEqual(['s2']);
    expect(r.broken[0].missingVars).toEqual(['ProjectUUID']);
  });

  test('flags downstream when an upstream producer is in disabledNames (preview)', () => {
    const stages = [
      stage({ index: 1, captures: ['ProjectUUID'] }),
      stage({ index: 2, needs: ['ProjectUUID'] }),
    ];
    const r = analyzeDeps({ stages, disabledNames: new Set(['s1']) });
    expect(r.broken.map((b) => b.stageName)).toEqual(['s2']);
  });

  test('treats env-seeded variables (PC, Vlanid, etc.) as always-available', () => {
    const stages = [stage({ index: 1, needs: ['PC', 'Vlanid'] })];
    const r = analyzeDeps({ stages });
    expect(r.broken).toEqual([]);
  });

  test('an off stage is not itself flagged as broken (only live stages count)', () => {
    const stages = [
      stage({ index: 1, captures: ['UserUUID'] }),
      stage({ index: 2, active: false, needs: ['UserUUID', 'OtherUUID'] }),
    ];
    const r = analyzeDeps({ stages });
    expect(r.broken).toEqual([]); // stage 2 is off → ignored
  });

  test('unreachableNames (e.g. capability-disabled) propagate the same way as disabledNames', () => {
    const stages = [
      stage({ index: 1, requires: ['NCM'], captures: ['NumberUpdates'] }),
      stage({ index: 2, needs: ['NumberUpdates'] }),
    ];
    const r = analyzeDeps({ stages, unreachableNames: new Set(['s1']) });
    expect(r.broken.map((b) => b.stageName)).toEqual(['s2']);
  });
});

describe('cascadeDisable', () => {
  test('returns just the requested set when no downstream is affected', () => {
    const stages = [
      stage({ index: 1, captures: ['A'] }),
      stage({ index: 2, captures: ['B'] }),
      stage({ index: 3, needs: ['A'] }),
    ];
    const r = cascadeDisable(stages, new Set(['s2']));
    expect([...r.disabled].sort()).toEqual(['s2']);
  });

  test('iterates to a fixed point: A→B→C disables propagate through every link', () => {
    const stages = [
      stage({ index: 1, captures: ['A'] }),
      stage({ index: 2, needs: ['A'], captures: ['B'] }),
      stage({ index: 3, needs: ['B'], captures: ['C'] }),
      stage({ index: 4, needs: ['C'] }),
    ];
    const r = cascadeDisable(stages, new Set(['s1']));
    expect([...r.disabled].sort()).toEqual(['s1', 's2', 's3', 's4']);
  });

  test('does not touch stages whose needs come from a still-live producer', () => {
    const stages = [
      stage({ index: 1, captures: ['A'] }),
      stage({ index: 2, captures: ['A'] }), // alternative producer for A
      stage({ index: 3, needs: ['A'] }),
    ];
    const r = cascadeDisable(stages, new Set(['s1']));
    // Disabling 1 doesn't break 3 because 2 still produces A.
    expect([...r.disabled].sort()).toEqual(['s1']);
  });
});
