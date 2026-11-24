/** Inputs shared by local SQL rows and remote scoreboard entries. */
export interface RankingEntry {
  sessionId: string;
  peerLabel?: string | null;
  stagesPassed: number;
  startedAt: number;
  finishedAt: number | null;
  progressReachedAt?: number;
  /** Playing time frozen at the latest passed stage (or finish), before help. */
  progressTimeMs?: number;
  blockedMs?: number;
  helpPenaltySec?: number;
}

export function effectiveDuration(e: RankingEntry): number {
  const playing = e.progressTimeMs ?? (e.finishedAt === null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, e.finishedAt - e.startedAt - (e.blockedMs ?? 0)));
  return playing + (e.helpPenaltySec ?? 0) * 1000;
}

/** Finished first, progress, frozen playing time + current help, arrival, stable identity. */
export function compareRanking(a: RankingEntry, b: RankingEntry): number {
  if ((a.finishedAt !== null) !== (b.finishedAt !== null)) return a.finishedAt !== null ? -1 : 1;
  if (a.stagesPassed !== b.stagesPassed) return b.stagesPassed - a.stagesPassed;
  const aTime = effectiveDuration(a), bTime = effectiveDuration(b);
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  // Old peers cannot supply a reliable progression timestamp: retain their start fallback.
  const aReached = a.finishedAt ?? a.progressReachedAt ?? a.startedAt;
  const bReached = b.finishedAt ?? b.progressReachedAt ?? b.startedAt;
  if (aReached !== bReached) return aReached - bReached;
  const aId = JSON.stringify([a.peerLabel ?? '', a.sessionId]);
  const bId = JSON.stringify([b.peerLabel ?? '', b.sessionId]);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}
