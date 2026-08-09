import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { MessageUnit } from '@ntnx-game/shared';
import { api, ApiError, type PackInfo, type PackNavChapter } from './api';
import { DevPanel } from './DevPanel';
import { FauxTerminal } from './FauxTerminal';
import { StageRail } from './StageRail';
import { StageReader } from './StageReader';
import { LightboxProvider } from './Lightbox';
import { LoginForm } from './LoginForm';
import { ConfirmModal } from './Modal';
import { useSession, CONTINUE_VAR, AUTOFILLABLE_VARS } from './useSession';

type MaxWidth = '80ch' | '100ch' | '120ch' | 'none';
const MAX_WIDTH_KEY = 'terminal-max-width';
const MAX_WIDTH_OPTIONS: MaxWidth[] = ['80ch', '100ch', '120ch', 'none'];

function readStoredMaxWidth(): MaxWidth {
  try {
    const v = localStorage.getItem(MAX_WIDTH_KEY);
    if (v && (MAX_WIDTH_OPTIONS as string[]).includes(v)) return v as MaxWidth;
  } catch { /* localStorage blocked — fall through to default */ }
  return '120ch';
}

// Dev override for the typewriter speed (ms/char). null = use the server's
// pack value. Lets the operator speed up / skip the effect on the 20th replay.
const TYPING_SPEED_KEY = 'terminal-typing-speed';

function readStoredTypingSpeed(): number | null {
  try {
    const v = localStorage.getItem(TYPING_SPEED_KEY);
    if (v !== null && v !== '') {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch { /* localStorage blocked */ }
  return null;
}

// Dev toggle: skip <pause/> beats + check-result dwells (independent of
// text speed) for fast replays.
const SKIP_PAUSES_KEY = 'terminal-skip-pauses';

function readStoredSkipPauses(): boolean {
  try { return localStorage.getItem(SKIP_PAUSES_KEY) === '1'; } catch { return false; }
}

/**
 * Where the player is in the run, for the reading menu.
 *
 * The session reports two different things and neither is "where I am" on its
 * own: `currentStage` is the last stage *completed*, and `awaitingStageName`
 * is set only while a prompt is on screen. Parked at a prompt the second one
 * is the answer; mid-stream it is null and the answer is one past the first.
 */
export function readerPosition(
  order: string[],
  currentStage: string | null,
  awaitingStageName: string | null,
  finished: boolean,
): { index: number; stage: string | null } {
  if (finished) return { index: order.length, stage: null };
  if (awaitingStageName) {
    const i = order.indexOf(awaitingStageName);
    if (i >= 0) return { index: i, stage: awaitingStageName };
  }
  if (currentStage === null) return { index: 0, stage: order[0] ?? null };
  const done = order.indexOf(currentStage);
  if (done < 0) return { index: 0, stage: order[0] ?? null };
  const next = done + 1;
  return { index: next, stage: order[next] ?? null };
}

/** A step opened from the contents menu, while its text is on its way. */
interface ReadingState {
  stage: string;
  title: string;
  units: MessageUnit[];
  loading: boolean;
  error: string | null;
}

export function GameApp() {
  const session = useSession();
  const [pack, setPack] = useState<PackInfo | null>(null);
  const [maxWidth, setMaxWidth] = useState<MaxWidth>(readStoredMaxWidth);
  const [typingSpeedOverride, setTypingSpeedOverride] = useState<number | null>(
    readStoredTypingSpeed,
  );
  const [skipPauses, setSkipPauses] = useState<boolean>(readStoredSkipPauses);
  const [autoPlay, setAutoPlay] = useState(false);
  const [autoPlayActing, setAutoPlayActing] = useState(false);
  const [autoPlayError, setAutoPlayError] = useState<string | null>(null);
  const [logoutPrompt, setLogoutPrompt] = useState(false);
  const [nav, setNav] = useState<PackNavChapter[]>([]);
  const [reading, setReading] = useState<ReadingState | null>(null);
  const awaitingRef = session.awaitingVariable;
  const submitInput = session.submitInput;
  const advance = session.advance;
  const gotoStage = session.gotoStage;

  useEffect(() => {
    try { localStorage.setItem(MAX_WIDTH_KEY, maxWidth); } catch { /* ignore */ }
  }, [maxWidth]);

  useEffect(() => {
    try {
      if (typingSpeedOverride === null) localStorage.removeItem(TYPING_SPEED_KEY);
      else localStorage.setItem(TYPING_SPEED_KEY, String(typingSpeedOverride));
    } catch { /* ignore */ }
  }, [typingSpeedOverride]);

  useEffect(() => {
    try { localStorage.setItem(SKIP_PAUSES_KEY, skipPauses ? '1' : '0'); } catch { /* ignore */ }
  }, [skipPauses]);

  // null override → follow the server's pack speed.
  const typingSpeedMs = typingSpeedOverride ?? session.typingSpeedMs;

  // Re-read a step. The server re-renders it from the pack; nothing about the
  // run moves, so this is safe to fire mid-stage.
  const sessionId = session.sessionId;
  const closeReader = useCallback(() => setReading(null), []);
  const handleRead = useCallback(
    (stage: string, title: string) => {
      if (!sessionId) return;
      setReading({ stage, title, units: [], loading: true, error: null });
      api.readStage(sessionId, stage).then(
        (r) => setReading((cur) => (cur?.stage === stage ? { ...cur, units: r.units, loading: false } : cur)),
        (err: unknown) =>
          setReading((cur) =>
            cur?.stage === stage
              ? { ...cur, loading: false, error: err instanceof Error ? err.message : String(err) }
              : cur,
          ),
      );
    },
    [sessionId],
  );

  // The pack names the game, so a second pack is not branded as the first.
  const gameTitle = pack?.title ?? 'ntnx infiltration game';

  useEffect(() => {
    document.title = gameTitle;
  }, [gameTitle]);

  useEffect(() => {
    let cancelled = false;
    api.pack().then(
      (p) => { if (!cancelled) setPack(p); },
      () => { /* keep pack null; LoginForm falls back to 'en' */ },
    );
    return () => { cancelled = true; };
  }, []);

  // The reading menu. Session-scoped because its titles are translated, so it
  // is refetched when the player signs in again in another language.
  useEffect(() => {
    if (!session.sessionId) {
      setNav([]);
      return;
    }
    let cancelled = false;
    api.nav(session.sessionId).then(
      (p) => { if (!cancelled) setNav(p.chapters); },
      () => { /* no menu is a fine outcome — the terminal is the game */ },
    );
    return () => { cancelled = true; };
  }, [session.sessionId, session.locale]);

  const handleSubmit = useCallback(
    (v: string) => {
      if (awaitingRef) void submitInput(awaitingRef, v);
    },
    [awaitingRef, submitInput],
  );
  const handleAdvance = useCallback(() => void advance(), [advance]);

  // Auto-play continue handler. In `test` mode, fire the awaiting stage's act
  // first (= the cluster-side step the player would normally do via Prism)
  // and only press Enter once it succeeds — otherwise the check would run
  // against a missing resource and fail. In `mock` we skip the act (no
  // POST fixtures) and just advance; the GET fixtures already simulate the
  // post-act state. Act errors disarm autoplay so we don't loop on a
  // broken stage. 404 (no act registered) is expected for narrative-only
  // stages — press Enter anyway, there's no cluster work to do.
  const handleAutoPlayOk = useCallback(async () => {
    if (!session.sessionId || !awaitingRef) return;
    // Named-var prompts that auto-fill from the cluster (NodeSerial,
    // NumberUpdates, Runway) — short-circuit the act path: just hit
    // /auto-fill-current and submit the returned value. No "Ok" submit,
    // no act fire. Enabled in both `test` (live PC lookup) and `mock`
    // (fixtures / canned values) — the backend serves both; only `live`
    // keeps auto-fill off so demos don't skip steps in front of an audience.
    if ((pack?.mode === 'test' || pack?.mode === 'mock') && AUTOFILLABLE_VARS.has(awaitingRef)) {
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
    // Continue prompts now advance on a bare Enter (no waitForInputValue),
    // so auto-play submits empty — same as the player pressing Enter.
    void submitInput(awaitingRef, awaitingRef === CONTINUE_VAR ? '' : 'Ok');
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
  // their Trigram + PIN (login) and Username (intro-tank-greet). currentStage
  // tracks the last completed stage, so it lands on `intro-tank-greet` exactly
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
        wipLocales={pack?.wipLocales ?? []}
        title={gameTitle}
        onSubmit={session.createSession}
      />
    );
  }

  const appStyle = { '--terminal-max-width': maxWidth } as CSSProperties;
  const stageOrder = pack?.stages.map((s) => s.name) ?? [];
  const position = readerPosition(
    stageOrder,
    session.currentStage,
    session.awaitingStageName,
    session.finished,
  );

  return (
    <LightboxProvider>
    <div className="app" style={appStyle}>
      <header className="app-header">
        <div className="app-header-side app-header-left">
          <span className="app-title">{gameTitle}</span>
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
      <div className="app-body">
      {nav.length > 0 && (
        <StageRail
          chapters={nav}
          currentIndex={position.index}
          activeStage={position.stage}
          onRead={handleRead}
        />
      )}
      <FauxTerminal
        items={session.items}
        awaitingVariable={session.awaitingVariable}
        busy={session.busy || autoPlayActing}
        checkPending={session.checkPending}
        finished={session.finished}
        typingSpeedMs={typingSpeedMs}
        skipPauses={skipPauses}
        imageCaptions={pack?.imageCaptions ?? false}
        gatedAt={session.gatedAt}
        locale={session.locale}
        autoPlay={autoPlay}
        onSubmit={handleSubmit}
        onAutoPlayOk={handleAutoPlayOk}
        onAdvance={handleAdvance}
        onSwitchIdentity={inIdentityCapture ? handleSwitchIdentity : undefined}
        identityLabel={pack?.identity?.label}
      />
      </div>
      {session.error && <div className="app-error">{session.error}</div>}
      {autoPlayError && <div className="app-error">{autoPlayError}</div>}
      {devToolsAllowed && (
        <DevPanel
          sessionId={session.sessionId}
          currentStage={session.currentStage}
          awaitingStageName={session.awaitingStageName}
          awaitingVariable={session.awaitingVariable}
          busy={session.busy}
          autoPlay={autoPlay}
          autoPlayActing={autoPlayActing}
          autoPlayEligible={autoPlayVisible}
          onToggleAutoPlay={() => setAutoPlay((v) => !v)}
          typingSpeedMs={typingSpeedMs}
          typingSpeedDefaultMs={session.typingSpeedMs}
          onTypingSpeedChange={setTypingSpeedOverride}
          onTypingSpeedReset={() => setTypingSpeedOverride(null)}
          skipPauses={skipPauses}
          onSkipPausesChange={setSkipPauses}
          mode={pack?.mode === 'live' ? undefined : pack?.mode}
          onGoto={handleGoto}
        />
      )}
      {reading && (
        <StageReader
          title={reading.title}
          units={reading.units}
          loading={reading.loading}
          error={reading.error}
          onClose={closeReader}
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
    </LightboxProvider>
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
