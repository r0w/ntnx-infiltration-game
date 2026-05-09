import { useEffect, useState } from 'react';
import { api, type PackInfo } from './api';
import { awaitingLabel } from './useSession';

export interface DevPanelProps {
  sessionId: string | null;
  /** Canonical name of the last completed stage; `null` = pre-game. */
  currentStage: string | null;
  awaitingVariable: string | null;
  busy: boolean;
  /** Auto-play toggle state — surfaced as a small badge in the panel
   *  toggle so operators see at a glance whether the next prompt will
   *  auto-submit or wait for them. */
  autoPlay?: boolean;
  /** True while the auto-play harness is making a request (autofill or
   *  act). Surface it visibly so silent stages don't look like the UI
   *  is wedged. */
  autoPlayActing?: boolean;
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
  mode,
  onGoto,
}: DevPanelProps) {
  const [pack, setPack] = useState<PackInfo | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className={`devpanel ${open ? 'devpanel-open' : ''}`}>
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
        {autoPlay && (
          <span
            className={`devpanel-autoplay ${autoPlayActing ? 'devpanel-autoplay-acting' : ''}`}
            title={
              autoPlayActing
                ? 'Auto-play is making a request (autofill / act)'
                : 'Auto-play armed — next CONTINUE prompts will auto-submit'
            }
          >
            {autoPlayActing ? 'AUTOPLAY ⏳' : 'AUTOPLAY'}
          </span>
        )}
        {' · '}
        {activeStageName ?? currentStage ?? 'pre-game'}
        {awaitingVariable ? ` · awaiting ${awaitingLabel(awaitingVariable)}` : ''}
      </button>
      {open && (
        <div className="devpanel-body">
          {error && <div className="devpanel-error">{error}</div>}
          {!pack && !error && <div className="c-dim">loading pack…</div>}
          {pack && (
            <>
              <div className="devpanel-legend">
                <strong>{pack.name}</strong> · click a stage to <em>jump back</em>
                {' '}(forward jumps are disabled to prevent skipping cluster-side
                state). Captured variables &amp; UUIDs are kept.
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
                {(() => {
                  const activeIdx = activeStageName
                    ? pack.stages.findIndex((s) => s.name === activeStageName)
                    : 0;
                  return pack.stages.map((s, idx) => {
                    // Highlight the stage that's about to play (== the one
                    // right after the last completed stage). Clicking a chip
                    // jumps the session BACK to that stage's name. Forward
                    // jumps disabled — skipping past a stage leaves cluster
                    // state in an undefined shape (e.g. jumping from #5 to
                    // #20 means VM/category/etc. were never created and
                    // every downstream check fails).
                    const isCurrent = s.name === activeStageName;
                    const isForward = idx > activeIdx;
                    // Only mark destructive stages red when the engine
                    // would actually skip them (clusterProfile=other).
                    // On hpoc those stages play normally and red is just
                    // visual noise.
                    const destructiveFiltered = s.impact === 'destructive'
                      && pack.clusterProfile === 'other';
                    const cls = [
                      'devpanel-stage',
                      isCurrent && 'devpanel-stage-current',
                      isForward && 'devpanel-stage-forward',
                      !s.active && 'devpanel-stage-inactive',
                      destructiveFiltered && 'devpanel-stage-destructive',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <button
                        key={s.name}
                        type="button"
                        className={cls}
                        onClick={() => onGoto(s.name)}
                        disabled={busy || isForward}
                        title={[
                          s.name,
                          isForward ? 'forward jump disabled' : null,
                          destructiveFiltered
                            ? `destructive (filtered on clusterProfile='${pack.clusterProfile}')`
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
                  });
                })()}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
