import { describe, expect, test } from 'bun:test';
import { stageState, stateNote, STATE_ORDER } from '../src/pack-state';
import type { AdminPackStageEntry } from '../src/api';

/** A healthy stage. Each test bends exactly the field it is about. */
function stage(over: Partial<AdminPackStageEntry> = {}): AdminPackStageEntry {
  return {
    stageName: 'create-vm',
    active: true,
    adminGate: false,
    impact: 'safe',
    activeOverridden: false,
    adminGateOverridden: false,
    needs: [],
    captures: [],
    brokenMissingVars: [],
    requires: [],
    requiresOnOther: [],
    missingCapabilities: [],
    ...over,
  };
}

describe('stageState', () => {
  test('a healthy stage is playable', () => {
    expect(stageState(stage(), false)).toBe('playable');
  });

  test('a closed gate shows as gated', () => {
    expect(stageState(stage({ adminGate: true }), false)).toBe('gated');
  });

  test('a capability the cluster lacks skips the stage', () => {
    expect(stageState(stage({ missingCapabilities: ['NCM'] }), false)).toBe('skipped');
  });

  test('unsatisfiable needs show as broken', () => {
    expect(stageState(stage({ brokenMissingVars: ['VMUUID'] }), false)).toBe('broken');
  });

  test('an inactive stage is off', () => {
    expect(stageState(stage({ active: false }), false)).toBe('off');
  });

  // hpoc-only stages run fine on a dedicated cluster. Only a shared one
  // drops them, which is what `filtersHpocOnly` carries.
  test('hpoc-only only counts as skipped on a shared cluster', () => {
    const s = stage({ impact: 'hpoc-only' });
    expect(stageState(s, true)).toBe('skipped');
    expect(stageState(s, false)).toBe('playable');
  });

  // Precedence is the load-bearing part of this function: a stage the
  // engine never runs must not be painted as a problem to fix.
  test('off outranks every other reason', () => {
    const s = stage({
      active: false,
      adminGate: true,
      missingCapabilities: ['NCM'],
      brokenMissingVars: ['VMUUID'],
    });
    expect(stageState(s, true)).toBe('off');
  });

  test('skipped outranks broken: a stage that never runs cannot fail anyone', () => {
    const s = stage({ missingCapabilities: ['NCM'], brokenMissingVars: ['VMUUID'] });
    expect(stageState(s, false)).toBe('skipped');
  });

  test('broken outranks gated: the gate is moot if the stage cannot pass', () => {
    const s = stage({ adminGate: true, brokenMissingVars: ['VMUUID'] });
    expect(stageState(s, false)).toBe('broken');
  });

  test('every state the function can return has a slot in the display order', () => {
    const produced = new Set([
      stageState(stage(), false),
      stageState(stage({ adminGate: true }), false),
      stageState(stage({ missingCapabilities: ['NCM'] }), false),
      stageState(stage({ brokenMissingVars: ['X'] }), false),
      stageState(stage({ active: false }), false),
    ]);
    expect([...produced].sort()).toEqual([...STATE_ORDER].sort());
  });
});

describe('stateNote', () => {
  test('a playable stage says nothing', () => {
    expect(stateNote(stage(), 'playable', 'hpoc')).toBeNull();
  });

  // The operator needs to tell their own doing from the pack's.
  test('off distinguishes an operator override from a pack default', () => {
    expect(stateNote(stage({ active: false, activeOverridden: true }), 'off', 'hpoc'))
      .toBe('you turned this off');
    expect(stateNote(stage({ active: false }), 'off', 'hpoc'))
      .toBe('off in the pack files');
  });

  test('skipped names the missing capabilities when that is the reason', () => {
    expect(stateNote(stage({ missingCapabilities: ['NCM', 'IO'] }), 'skipped', 'other'))
      .toBe('this cluster has no NCM, IO');
  });

  test('skipped falls back to the profile when the reason is hpoc-only', () => {
    expect(stateNote(stage({ impact: 'hpoc-only' }), 'skipped', 'other'))
      .toBe('hpoc-only, and this cluster is other');
  });

  test('broken names the variables no stage produces any more', () => {
    expect(stateNote(stage({ brokenMissingVars: ['VMUUID', 'HostUUID'] }), 'broken', 'hpoc'))
      .toBe('nothing left produces VMUUID, HostUUID');
  });

  test('gated tells the operator the room is waiting on them', () => {
    expect(stateNote(stage({ adminGate: true }), 'gated', 'hpoc'))
      .toBe('players wait here until you unlock');
  });
});
