import type { ScoreboardEntry } from './api';

export const MAX_DEMO_AGENTS = 200;

export interface DisplayPayload {
  packId: string;
  packName: string;
  mode: 'mock' | 'live';
  totalStages: number;
  entries: Array<ScoreboardEntry & { peerLabel?: string | null }>;
  /** Set in combined mode; identifies the cluster this server runs on so
   *  local entries (peerLabel === null) can still be cluster-tagged. */
  selfLabel?: string | null;
}

const DEMO_STAGE_NAMES = [
  'login', 'recovery-gate', 'intro-tank-greet', 'intro-mission',
  'intro-credentials', 'create-admin-user', 'create-auth-policy',
  'network-recon', 'create-project', 'create-subnet', 'add-ubuntu-image',
  'create-vm', 'live-migrate', 'scan-host', 'create-category',
  'apply-category-to-vm', 'create-storage-policy', 'create-security-policy',
  'allow-ssh-in-microseg', 'extract-payload', 'create-protection-policy',
  'create-approval-policy', 'trigger-incident', 'incident-freeze',
  'incident-reconnect', 'incident-welcome', 'restore-vm-from-recovery',
  'vault-breach', 'expand-cluster', 'lcm-check-updates', 'create-report',
  'cleanup-stage-1', 'cleanup-stage-2', 'ncm-playbook', 'self-service-clone',
  'sched-day2', 'update-blueprint', 'mission-report', 'outro',
];

export function makeDemoPayload(count: number, combined: boolean): DisplayPayload {
  // Include longer names and repeat trigrams across clusters, as in events.
  const NAMES = [
    'Alice', 'Bob', 'Carol', 'David', 'Eve', 'Frank', 'Grace', 'Hank',
    'Iris', 'Jack', 'Kim', 'Leo', 'Maya', 'Nate', 'Olga', 'Pete',
    'Quin', 'Rosa', 'Sam', 'Tina', 'Uri', 'Vera', 'Wade', 'Xena',
    'Yves', 'Zoe', 'Anna', 'Ben', 'Cleo', 'Drew', 'Elle', 'Finn',
    'Gina', 'Hugo', 'Ida', 'Jude', 'Kai', 'Luca', 'Mira', 'Noor',
    'Alexandra', 'Maximilian', 'Jean-Pierre', 'Anne-Sophie', 'Sébastien',
    'Charlotte', 'Alexander', 'Valentina', 'Benjamin', 'Christopher',
  ];
  const TOTAL = DEMO_STAGE_NAMES.length;
  // In combined mode, sprinkle entries across a fixed set of fake clusters
  // so the cluster-tag rendering can be validated at any density. First
  // slot is `null` (= local) so the player's own cluster tag is also
  // exercised by the demo via `selfLabel` below.
  const FAKE_PEERS: Array<string | null> = [null, 'POC-37', 'DM3-POC042', 'EMEA-LAB-7'];
  const now = Date.now();
  const entries: Array<ScoreboardEntry & { peerLabel?: string | null }> = Array.from({ length: count }, (_, i) => {
    // Distribute progress across the roster: top few near-finished, a
    // cluster mid-game, some just started, 1-2 finished at the very top,
    // a few idle and a few held by a gate or the lunch lock. Anonymous
    // (pre-trigram) entries are filtered out of the public scoreboard so we
    // don't seed them into the demo either.
    const isFinished = i === 0 && count >= 3;
    const isIdle = count >= 4 && (i === 2 || i % 11 === 4);
    const heldBy: 'gate' | 'pause' | null =
      isFinished || count < 5 ? null : i % 9 === 5 || i % 9 === 6 ? 'gate' : count >= 12 && i % 13 === 8 ? 'pause' : null;
    const progressRatio = isFinished
      ? 1
      : Math.max(0.05, 1 - (i / count) * 0.95);
    const stagesPassed = Math.min(isFinished ? TOTAL : TOTAL - 1, Math.round(progressRatio * TOTAL));
    const nextIdx = isFinished ? null : Math.min(stagesPassed, TOTAL - 1);
    const startedAt = now - (20 + (i * 17) % 100) * 60_000;
    const finishedAt = isFinished ? now - 8 * 60_000 : null;
    const blockedSince =
      heldBy !== null ? Math.max(startedAt + 60_000, now - (6 + (i * 53) % 7) * 60_000) : null;
    const lastActivityAt = isFinished
      ? finishedAt
      : isIdle
        ? now - 4 * 60_000
        : heldBy !== null
          ? blockedSince
          : now - (i * 7919) % 40_000;
    const peerLabel = combined ? FAKE_PEERS[i % FAKE_PEERS.length]! : null;
    return {
      rank: i + 1,
      sessionId: `demo-${i + 1}`,
      trigram: NAMES[i % NAMES.length].slice(0, 3).toUpperCase(),
      username: NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : ''),
      stageName: nextIdx !== null ? DEMO_STAGE_NAMES[nextIdx] ?? null : null,
      stagesPassed,
      stagesDisabled: 0,
      totalStages: TOTAL,
      effectiveTotalStages: TOTAL,
      startedAt,
      finishedAt,
      lastActivityAt,
      // Demo only: a few agents lean on the step-by-step help so the badge
      // (with and without a time penalty) can be checked on the projector.
      helpUses: i % 4 === 1 ? 2 : i % 4 === 3 ? 1 : 0,
      helpPenaltySec: i % 4 === 1 ? 270 : 0,
      // Demo only: some players already sat out an earlier wait, others are
      // held right now (their clock is stopped).
      blockedMs: i % 5 === 0 ? 4 * 60_000 : i % 7 === 3 ? 2 * 60_000 : 0,
      blockedSince,
      blockedReason: heldBy,
      lastReleasedAt: null,
      status: finishedAt !== null ? 'finished' : 'playing',
      peerLabel,
    };
  });
  return {
    packId: 'demo',
    packName: 'Demo Roster',
    mode: 'mock',
    totalStages: TOTAL,
    // Self-label shows up on local (peerLabel === null) entries in the
    // demo so the player-perspective cluster tag is also covered.
    selfLabel: combined ? 'THIS-DEMO' : null,
    entries,
  };
}

export function advanceDemo(payload: DisplayPayload | null, random: () => number = Math.random): DisplayPayload | null {
  if (!payload) return null;
  // Pick uniformly from every unfinished player, regardless of rank or cluster.
  const playing = payload.entries.filter((entry) => entry.finishedAt === null);
  if (playing.length === 0) return payload;
  const target = playing[Math.floor(random() * playing.length)]!;
  const now = Date.now();
  const entries = payload.entries.map((entry) => {
    if (entry !== target) return entry;
    const stagesPassed = Math.min(entry.effectiveTotalStages, entry.stagesPassed + 1);
    const finished = stagesPassed === entry.effectiveTotalStages;
    // Moving on means the player is not held any more.
    const wasHeld = entry.blockedSince != null;
    return {
      ...entry, stagesPassed, lastActivityAt: now,
      blockedMs: (entry.blockedMs ?? 0) + (wasHeld ? now - entry.blockedSince! : 0),
      blockedSince: null, blockedReason: null,
      lastReleasedAt: wasHeld ? now : entry.lastReleasedAt ?? null,
      stageName: finished ? null : DEMO_STAGE_NAMES[stagesPassed] ?? null,
      finishedAt: finished ? now : null,
      status: finished ? 'finished' as const : 'playing' as const,
    };
  });
  entries.sort((a, b) => b.stagesPassed - a.stagesPassed);
  return { ...payload, entries: entries.map((entry, index) => ({ ...entry, rank: index + 1 })) };
}
