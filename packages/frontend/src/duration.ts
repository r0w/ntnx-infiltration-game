/**
 * A duration as the scoreboard shows it: `45s`, `12m30`, `1h05`. Short enough
 * for a card, and the same format wherever a time is shown next to another.
 */
export function fmtDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}`;
  return `${sec}s`;
}

/** A help penalty in the same format, with its plus: `+4m30`. Nothing when it is free. */
export function fmtPenaltyShort(seconds: number): string {
  return seconds > 0 ? `+${fmtDuration(seconds * 1000)}` : '';
}
