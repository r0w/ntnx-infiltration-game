import type { PackInfo } from './api';

/**
 * Pacing defaults for the dev modes. `test` and `mock` are for replaying the
 * game over and over, so the typewriter and the <pause/> beats only slow the
 * operator down: both start off there. `live` keeps the pack's pacing, which
 * is what players see. An explicit choice in the dev panel always wins.
 */
export function isReplayMode(mode: PackInfo['mode'] | undefined): boolean {
  return mode === 'test' || mode === 'mock';
}

/** Effective typewriter speed (ms/char). `override` null = no explicit choice. */
export function effectiveTypingSpeed(
  override: number | null,
  packSpeedMs: number,
  mode: PackInfo['mode'] | undefined,
): number {
  if (override !== null) return override;
  return isReplayMode(mode) ? 0 : packSpeedMs;
}

/** Effective skip-pauses flag. `override` null = no explicit choice. */
export function effectiveSkipPauses(
  override: boolean | null,
  mode: PackInfo['mode'] | undefined,
): boolean {
  return override ?? isReplayMode(mode);
}
