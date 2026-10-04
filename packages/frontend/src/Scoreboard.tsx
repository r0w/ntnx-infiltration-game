import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  type ScoreboardEntry,
} from './api';
import { formatPenalty } from './helpLabels';
import { scoreboardLayout } from './scoreboardDisplay';
import { advanceDemo, makeDemoPayload, type DisplayPayload } from './scoreboardDemo';
import { useScoreboardDisplaySettings } from './useScoreboardDisplaySettings';
import { useScoreboardScroll } from './useScoreboardScroll';

const REFRESH_MS = 5000;
const MAX_DEMO_AGENTS = 200;
// `?demo=N` bypasses the fetch and renders a canned roster — useful for
// previewing the layout at different densities without seeding the DB.
const DEMO_PARAM = 'demo';
const COMBINED_PARAM = 'combined';

export function Scoreboard() {
  const [searchParams] = useSearchParams();
  const demoRaw = searchParams.get(DEMO_PARAM);
  const demoCount = useMemo(() => {
    if (demoRaw === null) return null;
    const n = Number(demoRaw);
    return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_DEMO_AGENTS) : null;
  }, [demoRaw]);
  const combined = searchParams.get(COMBINED_PARAM) === '1';
  const [livePayload, setLivePayload] = useState<DisplayPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<number>(Date.now());
  const rosterRef = useRef<HTMLDivElement>(null);
  const [rosterSize, setRosterSize] = useState({ width: 0, height: 0 });
  const { settings: displaySettings } = useScoreboardDisplaySettings();

  useEffect(() => {
    if (rosterRef.current) rosterRef.current.scrollTop = 0;
  }, [displaySettings.mode]);

  useEffect(() => {
    document.title = 'NIG - scoreboard';
    const roster = rosterRef.current;
    if (!roster) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setRosterSize({ width, height });
    });
    observer.observe(roster);
    return () => observer.disconnect();
  }, []);

  const simulate = searchParams.get('simulate') === '1';
  const [demoPayload, setDemoPayload] = useState<DisplayPayload | null>(null);
  useEffect(() => {
    setDemoPayload(demoCount !== null ? makeDemoPayload(demoCount, combined) : null);
    if (demoCount === null || !simulate) return;
    const timer = setInterval(() => setDemoPayload((current) => advanceDemo(current)), REFRESH_MS);
    return () => clearInterval(timer);
  }, [demoCount, combined, simulate]);
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
  const layout = scoreboardLayout(count, rosterSize.width, rosterSize.height, displaySettings.mode);
  const scrolling = displaySettings.mode === 'scroll';
  useScoreboardScroll(rosterRef, scrolling && count > 0, displaySettings.paused, displaySettings.speed, layout.visibleHeight, rosterSize.height);

  return (
    <div className="scoreboard-projector">
      <header className="scoreboard-header">
        <h1 className="scoreboard-title">Status of Undercover Agents</h1>
        <div className="scoreboard-status">
          <span>{count} {count === 1 ? 'agent' : 'agents'}</span>
          {demoCount !== null ? <span className="scoreboard-demo-indicator">demo</span> : <LiveDot lastRefreshAt={lastRefreshAt} />}
        </div>
      </header>
      {error && demoCount === null && <div className="scoreboard-error">scoreboard: {error}</div>}
      <div className={`scoreboard-roster${scrolling ? '' : ' is-fit'}`} ref={rosterRef} role="region" aria-label="Agent rankings" tabIndex={0}>
        {!payload ? (
          <div className="scoreboard-empty">loading…</div>
        ) : payload.entries.length === 0 ? (
          <div className="scoreboard-empty">
            No agents deployed yet.<br /><span className="c-dim">Start a session to appear on the board.</span>
          </div>
        ) : (
          <div className="scoreboard-canvas" style={{ height: layout.visibleHeight }}>
            <div
              className={`scoreboard-grid${layout.compact ? ' is-dense' : ''}`}
              style={{
                gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${layout.rows}, minmax(88px, 1fr))`,
                width: layout.width,
                height: layout.height,
                transform: `scale(${layout.scale})`,
              }}
            >
              {payload.entries.map((e) => (
                <AgentCard
                  key={e.sessionId}
                  entry={e}
                  simple={displaySettings.view === 'simple'}
                  highlightProgress={displaySettings.highlightProgress}
                  clusterLabel={combined ? (e.peerLabel ?? payload.selfLabel ?? null) : null}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AgentCard({
  entry,
  clusterLabel,
  simple,
  highlightProgress,
}: {
  entry: ScoreboardEntry & { peerLabel?: string | null };
  /** Resolved cluster tag to render on the card. `null` in non-combined
   *  mode (single-instance view doesn't need the tag); a string in
   *  combined mode — either the peer label for remote entries or the
   *  server's `selfLabel` for local entries. */
  clusterLabel: string | null;
  simple: boolean;
  highlightProgress: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const previousProgress = useRef(entry.stagesPassed);
  useEffect(() => {
    const advanced = entry.stagesPassed > previousProgress.current;
    previousProgress.current = entry.stagesPassed;
    const card = cardRef.current;
    if (!card || !advanced || !highlightProgress || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animation = card.animate([
      { boxShadow: 'inset 0 0 28px rgba(124, 220, 254, 0.3)', borderColor: '#7cdcfe' },
      { boxShadow: 'inset 0 0 0 rgba(124, 220, 254, 0)', borderColor: getComputedStyle(card).borderColor },
    ], { duration: 2200, easing: 'ease-out' });
    return () => animation.cancel();
  }, [entry.stagesPassed, highlightProgress]);
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
  // Step-by-step help is part of the score: each stage whose help the player
  // displayed is counted, and its penalty (if any) is added to the finish time
  // in the ranking. The badge keeps the cost visible next to the clock.
  const helpUses = entry.helpUses ?? 0;
  const helpCost = formatPenalty(entry.helpPenaltySec ?? 0);
  return (
    <div ref={cardRef} className={`agent-card agent-${entry.status} agent-rank-${rankTier(entry.rank)}${simple ? ' agent-simple' : ''}`}>
      <div className="agent-topline">
        <span className="agent-rank">#{entry.rank}</span>
        <span className="agent-heading" title={`${agentName} · ${trigramLabel}`}>
          <span className="agent-username">{agentName}</span>
          <span className="agent-trigram">{trigramLabel}</span>
        </span>
        <span className="agent-percent">{percent}%</span>
      </div>
      {(!simple || clusterLabel) && <div className="agent-details">
        <span className="agent-cluster" title={clusterLabel ? `cluster: ${clusterLabel}` : undefined}>{clusterLabel}</span>
        {!simple && <span className="agent-time">{timeLabel}</span>}
      </div>}
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
      {!simple && <div className="agent-meta">
        <span className="agent-stage" title={stageLabel}>{stageLabel}</span>
        {helpUses > 0 && (
          <span
            className="agent-help"
            title={
              `step-by-step help used on ${helpUses} stage${helpUses === 1 ? '' : 's'}` +
              (helpCost ? ` — ${helpCost} added to the finish time` : '')
            }
          >
            💡×{helpUses}
            {helpCost && ` ${helpCost}`}
          </span>
        )}
      </div>}
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
