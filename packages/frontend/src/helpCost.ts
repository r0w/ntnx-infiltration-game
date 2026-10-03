import { HELP_PENALTY_MAX_SEC } from '@ntnx-game/shared';
import { formatPenalty } from './helpLabels';

/** One-click values offered by the Pack tab's help-cost editor, in seconds. */
export const HELP_COST_PRESETS = [0, 60, 120, 180, 300] as const;

/** Split a duration in seconds into the editor's two fields. */
export function splitSeconds(total: number): { min: number; sec: number } {
  const t = Math.max(0, Math.floor(total));
  return { min: Math.floor(t / 60), sec: t % 60 };
}

/**
 * Turn the editor's two text fields into a duration in seconds, or say why
 * they can't be. An empty field counts as 0, so "2" minutes and "" seconds is
 * 120 s. Only whole numbers are accepted, and the total is capped like the
 * server caps it (`HELP_PENALTY_MAX_SEC`).
 */
export function validateCost(
  minRaw: string,
  secRaw: string,
): { seconds: number } | { error: string } {
  const read = (raw: string): number | null => {
    const t = raw.trim();
    if (t === '') return 0;
    return /^\d+$/.test(t) ? Number(t) : null;
  };
  const min = read(minRaw);
  const sec = read(secRaw);
  if (min === null || sec === null) return { error: 'whole numbers only' };
  if (sec > 59) return { error: 'seconds go from 0 to 59' };
  const seconds = min * 60 + sec;
  if (seconds > HELP_PENALTY_MAX_SEC) {
    return { error: `at most ${HELP_PENALTY_MAX_SEC / 60} min` };
  }
  return { seconds };
}

/** A cost as the Pack tab shows it: `2 min`, `2 min 30 s`, `45 s`, or `free`. */
export function formatCost(seconds: number): string {
  const text = formatPenalty(seconds);
  return text === '' ? 'free' : text.slice(1);
}
