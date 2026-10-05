/** The part of a scoreboard entry the card clock needs (see `ScoreboardEntry`). */
export interface CardClock {
  startedAt: number;
  finishedAt: number | null;
  lastActivityAt: number | null;
  /** Time the operator held the player in waits that are over. */
  blockedMs?: number;
  /** Start of the wait still running, `null` when the player is not held. */
  blockedSince?: number | null;
  /** End of the player's latest wait. */
  lastReleasedAt?: number | null;
}

/** A card shows "idle" once nothing was attempted for this long. */
export const IDLE_AFTER_MS = 60_000;

/**
 * Playing time on a card: from the start to the finish, to now, or to the start
 * of the wait still running (the clock stops while the operator holds the
 * player), minus the waits that are over. Peers on an older version send no
 * waits, so their cards keep the plain elapsed time.
 */
export function netElapsedMs(e: CardClock, now: number): number {
  const end = e.finishedAt ?? e.blockedSince ?? now;
  return Math.max(0, end - e.startedAt - (e.blockedMs ?? 0));
}

/** How long the player has been held by the wait still running, or `null`. */
export function heldMs(e: Pick<CardClock, 'blockedSince'>, now: number): number | null {
  return e.blockedSince == null ? null : Math.max(0, now - e.blockedSince);
}

/**
 * Time since the player last did something, or `null` when it does not apply:
 * the player has finished or is held, or nothing is known. A release counts as
 * activity, so the clock restarts at the unlock instead of showing the whole
 * wait as inactivity.
 */
export function idleMs(e: CardClock, now: number): number | null {
  if (e.finishedAt !== null || e.blockedSince != null) return null;
  const last = Math.max(e.lastActivityAt ?? -Infinity, e.lastReleasedAt ?? -Infinity);
  return Number.isFinite(last) ? Math.max(0, now - last) : null;
}
