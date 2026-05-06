import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api, ApiError, type PackInfo } from './api';
import { DevPanel } from './DevPanel';
import { FauxTerminal } from './FauxTerminal';
import { LoginForm } from './LoginForm';
import { ConfirmModal } from './Modal';
import { useSession } from './useSession';

type MaxWidth = '80ch' | '100ch' | '120ch' | 'none';
const MAX_WIDTH_KEY = 'terminal-max-width';
const MAX_WIDTH_OPTIONS: MaxWidth[] = ['80ch', '100ch', '120ch', 'none'];

function readStoredMaxWidth(): MaxWidth {
  try {
    const v = localStorage.getItem(MAX_WIDTH_KEY);
    if (v && (MAX_WIDTH_OPTIONS as string[]).includes(v)) return v as MaxWidth;
  } catch { /* localStorage blocked — fall through to default */ }
  return 'none';
}

export function GameApp() {
  const session = useSession();
  const [pack, setPack] = useState<PackInfo | null>(null);
  const [maxWidth, setMaxWidth] = useState<MaxWidth>(readStoredMaxWidth);
  const [autoPlay, setAutoPlay] = useState(false);
  const [autoPlayActing, setAutoPlayActing] = useState(false);
  const [autoPlayError, setAutoPlayError] = useState<string | null>(null);
  const [logoutPrompt, setLogoutPrompt] = useState(false);
  const awaitingRef = session.awaitingVariable;
  const submitInput = session.submitInput;
  const advance = session.advance;
  const gotoStage = session.gotoStage;

  useEffect(() => {
    try { localStorage.setItem(MAX_WIDTH_KEY, maxWidth); } catch { /* ignore */ }
  }, [maxWidth]);

  useEffect(() => {
    document.title = 'ntnx infiltration game';
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.pack().then(
      (p) => { if (!cancelled) setPack(p); },
      () => { /* keep pack null; LoginForm falls back to 'en' */ },
    );
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = useCallback(
    (v: string) => {
      if (awaitingRef) void submitInput(awaitingRef, v);
    },
    [awaitingRef, submitInput],
  );
  const handleAdvance = useCallback(() => void advance(), [advance]);

  // Auto-play "Ok" handler. In `test` mode, fire the awaiting stage's act
  // first (= the cluster-side step the player would normally do via Prism)
  // and only submit "Ok" once it succeeds — otherwise the check would run
  // against a missing resource and fail. In `mock` we skip the act (no
  // POST fixtures) and just submit; the GET fixtures already simulate the
  // post-act state. Act errors disarm autoplay so we don't loop on a
  // broken stage. 404 (no act registered) is expected for narrative-only
  // stages — submit "Ok" anyway, there's no cluster work to do.
  const handleAutoPlayOk = useCallback(async () => {
    if (!session.sessionId || !awaitingRef) return;
    // Named-var prompts that auto-fill from the cluster (NodeSerial,
    // NumberUpdates, Runway) — short-circuit the act path: just hit
    // /auto-fill-current and submit the returned value. No "Ok" submit,
    // no act fire.
    const AUTOFILLABLE = new Set(['NodeSerial', 'NumberUpdates', 'Runway']);
    if (pack?.mode === 'test' && AUTOFILLABLE.has(awaitingRef)) {
      setAutoPlayActing(true);
      try {
        const r = await api.autoFillCurrent(session.sessionId);
        if (!r.ok || !r.value) {
          throw new Error(r.error ?? `auto-fill failed for ${awaitingRef}`);
        }
        setAutoPlayError(null);
        void submitInput(awaitingRef, r.value);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setAutoPlay(false);
        setAutoPlayError(`auto-play autofill @ ${awaitingRef}: ${msg}`);
      } finally {
        setAutoPlayActing(false);
      }
      return;
    }
    if (pack?.mode === 'test' && session.awaitingStageName) {
      setAutoPlayActing(true);
      try {
        const r = await api.actCurrent(session.sessionId);
        if (!r.ok) {
          throw new Error(r.error ?? `act failed for ${r.stageName}`);
        }
        setAutoPlayError(null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Two distinct 404s come back as `404 ...`:
        //   1. "404 no act registered for stage X" — narrative-only stage,
        //      expected, submit "Ok" anyway since there's no cluster work.
        //   2. "404 Not Found" / "404 statusText" — the endpoint itself is
        //      missing (backend didn't restart after the auto-play patch).
        //      Submitting "Ok" blindly would let the check run against a
        //      missing resource — exactly the bug we're trying to fix —
        //      so disarm and tell the operator to restart.
        const isNoActFor = /^404\s.*no act registered/i.test(msg);
        const isEndpointMissing =
          /^404\s.*not found$/i.test(msg) || msg === '404 Not Found';
        if (isEndpointMissing) {
          setAutoPlay(false);
          setAutoPlayError(
            'auto-play: /act-current endpoint missing — restart the backend ' +
              '(Bun caches routes at boot; the rename to /act-current needs a fresh start).',
          );
          return;
        }
        if (!isNoActFor) {
          setAutoPlay(false);
          // Backend tags transport errors (PC unreachable — usually VPN
          // down) so we can show an actionable banner instead of just
          // dumping "fetch failed" on the operator.
          const isTransport =
            err instanceof ApiError && err.body?.transportError === true;
          const code =
            err instanceof ApiError && typeof err.body?.transportCode === 'string'
              ? (err.body.transportCode as string)
              : null;
          if (isTransport) {
            setAutoPlayError(
              `cannot reach Prism Central${code ? ` [${code}]` : ''}`,
            );
          } else {
            setAutoPlayError(`auto-play act @ ${session.awaitingStageName}: ${msg}`);
          }
          return;
        }
      } finally {
        setAutoPlayActing(false);
      }
    }
    void submitInput(awaitingRef, 'Ok');
  }, [session.sessionId, session.awaitingStageName, awaitingRef, pack?.mode, submitInput]);
  const handleGoto = useCallback((stageName: string) => void gotoStage(stageName), [gotoStage]);
  const handleSwitchIdentity = useCallback(
    () => void session.switchIdentity(),
    [session],
  );

  // Identity capture lives in the `login` stage. Once it passes, currentStage
  // flips past it and the ↓ shortcut should retire — otherwise it'd wipe the
  // player's progress mid-game. Pre-game (null) and the lore prelude both
  // qualify as "still in identity capture."
  const inIdentityCapture =
    !session.finished &&
    (session.currentStage === null || session.currentStage === 'lore');

  // Auto-play eligibility: the toggle only appears once the player has typed
  // their Trigram + PIN (login) and Username (intro-ego-greet). currentStage
  // tracks the last completed stage, so it lands on `intro-ego-greet` exactly
  // when Username has just been captured. Also gated on `mode !== 'live'` —
  // production demos should never let the operator skip a stage with one
  // click. Defaults to **hidden** until the pack loads so live mode never
  // flashes the panel during the boot fetch.
  const devToolsAllowed = pack !== null && pack.mode !== 'live';
  const identityCaptured =
    session.currentStage !== null &&
    !['lore', 'login', 'recovery-gate'].includes(session.currentStage);
  const autoPlayVisible = devToolsAllowed && identityCaptured;

  // Force autoplay off whenever the toggle isn't visible — mode flipped to
  // live, identity reset (logout / switch agent), etc. should never leave a
  // stale "armed" state behind.
  useEffect(() => {
    if (!autoPlayVisible && autoPlay) setAutoPlay(false);
  }, [autoPlayVisible, autoPlay]);

  const handleLogout = useCallback(() => {
    setLogoutPrompt(false);
    session.reset();
  }, [session]);

  if (!session.sessionId) {
    return (
      <LoginForm
        busy={session.busy}
        error={session.error}
        defaultLocale={pack?.defaultLocale ?? 'en'}
        supportedLocales={pack?.supportedLocales ?? ['en']}
        onSubmit={session.createSession}
      />
    );
  }

  const appStyle = { '--terminal-max-width': maxWidth } as CSSProperties;

  return (
    <div className="app" style={appStyle}>
      <header className="app-header">
        <div className="app-header-side app-header-left">
          <span className="app-title">ntnx infiltration game</span>
        </div>
        <div className="app-header-center">
          {autoPlayVisible && (
            <AutoPlayToggle
              active={autoPlay}
              onToggle={() => setAutoPlay((v) => !v)}
            />
          )}
        </div>
        <div className="app-header-side app-header-right">
          <WidthToggle value={maxWidth} onChange={setMaxWidth} />
          <button
            className="app-reset"
            onClick={() => setLogoutPrompt(true)}
            type="button"
          >
            logout
          </button>
        </div>
      </header>
      <FauxTerminal
        items={session.items}
        awaitingVariable={session.awaitingVariable}
        busy={session.busy || autoPlayActing}
        checkPending={session.checkPending}
        finished={session.finished}
        typingSpeedMs={session.typingSpeedMs}
        gatedAt={session.gatedAt}
        locale={session.locale}
        autoPlay={autoPlay}
        onSubmit={handleSubmit}
        onAutoPlayOk={handleAutoPlayOk}
        onAdvance={handleAdvance}
        onSwitchIdentity={inIdentityCapture ? handleSwitchIdentity : undefined}
      />
      {session.error && <div className="app-error">{session.error}</div>}
      {autoPlayError && <div className="app-error">{autoPlayError}</div>}
      {devToolsAllowed && (
        <DevPanel
          sessionId={session.sessionId}
          currentStage={session.currentStage}
          awaitingVariable={session.awaitingVariable}
          busy={session.busy}
          autoPlay={autoPlay}
          mode={pack?.mode === 'live' ? undefined : pack?.mode}
          onGoto={handleGoto}
        />
      )}
      {logoutPrompt && (
        <ConfirmModal
          title={<><span className="c-yellow">!</span> log out?</>}
          danger
          confirmLabel="log out"
          cancelLabel="stay"
          onCancel={() => setLogoutPrompt(false)}
          onConfirm={handleLogout}
        >
          <p className="c-dim">
            sign back in with the same trigram + PIN to resume.
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}

function WidthToggle({
  value,
  onChange,
}: {
  value: MaxWidth;
  onChange: (w: MaxWidth) => void;
}) {
  const labels: Record<MaxWidth, string> = {
    '80ch': '80',
    '100ch': '100',
    '120ch': '120',
    none: '∞',
  };
  return (
    <div className="width-toggle" role="group" aria-label="Terminal width">
      <WidthIcon />
      {MAX_WIDTH_OPTIONS.map((opt) => (
        <button
          key={opt}
          type="button"
          className={`width-toggle-btn${value === opt ? ' is-active' : ''}`}
          onClick={() => onChange(opt)}
          aria-pressed={value === opt}
          title={opt === 'none' ? 'Full width' : `${labels[opt]} characters`}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  );
}

// Auto-play toggle: when armed, FauxTerminal auto-submits "Ok" on every
// `<input/>` (CONTINUE_VAR) prompt so the demo can roll through every stage
// without the operator typing. Named-var prompts (NodeSerial, NumberUpdates,
// Runway, …) still wait for a real value — the toggle only short-circuits
// the press-enter-to-continue gates.
function AutoPlayToggle({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`app-autoplay${active ? ' is-active' : ''}`}
      onClick={onToggle}
      aria-pressed={active}
      title={
        active
          ? 'Auto-play armed — disarm to type "Ok" yourself'
          : 'Auto-play: submit "Ok" on every press-enter prompt'
      }
    >
      <span className="app-autoplay-icon" aria-hidden="true">
        {active ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 5 L19 12 L7 19 Z" />
          </svg>
        )}
      </span>
      <span>{active ? 'auto-play on' : 'auto-play'}</span>
    </button>
  );
}

// Horizontal double-headed arrow = universal "width" glyph. Span wrapper
// carries the layout styling (flex centering, padding, divider), the SVG
// is pure pictogram with `display: block` so it doesn't inherit inline
// baseline weirdness. Inline SVG by choice — switch to lucide-react if
// the icon count grows past 3.
function WidthIcon() {
  return (
    <span className="width-toggle-icon" aria-hidden="true">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 12 L21 12" />
        <path d="M7 8 L3 12 L7 16" />
        <path d="M17 8 L21 12 L17 16" />
      </svg>
    </span>
  );
}
