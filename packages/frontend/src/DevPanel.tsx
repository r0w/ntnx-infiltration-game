import { useEffect, useState } from 'react';
import { api, type PackInfo } from './api';
import { awaitingLabel } from './useSession';

// Slowest the speed slider goes (ms/char). Slider right edge = 0 = instant.
const SPEED_MAX_MS = 50;

export interface DevPanelProps {
  sessionId: string | null;
  /** Canonical name of the last completed stage; `null` = pre-game. */
  currentStage: string | null;
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
  /** Sets a speed override (ms/char). 0 = instant. */
  onTypingSpeedChange?: (ms: number) => void;
  /**
   * Server mode (`mock` | `test`). Surfaced in the toggle label so the
   * operator knows at a glance which adapter the session is hitting —
   * mistaking `mock` for `test` was the failure mode that made auto-play
   * look broken (mock has no POST fixtures, so seeds can't really fire).
   * `live` mode hides the panel entirely so the prop is intentionally
   * narrowed.
   */
  mode?: 'mock' | 'test';
  onGoto: (stageName: string) => void;
}

export function DevPanel({
  sessionId,
  currentStage,
  awaitingVariable,
  busy,
  autoPlay,
  autoPlayActing,
  autoPlayEligible,
  onToggleAutoPlay,
  typingSpeedMs,
  onTypingSpeedChange,
  mode,
  onGoto,
}: DevPanelProps) {
  const [pack, setPack] = useState<PackInfo | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Furthest stage actually reached this session. The server forgets it
  // (a backward goto truncates history), so we track it client-side to know
  // how far forward `test` mode may safely jump (cluster state exists there).
  const [highWaterIdx, setHighWaterIdx] = useState(0);

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

  // Pack-registered actions are a property of the pack, but the endpoint
  // lives under /session/:id/actions for URL symmetry — only fetch when we
  // actually have a session id to pass. Skip in non-mock modes since the
  // action UI is hidden there anyway (real cluster, no mock overlay to
  // simulate against).
  useEffect(() => {
    if (!sessionId || mode !== 'mock') return;
    let cancelled = false;
    void api
      .listActions(sessionId)
      .then((r) => {
        if (!cancelled) setActions(r.names);
      })
      .catch(() => {
        /* silent — dev-only, skip surfacing in the UI */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, mode]);

  const handleFire = async (name: string) => {
    if (!sessionId || actionBusy) return;
    setActionBusy(name);
    setActionMsg(null);
    try {
      await api.fireAction(sessionId, name);
      setActionMsg(`fired ${name}`);
    } catch (err) {
      setActionMsg(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionBusy(null);
    }
  };

  // Active/playing stage name = the one immediately after `currentStage` in
  // the pack order. Pack stages are already in play order from the server.
  // Pre-game (currentStage === null) → the first stage is the one about to
  // play; otherwise → the stage right after the last completed one.
  const activeStageName: string | null = pack
    ? (currentStage === null
        ? pack.stages[0]?.name ?? null
        : pack.stages[
            Math.min(
              pack.stages.findIndex((s) => s.name === currentStage) + 1,
              pack.stages.length - 1,
            )
          ]?.name ?? null)
    : null;

  const activeIdx = activeStageName && pack
    ? pack.stages.findIndex((s) => s.name === activeStageName)
    : 0;
  useEffect(() => {
    setHighWaterIdx((hw) => (activeIdx > hw ? activeIdx : hw));
  }, [activeIdx]);

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
        {onTypingSpeedChange && typeof typingSpeedMs === 'number' && (
          <label
            className="devpanel-speed"
            title="Typewriter speed — drag right to skip the effect"
          >
            <span>speed</span>
            <input
              type="range"
              min={0}
              max={SPEED_MAX_MS}
              step={1}
              // Slider value is inverted so right = fast (low ms).
              value={SPEED_MAX_MS - Math.min(typingSpeedMs, SPEED_MAX_MS)}
              onChange={(e) => onTypingSpeedChange(SPEED_MAX_MS - Number(e.target.value))}
            />
            <span className="devpanel-speed-val">
              {typingSpeedMs === 0 ? 'instant' : `${typingSpeedMs}ms`}
            </span>
          </label>
        )}
        {autoPlayEligible && onToggleAutoPlay && (
          <button
            type="button"
            className={`devpanel-autoplay-toggle${autoPlay ? ' is-active' : ''}${
              autoPlayActing ? ' is-acting' : ''
            }`}
            onClick={onToggleAutoPlay}
            aria-pressed={autoPlay}
            title={
              autoPlay
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
                <strong>{pack.name}</strong> · click a stage to <em>jump</em> there.
                {' '}{mode === 'mock'
                  ? 'Any stage — mock has no real cluster deps.'
                  : 'Forward only up to the furthest stage you reached (test cluster has no state beyond it).'}
                {' '}Captured variables &amp; UUIDs are kept.
              </div>
              {/* Actions only make sense in mock mode — they simulate a
                  cluster side-effect via the mock overlay. In `test` the
                  cluster is real, so use the auto-play seeds (which run
                  the actual cluster mutation) instead of these buttons. */}
              {mode === 'mock' && actions.length > 0 && (
                <div className="devpanel-actions">
                  <div className="devpanel-legend">
                    <strong>Actions</strong> · fire a registered mock-mode action (simulates
                    a cluster side-effect — e.g. <code>restoreVM</code> unblocks stage 26
                    after <code>deleteVM</code> fired on stage 23).
                  </div>
                  <div className="devpanel-action-list">
                    {actions.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="devpanel-action"
                        onClick={() => void handleFire(name)}
                        disabled={!sessionId || actionBusy !== null}
                      >
                        {actionBusy === name ? '…' : '▶'} {name}
                      </button>
                    ))}
                  </div>
                  {actionMsg && <div className="devpanel-action-msg c-dim">{actionMsg}</div>}
                </div>
              )}
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
                    // Only mark hpoc-only stages red when the engine
                    // would actually skip them (clusterProfile=other).
                    // On hpoc those stages play normally and red is just
                    // visual noise.
                    const hpocOnlyFiltered = s.impact === 'hpoc-only'
                      && pack.clusterProfile === 'other';
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
