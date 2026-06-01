import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  type ScoreboardEntry,
} from './api';

const REFRESH_MS = 5000;
// Legacy Python scoreboard fit up to 8 rows per column and added columns as
// the roster grew. Same heuristic here, with a cap that covers up to 4
// concurrent HPoCs (~40 agents at 8 per col = 5 cols). Cards shrink via
// container queries when columns get narrow — no separate compact mode.
const MAX_ROWS_PER_COL = 8;
const MAX_COLS = 5;
// `?demo=N` bypasses the fetch and renders a canned roster — useful for
// previewing the layout at different densities without seeding the DB.
const DEMO_PARAM = 'demo';
const COMBINED_PARAM = 'combined';
const DEMO_PRESETS = [5, 12, 40] as const;

interface DisplayPayload {
  packId: string;
  packName: string;
  mode: 'mock' | 'live';
  totalStages: number;
  entries: Array<ScoreboardEntry & { peerLabel?: string | null }>;
  /** Set in combined mode; identifies the cluster this server runs on so
   *  local entries (peerLabel === null) can still be cluster-tagged. */
  selfLabel?: string | null;
}

export function Scoreboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const demoRaw = searchParams.get(DEMO_PARAM);
  const demoCount = useMemo(() => {
    if (demoRaw === null) return null;
    const n = Number.parseInt(demoRaw, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 40) : null;
  }, [demoRaw]);
  const combined = searchParams.get(COMBINED_PARAM) === '1';
  const [livePayload, setLivePayload] = useState<DisplayPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<number>(Date.now());

  useEffect(() => {
    document.title = 'NIG - scoreboard';
  }, []);

  // Demo payload is memoized on (demoCount, combined) so switching either
  // re-seeds without flickering while we stay on the same combo. Combined
  // demo spreads entries across a few fake clusters for layout validation.
  const demoPayload = useMemo<DisplayPayload | null>(
    () => (demoCount !== null ? makeDemoPayload(demoCount, combined) : null),
    [demoCount, combined],
  );
  const payload = demoPayload ?? livePayload;

  useEffect(() => {
    if (demoCount !== null) return; // demo mode: skip live polling
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const p = combined ? await api.combinedScoreboard() : await api.scoreboard();
        if (!cancelled) {
          setLivePayload(p as DisplayPayload);
          setError(null);
          setLastRefreshAt(Date.now());
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) timer = setTimeout(tick, REFRESH_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [demoCount, combined]);

  const count = payload?.entries.length ?? 0;
  const cols = count === 0 ? 1 : Math.min(Math.ceil(count / MAX_ROWS_PER_COL), MAX_COLS);
  const rows = count === 0 ? 1 : Math.ceil(count / cols);
  // Row heights are tiered so the layout breathes deliberately across the
  // whole range: 1-row boards don't balloon, mid-range boards (3-7 rows)
  // still leave top+bottom gutters rather than stretching to fill, and
  // the 8-row dense case fills the viewport because we need every pixel
  // for 40-agent events. `align-content: center` (applied via .is-sparse)
  // centers the leftover breathing space instead of piling cards at top.
  const rowSize = rowSizeFor(rows);
  const isSparse = rows < 8;

  return (
    <div className="scoreboard-projector">
      <header className="scoreboard-header">
        <Link to="/" className="scoreboard-back" aria-label="back to game">←</Link>
        <h1 className="scoreboard-title">Status of Undercover Agents</h1>
        <LiveDot lastRefreshAt={lastRefreshAt} />
      </header>
      {error && <div className="scoreboard-error">scoreboard: {error}</div>}
      {!payload ? (
        <div className="scoreboard-empty">loading…</div>
      ) : payload.entries.length === 0 ? (
        <div className="scoreboard-empty">
          No agents deployed yet.<br /><span className="c-dim">Start a session to appear on the board.</span>
        </div>
      ) : (
        <div
          className={`scoreboard-grid${isSparse ? ' is-sparse' : ''}`}
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, ${rowSize})`,
          }}
        >
          {payload.entries.map((e) => (
            <AgentCard
              key={e.sessionId}
              entry={e}
              clusterLabel={combined ? (e.peerLabel ?? payload.selfLabel ?? null) : null}
            />
          ))}
        </div>
      )}
      {(demoCount !== null || livePayload?.mode === 'mock') && (
        <DemoSwitch
          current={demoCount}
          onPick={(n) => {
            // Preserve ?combined=1 across demo-preset clicks so the
            // combined layout can be previewed at different densities.
            const next = new URLSearchParams(searchParams);
            next.set(DEMO_PARAM, String(n));
            setSearchParams(next);
          }}
          onExit={() => {
            const next = new URLSearchParams(searchParams);
            next.delete(DEMO_PARAM);
            setSearchParams(next);
          }}
        />
      )}
    </div>
  );
}

function DemoSwitch({
  current,
  onPick,
  onExit,
}: {
  /** Current demo preset, or `null` when running on live data. */
  current: number | null;
  onPick: (n: number) => void;
  onExit: () => void;
}) {
  const isLive = current === null;
  return (
    <nav className="scoreboard-demo-switch" aria-label="demo preset">
      <span className="scoreboard-demo-label">demo</span>
      {DEMO_PRESETS.map((n) => (
        <button
          key={n}
          type="button"
          className={`scoreboard-demo-btn${n === current ? ' is-active' : ''}`}
          onClick={() => onPick(n)}
        >
          {n}
        </button>
      ))}
      <button
        type="button"
        className={`scoreboard-demo-btn scoreboard-demo-exit${isLive ? ' is-active' : ''}`}
        onClick={onExit}
        title={isLive ? 'already live' : 'exit demo mode'}
        disabled={isLive}
      >
        live
      </button>
    </nav>
  );
}

function AgentCard({
  entry,
  clusterLabel,
}: {
  entry: ScoreboardEntry & { peerLabel?: string | null };
  /** Resolved cluster tag to render on the card. `null` in non-combined
   *  mode (single-instance view doesn't need the tag); a string in
   *  combined mode — either the peer label for remote entries or the
   *  server's `selfLabel` for local entries. */
  clusterLabel: string | null;
}) {
  // Percent denominator = `effectiveTotalStages` from the server (raw pack
  // total minus stages filtered for cluster reasons: missing caps,
  // destructive-on-other, pack-disabled by overlay). Earlier we computed
  // `engaged = totalStages - stagesDisabled` client-side, but
  // `stagesDisabled` only grows when the engine actually walks past a
  // gated stage during `advance()` — for an in-progress session at stage
  // 3, all FUTURE filtered stages still counted against the player and
  // capped them at e.g. 3/39 ≈ 8% instead of 3/36 ≈ 8.3% (same here)
  // … but more importantly capped a finished session at 36/39 ≈ 92%
  // instead of the correct 36/36 = 100% when the engine had skipped
  // mid-run rather than recording every disable. We never surface the
  // total — the player sees their relative rank + progress, not the
  // scenario length (keeps the "how much is left?" suspense).
  const engaged = Math.max(1, entry.effectiveTotalStages);
  const percent = Math.min(100, Math.round((entry.stagesPassed / engaged) * 100));
  const tier = progressTier(percent);
  const agentName = entry.username ?? 'anonymous';
  const trigramLabel = entry.trigram ?? '—';
  const stageLabel = entry.stageName ?? 'mission complete';
  // Time line: finished sessions show total duration; playing sessions show
  // elapsed + an "idle Xm" hint when the last stage_history touch is > 60 s
  // old. That reveals stuck/AFK players without the noise of "updated 2s
  // ago" ticking constantly — we only surface inactivity.
  const now = Date.now();
  const idleMs = entry.lastActivityAt !== null ? now - entry.lastActivityAt : 0;
  const timeLabel =
    entry.finishedAt !== null
      ? `finished · ${fmtDuration(entry.finishedAt - entry.startedAt)}`
      : entry.lastActivityAt !== null && idleMs > 60_000
        ? `${fmtDuration(now - entry.startedAt)} · idle ${fmtDuration(idleMs)}`
        : fmtDuration(now - entry.startedAt);
  return (
    <div className={`agent-card agent-${entry.status} agent-rank-${rankTier(entry.rank)}`}>
      <div className="agent-topline">
        <span className="agent-rank">#{entry.rank}</span>
        <span className="agent-heading">
          <span className="agent-username">{agentName}</span>
          <span className="agent-aka"> a.k.a. </span>
          <span className="agent-trigram">{trigramLabel}</span>
          {clusterLabel && (
            <span className="agent-cluster" title={`cluster: ${clusterLabel}`}>
              · {clusterLabel}
            </span>
          )}
        </span>
        <span className="agent-percent">{percent}%</span>
      </div>
      <div
        className="agent-progress"
        role="progressbar"
        aria-label={`${agentName} progress`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`agent-progress-fill agent-progress-${tier}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="agent-meta">
        <span className="agent-stage">{stageLabel}</span>
        <span className="agent-time">{timeLabel}</span>
      </div>
    </div>
  );
}

function LiveDot({ lastRefreshAt }: { lastRefreshAt: number }) {
  // Pulsing indicator next to the title so projector viewers know the board
  // is live (vs. a frozen screenshot). Small, not distracting.
  const age = Date.now() - lastRefreshAt;
  const fresh = age < REFRESH_MS * 2;
  return (
    <span
      className={`scoreboard-live${fresh ? ' is-fresh' : ''}`}
      title={fresh ? 'live · refreshing every 5 s' : 'no recent refresh'}
    >
      <span className="scoreboard-live-dot" /> live
    </span>
  );
}

function makeDemoPayload(count: number, combined: boolean): DisplayPayload {
  // Deterministic-ish seed so re-renders stay stable within a session.
  const NAMES = [
    'Alice', 'Bob', 'Carol', 'David', 'Eve', 'Frank', 'Grace', 'Hank',
    'Iris', 'Jack', 'Kim', 'Leo', 'Maya', 'Nate', 'Olga', 'Pete',
    'Quin', 'Rosa', 'Sam', 'Tina', 'Uri', 'Vera', 'Wade', 'Xena',
    'Yves', 'Zoe', 'Anna', 'Ben', 'Cleo', 'Drew', 'Elle', 'Finn',
    'Gina', 'Hugo', 'Ida', 'Jude', 'Kai', 'Luca', 'Mira', 'Noor',
  ];
  const STAGE_NAMES = [
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
  const TOTAL = STAGE_NAMES.length;
  // In combined mode, sprinkle entries across a fixed set of fake clusters
  // so the cluster-tag rendering can be validated at any density. First
  // slot is `null` (= local) so the player's own cluster tag is also
  // exercised by the demo via `selfLabel` below.
  const FAKE_PEERS: Array<string | null> = [null, 'POC-37', 'DM3-POC042', 'EMEA-LAB-7'];
  const now = Date.now();
  const entries: Array<ScoreboardEntry & { peerLabel?: string | null }> = Array.from({ length: count }, (_, i) => {
    // Distribute progress across the roster: top few near-finished, a
    // cluster mid-game, some just started, 1-2 finished at the very top,
    // 1 idle. Anonymous (pre-trigram) entries are filtered out of the
    // public scoreboard so we don't seed them into the demo either.
    const isFinished = i === 0 && count >= 3;
    const isIdle = count >= 4 && i === 2;
    const progressRatio = isFinished
      ? 1
      : Math.max(0.05, 1 - (i / count) * 0.95);
    const stagesPassed = Math.round(progressRatio * TOTAL);
    const nextIdx = isFinished ? null : Math.min(stagesPassed, TOTAL - 1);
    const startedAt = now - (3 + Math.floor(Math.random() * 120)) * 60_000;
    const finishedAt = isFinished ? now - 8 * 60_000 : null;
    const lastActivityAt = isFinished
      ? finishedAt
      : isIdle
        ? now - 4 * 60_000
        : now - Math.floor(Math.random() * 40_000);
    const peerLabel = combined ? FAKE_PEERS[i % FAKE_PEERS.length]! : null;
    return {
      rank: i + 1,
      sessionId: `demo-${i + 1}`,
      trigram: NAMES[i % NAMES.length].slice(0, 3).toUpperCase(),
      username: NAMES[i % NAMES.length],
      stageName: nextIdx !== null ? STAGE_NAMES[nextIdx] ?? null : null,
      stagesPassed,
      stagesDisabled: 0,
      totalStages: TOTAL,
      effectiveTotalStages: TOTAL,
      startedAt,
      finishedAt,
      lastActivityAt,
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

function rowSizeFor(rows: number): string {
  // Targeted at a 1080p projector; `vh` keeps proportions on 4K too.
  // Each cap is chosen so `rows × cap` stays below viewport height by a
  // breathing margin. >= 8 rows = dense, fill everything.
  const caps: Record<number, string> = {
    1: 'clamp(200px, 42vh, 340px)',
    2: 'clamp(170px, 32vh, 280px)',
    3: 'clamp(160px, 24vh, 240px)',
    4: 'clamp(150px, 20vh, 220px)',
    5: 'clamp(140px, 16vh, 190px)',
    6: 'clamp(130px, 13vh, 160px)',
    7: 'clamp(120px, 11vh, 140px)',
  };
  return caps[rows] ?? 'minmax(0, 1fr)';
}

function rankTier(rank: number): 'gold' | 'silver' | 'bronze' | 'plain' {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3) return 'bronze';
  return 'plain';
}

function progressTier(percent: number): 'low' | 'mid' | 'high' | 'done' {
  if (percent >= 100) return 'done';
  if (percent >= 66) return 'high';
  if (percent >= 33) return 'mid';
  return 'low';
}

function fmtDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}`;
  return `${sec}s`;
}
