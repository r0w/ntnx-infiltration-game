import type { AdminPackStageEntry } from './api';

/**
 * What a stage will actually do for the next player who reaches it.
 *
 * The order of the checks in `stageState` is the whole point: a stage the
 * engine never runs cannot fail anyone, so `off` and `skipped` outrank
 * `broken`. Getting that backwards would paint a red alarm on a stage that
 * is not even in tonight's run.
 */
export type StageState = 'off' | 'skipped' | 'broken' | 'gated' | 'playable';

/** Display order: healthy first, the thing you must fix last. */
export const STATE_ORDER: StageState[] = ['playable', 'gated', 'skipped', 'off', 'broken'];

export function stageState(
  s: AdminPackStageEntry,
  /** True when the runtime cluster is shared, which is the only case where
   *  the engine drops hpoc-only stages at session creation. */
  filtersHpocOnly: boolean,
): StageState {
  if (!s.active) return 'off';
  if (s.missingCapabilities.length > 0 || (filtersHpocOnly && s.impact === 'hpoc-only')) {
    return 'skipped';
  }
  if (s.brokenMissingVars.length > 0) return 'broken';
  if (s.adminGate) return 'gated';
  return 'playable';
}

/** One line saying why a stage is not simply playable. Null when it is. */
export function stateNote(
  s: AdminPackStageEntry,
  state: StageState,
  profile: 'hpoc' | 'other' | null,
): string | null {
  switch (state) {
    case 'off':
      return s.activeOverridden ? 'you turned this off' : 'off in the pack files';
    case 'skipped':
      return s.missingCapabilities.length > 0
        ? `this cluster has no ${s.missingCapabilities.join(', ')}`
        // `profile` is only null before the pack payload lands, which the
        // caller renders past, but this stays a pure function: name the
        // cluster generically rather than print "null".
        : `hpoc-only, and this cluster is ${profile ?? 'shared'}`;
    case 'broken':
      return `nothing left produces ${s.brokenMissingVars.join(', ')}`;
    case 'gated':
      return 'players wait here until you unlock';
    default:
      return null;
  }
}
