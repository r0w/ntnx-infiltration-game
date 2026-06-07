import { useEffect, useState } from 'react';
import { api, type PackInfo } from './api';
import { awaitingLabel } from './useSession';

// Fallback typewriter speed (ms/char) when the pack default isn't known yet.
// The slider's slowest step is 2× the default; its right edge is 0 = instant.
const DEFAULT_TYPING_MS = 15;

export interface DevPanelProps {
  sessionId: string | null;
  /** Canonical name of the last completed stage; `null` = pre-game. */
  currentStage: string | null;
  /**
   * Stage the session is actually parked on awaiting input. When a /goto jump
   * lands on a stage reached by skipping a filtered one, `currentStage` (= last
   * completed) lags behind, so this names the stage truly on screen.
   */
  awaitingStageName: string | null;
  awaitingVariable: string | null;
  busy: boolean;
  /** Auto-play armed? The toggle button lives in this panel. */
  autoPlay?: boolean;
  /** Auto-play busy with a request — shows ⏳ on the toggle. */
  autoPlayActing?: boolean;
  /** Can auto-play be armed? (post-login, non-live). Hides the toggle if not. */
  autoPlayEligible?: boolean;
  /** Arms / disarms auto-play. */
  onToggleAutoPlay?: () => void;
  /** Current typewriter speed (ms/char) — drives the speed slider. */
  typingSpeedMs?: number;
  /** Server/pack default speed (ms/char). Slowest slider step = 2× this. */
  typingSpeedDefaultMs?: number;
  /** Sets a speed override (ms/char). 0 = instant. */
  onTypingSpeedChange?: (ms: number) => void;
  /** Clears the override (double-click) → back to the default speed. */
  onTypingSpeedReset?: () => void;
  /** Whether <pause/> beats + check dwells are skipped. */
  skipPauses?: boolean;
  /** Toggles skip-pauses. */
  onSkipPausesChange?: (v: boolean) => void;
  /**
   * Server mode (`mock` | `test`), shown in the toggle label so the operator
   * knows which adapter the session hits. Mistaking `mock` for `test` made
   * auto-play look broken (mock has no POST fixtures). `live` hides the panel,
   * so the prop is narrowed to the two dev modes.
   */
  mode?: 'mock' | 'test';
  onGoto: (stageName: string) => void;
}

export function DevPanel({
  sessionId,
  currentStage,
  awaitingStageName,
  awaitingVariable,
  busy,
  autoPlay,
  autoPlayActing,
  autoPlayEligible,
  onToggleAutoPlay,
  typingSpeedMs,
  typingSpeedDefaultMs,
  onTypingSpeedChange,
  onTypingSpeedReset,
  skipPauses,
  onSkipPausesChange,
  mode,
  onGoto,
}: DevPanelProps) {
  const [pack, setPack] = useState<PackInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Furthest stage actually reached this session. The server forgets it
  // (a backward goto truncates history), so we track it client-side to know
  // how far forward `test` mode may safely jump (cluster state exists there).
  const [highWaterIdx, setHighWaterIdx] = useState(0);
  const [prevSessionId, setPrevSessionId] = useState(sessionId);

  useEffect(() => {
    let cancelled = false;
    void api
      .pack()
      .then((p) => {
        if (!cancelled) setPack(p);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Index of the stage about to play: first stage pre-game, else the one
  // right after the last completed stage (clamped to the last). Pack order
  // is play order, so we can index straight in.
  const activeIdx =
    !pack || currentStage === null
      ? 0
      : Math.min(
          pack.stages.findIndex((s) => s.name === currentStage) + 1,
          pack.stages.length - 1,
        );
  // When the session is parked awaiting input, that stage is the one truly on
  // screen — prefer it over currentStage+1, which lags after a /goto jump that
  // skipped a filtered stage. Fall back to the computed next stage otherwise.
  const awaitingIdx = awaitingStageName
    ? (pack?.stages.findIndex((s) => s.name === awaitingStageName) ?? -1)
    : -1;
  const activeStageName =
    awaitingIdx >= 0 ? awaitingStageName : (pack?.stages[activeIdx]?.name ?? null);
  // Furthest position the session actually occupies — the awaiting stage when
  // parked there (could be ahead of currentStage+1 after a skip), else the
  // computed next stage. Drives both the high-water and the highlight.
  const effectiveIdx = awaitingIdx >= 0 ? awaitingIdx : activeIdx;
  // A session hand-off (switch-identity / recovery switchTo) swaps sessionId
  // without unmounting the panel, so reset the high-water: the new session
  // must not inherit the old one's reach.
  if (sessionId !== prevSessionId) {
    setPrevSessionId(sessionId);
    setHighWaterIdx(effectiveIdx);
  }
  useEffect(() => {
    setHighWaterIdx((hw) => (effectiveIdx > hw ? effectiveIdx : hw));
  }, [effectiveIdx]);

  return (
    <div className={`devpanel ${open ? 'devpanel-open' : ''}`}>
      {/* Flex row: a button can't nest in a button, so the auto-play
          toggle sits beside the expand button. */}
      <div className="devpanel-bar">
        <button
          type="button"
          className="devpanel-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'}{' '}
          <span className={`devpanel-mode devpanel-mode-${mode ?? 'unknown'}`}>
            {mode ?? 'dev'}
          </span>
          {' · '}
          {activeStageName ?? currentStage ?? 'pre-game'}
          {awaitingVariable ? ` · awaiting ${awaitingLabel(awaitingVariable)}` : ''}
        </button>
        {onSkipPausesChange && (
          <label className="devpanel-skippauses" title="Skip <pause> beats + check-result dwells">
            <input
              type="checkbox"
              checked={!!skipPauses}
              onChange={(e) => onSkipPausesChange(e.target.checked)}
            />
            <span>no pauses</span>
          </label>
        )}
        {onTypingSpeedChange && typeof typingSpeedMs === 'number' && (() => {
          // Slowest = 2× the pack default; right edge = 0 = instant. The
          // default sits at the slider's midpoint.
          const speedMax = 2 * (typingSpeedDefaultMs ?? DEFAULT_TYPING_MS);
          return (
            <label
              className="devpanel-speed"
              title="Typewriter speed — full right = instant · double-click to reset"
              onDoubleClick={() => onTypingSpeedReset?.()}
            >
              <span>speed</span>
              <input
                type="range"
                min={0}
                max={speedMax}
                step={1}
                // Slider value is inverted so right = fast (low ms).
                value={speedMax - Math.min(typingSpeedMs, speedMax)}
                onChange={(e) => onTypingSpeedChange(speedMax - Number(e.target.value))}
              />
              <span className="devpanel-speed-val">
                {typingSpeedMs === 0 ? 'instant' : `${typingSpeedMs}ms`}
              </span>
            </label>
          );
        })()}
        {onToggleAutoPlay && (
          // Always rendered so the bar layout never shifts; just disabled
          // until the player reaches a playable stage (post-login).
          <button
            type="button"
            className={`devpanel-autoplay-toggle${autoPlay ? ' is-active' : ''}${
              autoPlayActing ? ' is-acting' : ''
            }`}
            onClick={onToggleAutoPlay}
            disabled={!autoPlayEligible}
            aria-pressed={autoPlay}
            title={
              !autoPlayEligible
                ? 'Auto-play available once you reach a playable stage'
                : autoPlay
                  ? 'Auto-play armed — disarm to press Enter yourself'
                  : 'Auto-play: press Enter on every continue prompt'
            }
          >
            <span className="devpanel-autoplay-icon" aria-hidden="true">
              {autoPlay ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 5 L19 12 L7 19 Z" />
                </svg>
              )}
            </span>
            <span>
              {autoPlayActing
                ? 'auto-play ⏳'
                : autoPlay
                  ? 'auto-play on'
                  : 'auto-play'}
            </span>
          </button>
        )}
      </div>
      {open && (
        <div className="devpanel-body">
          {error && <div className="devpanel-error">{error}</div>}
          {!pack && !error && <div className="c-dim">loading pack…</div>}
          {pack && (
            <>
              <div className="devpanel-legend">
                Click a stage to <em>jump</em> there.
                {' '}{mode === 'mock'
                  ? 'Any stage in mock.'
                  : 'Forward only, up to the furthest stage reached.'}
                {' '}Variables and UUIDs are kept.
              </div>
              <div className="devpanel-stages">
                {pack.stages.map((s, idx) => {
                    // Highlight the stage that's about to play (== the one
                    // right after the last completed stage). Clicking a chip
                    // jumps the session to that stage. Mock has no real
                    // cluster deps so any jump is fine; test/live only allow
                    // jumping up to the furthest stage actually reached
                    // (the cluster has no state for stages never played).
                    const isCurrent = s.name === activeStageName;
                    const blocked = mode === 'mock' ? false : idx > highWaterIdx;
                    // Only mark hpoc-only stages red when the engine would
                    // actually skip them (clusterProfile=other on test/live).
                    // Mock ignores the profile filter (every stage is reachable
                    // against fixtures), so red would be misleading there.
                    const hpocOnlyFiltered = s.impact === 'hpoc-only'
                      && pack.clusterProfile === 'other'
                      && mode !== 'mock';
                    const cls = [
                      'devpanel-stage',
                      isCurrent && 'devpanel-stage-current',
                      blocked && 'devpanel-stage-forward',
                      !s.active && 'devpanel-stage-inactive',
                      hpocOnlyFiltered && 'devpanel-stage-destructive',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <button
                        key={s.name}
                        type="button"
                        className={cls}
                        onClick={() => onGoto(s.name)}
                        disabled={busy || blocked}
                        title={[
                          s.name,
                          blocked ? 'not reached yet (test mode)' : null,
                          hpocOnlyFiltered
                            ? `hpoc-only (filtered on clusterProfile='${pack.clusterProfile}')`
                            : null,
                          s.requires.length ? `requires: ${s.requires.join(', ')}` : null,
                          !s.active ? 'inactive' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      >
                        {s.name}
                      </button>
                    );
                  })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
