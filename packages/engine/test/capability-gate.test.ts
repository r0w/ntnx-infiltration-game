import { describe, expect, test } from 'bun:test';
import { gateStage, nextPlayableStage } from '../src/capability-gate';
import type { StageDefinition } from '../src/types';

const baseStage = (overrides: Partial<StageDefinition> = {}): StageDefinition => ({
  id: 1,
  active: true,
  messages: { en: [] },
  saveScore: true,
  ...overrides,
});

describe('gateStage', () => {
  test('blocks inactive', () => {
    const s = baseStage({ active: false });
    expect(gateStage(s, { capabilities: new Set(), clusterProfile: 'hpoc', currentStage: 0 })).toEqual({ allowed: false, reason: 'inactive' });
  });

  test('blocks already-passed', () => {
    const s = baseStage({ id: 3 });
    expect(gateStage(s, { capabilities: new Set(), clusterProfile: 'hpoc', currentStage: 5 })).toEqual({ allowed: false, reason: 'already-passed' });
  });

  test('blocks missing capability', () => {
    const s = baseStage({ requires: ['NCM', 'IO'] });
    const v = gateStage(s, { capabilities: new Set(['NCM']), clusterProfile: 'hpoc', currentStage: 0 });
    expect(v).toEqual({ allowed: false, reason: 'missing-capability', missing: ['IO'] });
  });

  test('blocks destructive on shared', () => {
    const s = baseStage({ impact: 'destructive' });
    expect(gateStage(s, { capabilities: new Set(), clusterProfile: 'other', currentStage: 0 })).toEqual({ allowed: false, reason: 'destructive-on-other' });
  });

  test('allows destructive on dedicated', () => {
    const s = baseStage({ impact: 'destructive' });
    expect(gateStage(s, { capabilities: new Set(), clusterProfile: 'hpoc', currentStage: 0 })).toEqual({ allowed: true });
  });

  test('allows safe stage with satisfied capabilities', () => {
    const s = baseStage({ requires: ['NCM'] });
    expect(gateStage(s, { capabilities: new Set(['NCM']), clusterProfile: 'other', currentStage: 0 })).toEqual({ allowed: true });
  });

  test('blocks missing-upstream when vars lookup misses a needed var', () => {
    const s = baseStage({ needs: ['ProtectionPolicyUUID', 'HostUUID'] });
    const vars = { has: (n: string) => n === 'HostUUID' };
    const v = gateStage(
      s,
      { capabilities: new Set(), clusterProfile: 'hpoc', currentStage: 0 },
      vars,
    );
    expect(v).toEqual({
      allowed: false,
      reason: 'missing-upstream',
      missingVars: ['ProtectionPolicyUUID'],
    });
  });

  test('allows when all needed vars are present', () => {
    const s = baseStage({ needs: ['VMUUID'] });
    const vars = { has: (n: string) => n === 'VMUUID' };
    const v = gateStage(
      s,
      { capabilities: new Set(), clusterProfile: 'hpoc', currentStage: 0 },
      vars,
    );
    expect(v).toEqual({ allowed: true });
  });

  test('skips needs check when vars not provided (backward compat)', () => {
    const s = baseStage({ needs: ['VMUUID'] });
    const v = gateStage(s, {
      capabilities: new Set(),
      clusterProfile: 'hpoc',
      currentStage: 0,
    });
    expect(v).toEqual({ allowed: true });
  });
});

describe('gateStage — adminGate', () => {
  test('blocks with reason=gated when adminGate is on and unlocks set is empty', () => {
    const s = baseStage({ adminGate: true });
    const v = gateStage(s, {
      capabilities: new Set(),
      clusterProfile: 'hpoc',
      currentStage: 0,
      gateUnlocks: new Set(),
    });
    expect(v).toEqual({ allowed: false, reason: 'gated' });
  });

  test('allows when adminGate is on and the stage id is in the unlocks set', () => {
    const s = baseStage({ id: 6, adminGate: true });
    const v = gateStage(s, {
      capabilities: new Set(),
      clusterProfile: 'hpoc',
      currentStage: 5,
      gateUnlocks: new Set([6]),
    });
    expect(v).toEqual({ allowed: true });
  });

  test('capability check wins over adminGate (no point opening a gate just to fail caps)', () => {
    const s = baseStage({ adminGate: true, requires: ['NCM'] });
    const v = gateStage(s, {
      capabilities: new Set(),
      clusterProfile: 'hpoc',
      currentStage: 0,
      gateUnlocks: new Set(),
    });
    expect(v).toEqual({ allowed: false, reason: 'missing-capability', missing: ['NCM'] });
  });

  test('missing-upstream wins over adminGate', () => {
    const s = baseStage({ adminGate: true, needs: ['VMUUID'] });
    const v = gateStage(
      s,
      {
        capabilities: new Set(),
        clusterProfile: 'hpoc',
        currentStage: 0,
        gateUnlocks: new Set(),
      },
      { has: () => false },
    );
    expect(v).toEqual({ allowed: false, reason: 'missing-upstream', missingVars: ['VMUUID'] });
  });
});

describe('nextPlayableStage', () => {
  test('picks next id > currentStage', () => {
    const stages = [baseStage({ id: 1 }), baseStage({ id: 2 }), baseStage({ id: 3 })];
    const r = nextPlayableStage(stages, { capabilities: new Set(), clusterProfile: 'hpoc', currentStage: 1 });
    expect(r?.kind).toBe('playable');
    if (r?.kind !== 'playable') throw new Error('expected playable');
    expect(r.next.id).toBe(2);
    expect(r.skippedDisabled).toEqual([]);
  });

  test('skips destructive on shared and records them', () => {
    const stages = [
      baseStage({ id: 2, impact: 'destructive' }),
      baseStage({ id: 3 }),
    ];
    const r = nextPlayableStage(stages, { capabilities: new Set(), clusterProfile: 'other', currentStage: 1 });
    if (r?.kind !== 'playable') throw new Error('expected playable');
    expect(r.next.id).toBe(3);
    expect(r.skippedDisabled.map((s) => s.stage.id)).toEqual([2]);
    expect(r.skippedDisabled[0].verdict.reason).toBe('destructive-on-other');
  });

  test('skips inactive silently (not in disabled list)', () => {
    const stages = [
      baseStage({ id: 2, active: false }),
      baseStage({ id: 3 }),
    ];
    const r = nextPlayableStage(stages, { capabilities: new Set(), clusterProfile: 'hpoc', currentStage: 1 });
    if (r?.kind !== 'playable') throw new Error('expected playable');
    expect(r.next.id).toBe(3);
    expect(r.skippedDisabled).toEqual([]);
  });

  test('returns null when nothing left', () => {
    const stages = [baseStage({ id: 1 })];
    const r = nextPlayableStage(stages, { capabilities: new Set(), clusterProfile: 'hpoc', currentStage: 5 });
    expect(r).toBeNull();
  });

  test('parks at a gated stage with kind=gated, does not peek past it', () => {
    const stages = [
      baseStage({ id: 2, adminGate: true }),
      baseStage({ id: 3 }),
    ];
    const r = nextPlayableStage(stages, {
      capabilities: new Set(),
      clusterProfile: 'hpoc',
      currentStage: 1,
      gateUnlocks: new Set(),
    });
    if (r?.kind !== 'gated') throw new Error('expected gated');
    expect(r.stage.id).toBe(2);
    // Stage 3 is NOT considered — once a gate is hit we stop scanning.
    expect(r.skippedDisabled).toEqual([]);
  });

  test('flips back to playable once the gate is in the unlocks set', () => {
    const stages = [
      baseStage({ id: 2, adminGate: true }),
      baseStage({ id: 3 }),
    ];
    const r = nextPlayableStage(stages, {
      capabilities: new Set(),
      clusterProfile: 'hpoc',
      currentStage: 1,
      gateUnlocks: new Set([2]),
    });
    if (r?.kind !== 'playable') throw new Error('expected playable');
    expect(r.next.id).toBe(2);
  });
});
