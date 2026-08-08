import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageUnit } from '@ntnx-game/shared';
import { api, type AdvanceResponse, type DisabledStage } from './api';
import { VERIFYING_LABELS } from './renderer';

/** Sentinel variable name emitted by `<input/>` — press-Enter-to-continue. */
export const CONTINUE_VAR = '$continue';

/**
 * Named-var prompts whose answer is a cluster fact the server can look up
 * via `/auto-fill-current` (in `mock`/`test`). Shared so FauxTerminal (which
 * decides to fire `onAutoPlayOk`) and GameApp (which decides to auto-fill vs
 * submit "Ok") never drift — that drift is what broke mock auto-play once.
 */
export const AUTOFILLABLE_VARS: ReadonlySet<string> = new Set([
  'NodeSerial',
  'NumberUpdates',
  'Runway',
]);

/** Floor for the "verifying…" beat so even an instant mock check reads as real.
 *  Real latency counts toward it; "skip pauses" zeroes it in the renderer. */
const VERIFY_FLOOR_MIN_MS = 800;
const VERIFY_FLOOR_MAX_MS = 1800;

/** Dwell left after `latencyMs` of real check already showed as a spinner. */
function verifyDwellMs(latencyMs: number): number {
  const target = VERIFY_FLOOR_MIN_MS + Math.random() * (VERIFY_FLOOR_MAX_MS - VERIFY_FLOOR_MIN_MS);
  return Math.max(0, Math.round(target - latencyMs));
}

/** Human-readable label for a pending await-input prompt. */
export function awaitingLabel(variable: string | null | undefined): string {
  if (!variable) return '';
  return variable === CONTINUE_VAR ? 'press Enter to continue' : variable;
}

/**
 * Render a skipped-stage info line. Each gate reason gets a distinct message
 * so the player knows whether to check the cluster (capabilities), the
 * profile (destructive stages), or their session data (upstream vars — most
 * often a sign that a /goto jump bypassed an `<input/>` capture).
 */
export function describeDisabled(d: DisabledStage): string {
  switch (d.reason) {
    case 'missing-capability': {
      const caps = d.missing.join(', ') || 'a capability';
      return `[stage ${d.name} skipped: requires ${caps} (not available on this cluster)]`;
    }
    case 'destructive-on-other':
      return `[stage ${d.name} skipped: hpoc-only stage disabled on shared cluster]`;
    case 'missing-upstream': {
      const vars = d.missingVars.join(', ') || 'upstream data';
      return `[stage ${d.name} skipped: missing upstream var ${vars}]`;
    }
  }
}

export type RenderItem =
  | { kind: 'text'; id: string; color?: string; styles?: string[]; text: string; href?: string }
  | { kind: 'pause'; id: string; ms: number }
  | { kind: 'await-input'; id: string; variable: string }
  | { kind: 'code'; id: string; text: string; lang?: string }
  | { kind: 'image'; id: string; src: string; alt?: string }
  | { kind: 'demo'; id: string; src: string; poster?: string; label?: string }
  | { kind: 'page-break'; id: string }
  | { kind: 'check-dwell'; id: string; ms: number; label: string }
  | { kind: 'check-result'; id: string; pass: boolean; neutral?: boolean; detail?: string; hint?: string; cheer?: string }
  | { kind: 'finished'; id: string }
  | { kind: 'info'; id: string; text: string; color?: string };

export interface GatedAt {
  /**
   * Name of the stage the player is parked on, or `null` when the pause is
   * a pack-wide lunch lock (no specific stage).
   */
  stageName: string | null;
  /** 'stage' = per-stage adminGate; 'global' = pack-wide pause (lunch). */
  reason: 'stage' | 'global';
}

export interface SessionHandle {
  sessionId: string | null;
  items: RenderItem[];
  awaitingVariable: string | null;
  /**
   * Canonical name of the stage owning the pending `<input/>`. Differs from
   * `currentStage` (which tracks the *last completed* stage): when the
   * player is parked at an input mid-stage, `currentStage` still names the
   * previous stage while `awaitingStageName` names the one that emitted
   * the prompt. Used by auto-play to pick the right seed handler.
   */
  awaitingStageName: string | null;
  finished: boolean;
  /**
   * Set when the server returns `kind: 'gated'` — the player's session is
   * parked on a stage marked `adminGate: true` waiting for an operator to
   * unlock from `/admin`. While gated, advance() is suppressed and a 3 s
   * polling loop probes the server until the gate clears.
   */
  gatedAt: GatedAt | null;
  busy: boolean;
  /**
   * True between the moment the player submits an input and the moment the
   * server response lands. The terminal renders a small spinner where the
   * input was so the player has visible "checking…" feedback during the
   * 2–15 s a live cluster check can take.
   */
  checkPending: boolean;
  error: string | null;
  typingSpeedMs: number;
  /** Last completed stage name; `null` = pre-game. */
  currentStage: string | null;
  /** Active session locale (`'en'`/`'fr'`/…) — surface for UI strings
   *  rendered client-side outside the typewriter (e.g. `verifying…`
   *  in FauxTerminal). Defaults to `'en'` until a session is created
   *  or hydrated. */
  locale: string;
  createSession: (opts: { locale: string }) => Promise<void>;
  resume: (sessionId: string) => void;
  advance: () => Promise<void>;
  submitInput: (variable: string, value: string) => Promise<void>;
  gotoStage: (stageName: string) => Promise<void>;
  switchIdentity: () => Promise<void>;
  reset: () => void;
}

const STORAGE_KEY = 'ntnx-infiltration-session';

/** How often the idle player pings the server to confirm the session still
 *  exists. The action paths (advance/submit/hydrate) already drop a deleted
 *  session, but a player parked at an input makes no requests — this catches
 *  an operator-side delete while they sit idle. */
const HEARTBEAT_MS = 5000;

/** Shown on the login screen after the operator deletes the player's session
 *  mid-game. Routed through the existing `error` channel (LoginForm renders it).
 */
const KICK_NOTICE = 'Your session was ended by the operator. Sign in to start a new one.';

export function appendUnits(
  prev: RenderItem[],
  units: MessageUnit[],
  idPrefix: string,
  allowClears: boolean,
): { next: RenderItem[]; awaiting: string | null } {
  let out = [...prev];
  let awaiting: string | null = null;
  units.forEach((u, idx) => {
    const id = `${idPrefix}-${idx}-${out.length}`;
    if (u.kind === 'text') {
      out.push({ kind: 'text', id, color: u.color, styles: u.styles, text: u.text, href: u.href });
    } else if (u.kind === 'await-input') {
      out.push({ kind: 'await-input', id, variable: u.variable });
      awaiting = u.variable;
    } else if (u.kind === 'pause') {
      out.push({ kind: 'pause', id, ms: u.ms });
    } else if (u.kind === 'code') {
      out.push({ kind: 'code', id, text: u.text, lang: u.lang });
    } else if (u.kind === 'image') {
      out.push({ kind: 'image', id, src: u.src, alt: u.alt });
    } else if (u.kind === 'demo') {
      out.push({ kind: 'demo', id, src: u.src, poster: u.poster, label: u.label });
    } else if (u.kind === 'clear') {
      // `<clear/>` is destructive: wipe the scrollback so the next stage
      // starts on a fresh canvas. Gated on `allowClears` — during an
      // auto-advance chain the player hasn't signalled they're done
      // reading, so a wipe would kill text mid-read. The gate flips back
      // on the next input submission.
      if (allowClears) out = [];
    } else if (u.kind === 'page-break') {
      // Non-destructive separator. Always fires — the player can always
      // scroll up to re-read the earlier stages.
      out.push({ kind: 'page-break', id });
    } else {
      // This chain whitelists kinds, so a unit added to the protocol but not
      // here vanishes between the server and the screen with nothing to show
      // for it. Say so instead of dropping it in silence.
      console.warn('[terminal] dropped an unhandled message unit', (u as { kind: string }).kind);
    }
  });
  return { next: out, awaiting };
}

export function useSession(): SessionHandle {
  const [sessionId, setSessionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [items, setItems] = useState<RenderItem[]>([]);
  const [awaitingVariable, setAwaitingVariable] = useState<string | null>(null);
  const [awaitingStageName, setAwaitingStageName] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [gatedAt, setGatedAt] = useState<GatedAt | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkPending, setCheckPending] = useState(false);
  const [locale, setLocale] = useState<string>('en');
  const [error, setError] = useState<string | null>(null);
  const [typingSpeedMs, setTypingSpeedMs] = useState(15);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const advanceCounterRef = useRef(0);
  const inFlightRef = useRef(false);
  const awaitingRef = useRef<string | null>(null);
  const finishedRef = useRef(false);
  const gatedRef = useRef<GatedAt | null>(null);
  // Gate `<clear/>` on whether the player has submitted an input since the
  // last applied clear. During an auto-advance chain between narrative
  // stages, `<clear/>` wipes text the player may still be reading; requiring
  // a fresh user action preserves context until they signal "move on".
  const userActedSinceClearRef = useRef(false);
  // handleResponse closes over `[]` deps, so read the live locale through a
  // ref to label the check-dwell spinner in the player's language.
  const localeRef = useRef(locale);
  awaitingRef.current = awaitingVariable;
  finishedRef.current = finished;
  gatedRef.current = gatedAt;
  localeRef.current = locale;

  const handleResponse = useCallback((r: AdvanceResponse, opts?: { verifyLatencyMs?: number }) => {
    if (r.kind === 'switch-session' && r.switchSessionId) {
      // Server closed the current session and handed us a new sessionId —
      // happens on returning-agent re-auth (trigram collision + PIN match
      // in CheckTrigram). Swap localStorage, tear down in-flight UI state,
      // and let the sessionId-change effect re-hydrate at the other
      // session's currentStage.
      const newId = r.switchSessionId;
      try { localStorage.setItem(STORAGE_KEY, newId); } catch { /* ignore */ }
      hydrated.current = null;
      finishedRef.current = false;
      awaitingRef.current = null;
      setItems([]);
      setAwaitingVariable(null);
      setAwaitingStageName(null);
      setFinished(false);
      setSessionId(newId);
      return;
    }
    if (r.typingSpeedMs && r.typingSpeedMs > 0) setTypingSpeedMs(r.typingSpeedMs);
    if (
      r.stageName &&
      r.kind !== 'awaiting-input' &&
      r.kind !== 'gated' &&
      !r.checkPending && // phase 1: stage hasn't passed yet, check still to come
      r.check?.pass !== false
    ) {
      setCurrentStage(r.stageName);
    }

    if (r.kind === 'gated') {
      // Park the player — only set state, do NOT append to items. The
      // FauxTerminal renders a trailing banner once the typewriter has
      // caught up to items.length, so the "you're paused" message arrives
      // exactly when the prior narrative finishes typing instead of
      // popping in mid-pause. The advance() trigger is suppressed by
      // gatedRef.current; the poll effect below pings the server until
      // the operator unlocks.
      // Keep the object reference stable across poll ticks — the gate poll
      // re-runs handleResponse every 1 s, and a fresh object each time would
      // re-fire FauxTerminal's gate scroll-to-bottom effect, yanking the
      // player back down every second and blocking free scroll while paused.
      const nextStage = r.stageName ?? null;
      const nextReason = r.gatedReason ?? 'stage';
      const prevGate = gatedRef.current;
      if (!prevGate || prevGate.stageName !== nextStage || prevGate.reason !== nextReason) {
        setGatedAt({ stageName: nextStage, reason: nextReason });
      }
      return;
    }
    // Any non-gated response clears a prior gated state so the normal flow
    // resumes (units render, advance() unblocks).
    if (gatedRef.current !== null) setGatedAt(null);

    for (const d of r.disabledStages ?? []) {
      setItems((prev) => [
        ...prev,
        {
          kind: 'info',
          id: `disabled-${d.name}-${advanceCounterRef.current}`,
          text: describeDisabled(d),
          color: 'dim',
        },
      ]);
    }

    const prefix = `s${r.stageName ?? 'x'}-${advanceCounterRef.current++}`;
    const allowClears = userActedSinceClearRef.current;
    setItems((prev) => {
      const { next, awaiting } = appendUnits(prev, r.units, prefix, allowClears);
      // Trust r.awaitingVariable when the server explicitly says we're
      // awaiting input — the response may carry no new units (e.g. a
      // rejected waitForInputValue mismatch) yet the session is still
      // blocked on the same prompt.
      const nextAwaiting =
        r.kind === 'awaiting-input' ? r.awaitingVariable ?? awaiting : awaiting;
      setAwaitingVariable(nextAwaiting ?? null);
      // Track which stage the pending input belongs to. The server names it
      // on `awaiting-input` responses; once awaiting clears (player submits
      // and the stage finalizes), we drop the name too. Used by auto-play
      // to look up the right seed handler.
      if (nextAwaiting && r.kind === 'awaiting-input' && r.stageName) {
        setAwaitingStageName(r.stageName);
      } else if (!nextAwaiting) {
        setAwaitingStageName(null);
      }
      if (r.rejected) {
        // Prefer the warm locale-aware retry sentence when the pack ships
        // `sentences.retry-*`; otherwise fall back to the raw debug hint so
        // dev packs without the bucket still surface the mismatch.
        const retryText = r.rejected.message
          ?? `[expected "${r.rejected.expected}" — try again]`;
        next.push({
          kind: 'info',
          id: `${prefix}-rejected`,
          text: retryText,
          color: 'dim',
        });
      }
      if (r.check) {
        // Floored "verifying…" beat before the verdict (see verifyDwellMs).
        next.push({
          kind: 'check-dwell',
          id: `${prefix}-checkdwell`,
          ms: verifyDwellMs(opts?.verifyLatencyMs ?? 0),
          label: VERIFYING_LABELS[localeRef.current] ?? VERIFYING_LABELS.en,
        });
        next.push({
          kind: 'check-result',
          id: `${prefix}-check`,
          pass: r.check.pass,
          neutral: r.check.neutral,
          detail: r.check.detail,
          hint: r.check.hint,
          cheer: r.check.cheer,
        });
      }
      if (r.kind === 'finished') {
        next.push({ kind: 'finished', id: `${prefix}-fin` });
        setFinished(true);
      }
      return next;
    });
    // If any clear in the response was honoured, consume the user-acted
    // token — the next clear will need a fresh input submission to apply.
    if (allowClears && r.units.some((u) => u.kind === 'clear')) {
      userActedSinceClearRef.current = false;
    }
  }, []);

  // Phase 2: run the parked check behind the verifying spinner, then show the
  // verdict. Shared by inline submit and resume-after-reload so they pace alike.
  const resolveAndApply = useCallback(
    async (id: string) => {
      setCheckPending(true);
      try {
        const t0 = performance.now();
        const verdict = await api.resolveCheck(id);
        handleResponse(verdict, { verifyLatencyMs: performance.now() - t0 });
      } finally {
        setCheckPending(false);
      }
    },
    [handleResponse],
  );

  const createSession = useCallback(
    async ({ locale: createLocale }: { locale: string }) => {
      setError(null);
      setBusy(true);
      try {
        const r = await api.createSession({ locale: createLocale });
        localStorage.setItem(STORAGE_KEY, r.sessionId);
        // A freshly created session has nothing to hydrate — mark it ready so
        // the terminal's auto-advance effect can fire without waiting for a
        // redundant GET /api/session round-trip.
        hydrated.current = r.sessionId;
        finishedRef.current = false;
        awaitingRef.current = null;
        setSessionId(r.sessionId);
        setItems([]);
        setAwaitingVariable(null);
        setAwaitingStageName(null);
        setFinished(false);
        setLocale(createLocale);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const resume = useCallback((id: string) => {
    localStorage.setItem(STORAGE_KEY, id);
    setSessionId(id);
  }, []);

  const dropStaleSession = useCallback((notice?: string) => {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    finishedRef.current = false;
    gatedRef.current = null;
    setSessionId(null);
    setItems([]);
    setAwaitingVariable(null);
    setAwaitingStageName(null);
    setFinished(false);
    setGatedAt(null);
    // Surface a reason on the login screen (it renders `error`). null leaves
    // any prior error untouched — callers that want a clean drop pass nothing.
    if (notice !== undefined) setError(notice);
  }, []);

  const hydrated = useRef<string | null>(null);
  const hydratingRef = useRef<string | null>(null);

  const hydrate = useCallback(async (id: string) => {
    if (hydrated.current === id || hydratingRef.current === id) return;
    hydratingRef.current = id;
    try {
      const snap = await api.getSession(id);
      setCurrentStage(snap.currentStage);
      setLocale(snap.locale);
      if (snap.finishedAt) {
        finishedRef.current = true;
        setFinished(true);
        setItems([
          {
            kind: 'info',
            id: `hydrate-fin-${id}`,
            text: '[session already completed — reset to start a new one]',
            color: 'dim',
          },
          { kind: 'finished', id: `hydrate-fin-marker-${id}` },
        ]);
      } else if (snap.pendingCheck) {
        // Mid-check resume: banner only on a cold load; an in-session retry
        // keeps the existing scrollback instead of wiping it.
        const stageName = snap.pendingCheck.stageName;
        setItems((prev) =>
          prev.length === 0
            ? [{ kind: 'info', id: `hydrate-pending-${id}`, text: `[resuming verification at ${stageName}…]`, color: 'dim' }]
            : prev,
        );
        try {
          await resolveAndApply(id);
        } catch (err) {
          // Transient resolve failure: surface it, leave the check parked and
          // retryable. Don't mark finished — that would strand the game.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith('404')) dropStaleSession(KICK_NOTICE);
          else setError(msg);
        }
        hydrated.current = id;
        return;
      } else if (snap.awaiting) {
        awaitingRef.current = snap.awaiting.variable;
        setAwaitingVariable(snap.awaiting.variable);
        setAwaitingStageName(snap.awaiting.stageName);
        const label = awaitingLabel(snap.awaiting.variable);
        const waitingText =
          snap.awaiting.variable === CONTINUE_VAR ? label : `waiting for ${label}`;
        const base: RenderItem[] = [
          {
            kind: 'info',
            id: `hydrate-awaiting-${id}`,
            text: `[resumed at ${snap.awaiting.stageName} — ${waitingText}]`,
            color: 'dim',
          },
        ];
        if (snap.replay && snap.replay.length > 0) {
          // Resume replay: the server re-renders the awaiting stage's text
          // so the player re-sees the prompt. Allow clears here — a resumed
          // stage that opens with `<clear/>` legitimately wipes the
          // resumption banner before replaying its text.
          const { next } = appendUnits(base, snap.replay, `hydrate-replay-${id}`, true);
          setItems(next);
        } else {
          base.push({ kind: 'await-input', id: `hydrate-input-${id}`, variable: snap.awaiting.variable });
          setItems(base);
        }
      } else if (snap.currentStage !== null) {
        setItems([
          {
            kind: 'info',
            id: `hydrate-${id}`,
            text: `[resumed at ${snap.currentStage}]`,
            color: 'dim',
          },
        ]);
      }
      hydrated.current = id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('404')) {
        dropStaleSession(KICK_NOTICE);
      } else {
        setError(msg);
        finishedRef.current = true;
        setFinished(true);
      }
    } finally {
      hydratingRef.current = null;
    }
  }, [dropStaleSession, resolveAndApply]);

  useEffect(() => {
    if (sessionId && hydrated.current !== sessionId) {
      void hydrate(sessionId);
    }
  }, [sessionId, hydrate]);

  // Poll the server every 1 s while parked at a gate. Bypasses advance()'s
  // gated-suppression so the loop can detect the unlock and pull the new
  // response (which clears gatedAt via handleResponse). Fires once
  // immediately on mount so an unlock that happens between gate-detection
  // and the first interval tick doesn't block the player for a full
  // cadence — without this kick, lag was up to 3 s on every unlock.
  useEffect(() => {
    if (!sessionId || !gatedAt) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const r = await api.advance(sessionId);
        if (!cancelled) handleResponse(r);
      } catch (err) {
        // A 404 here means the operator deleted the session while it sat at
        // the gate — kick to login. Anything else: swallow, next tick retries.
        const msg = err instanceof Error ? err.message : String(err);
        if (!cancelled && msg.startsWith('404')) dropStaleSession(KICK_NOTICE);
      } finally {
        inFlightRef.current = false;
      }
    };
    void tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sessionId, gatedAt, handleResponse, dropStaleSession]);

  // Heartbeat: detect an operator-side session delete even while the player is
  // idle. advance()/submitInput()/hydrate() already drop a 404'd session, but a
  // player parked at an input (or just reading) issues no requests and would
  // otherwise sit on a dead session forever. Poll the snapshot on a slow cadence;
  // a 404 means the operator deleted it → kick back to login with a notice.
  // Skipped while gated (its 1 s poll already 404-drops) and once finished.
  useEffect(() => {
    if (!sessionId || finished || gatedAt) return;
    let cancelled = false;
    const tick = async () => {
      // Don't race a real action, and wait until the session is hydrated so we
      // don't 404 on a localStorage id mid-hydrate (hydrate handles that path).
      if (cancelled || inFlightRef.current || hydrated.current !== sessionId) return;
      try {
        await api.getSession(sessionId);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('404')) dropStaleSession(KICK_NOTICE);
        // Any other error (network blip, 5xx) — ignore; next tick retries.
      }
    };
    const id = window.setInterval(tick, HEARTBEAT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sessionId, finished, gatedAt, dropStaleSession]);

  const advance = useCallback(async () => {
    if (!sessionId) return;
    if (inFlightRef.current || finishedRef.current || awaitingRef.current) return;
    // Suppress user/auto-advance while gated — the poll effect below is the
    // only path that should hit the server while we're parked at a gate.
    if (gatedRef.current) return;
    if (hydrated.current !== sessionId) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    let resolving = false;
    try {
      const r = await api.advance(sessionId);
      handleResponse(r);
      // An advance-reached check defers too — run it behind the verifying beat.
      if (r.checkPending) {
        resolving = true;
        await resolveAndApply(sessionId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      if (msg.startsWith('404')) {
        dropStaleSession(KICK_NOTICE);
      } else if (msg.startsWith('409')) {
        // Awaiting input or a parked check — re-hydrate to resume correctly.
        hydrated.current = null;
        await hydrate(sessionId);
        setError(null);
      } else if (resolving) {
        // The deferred check failed; it stays parked server-side and retryable.
      } else {
        finishedRef.current = true;
        setFinished(true);
      }
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }, [sessionId, handleResponse, dropStaleSession, hydrate, resolveAndApply]);

  const submitInput = useCallback(
    async (variable: string, value: string) => {
      if (!sessionId || inFlightRef.current) return;
      inFlightRef.current = true;
      setBusy(true);
      setCheckPending(true);
      setError(null);
      // The player actively moved on — the next `<clear/>` from the server
      // is now allowed to wipe (see userActedSinceClearRef in handleResponse).
      userActedSinceClearRef.current = true;
      // Did phase 1 land? A phase-2 failure leaves the check parked (recoverable);
      // a phase-1 failure re-prompts the input.
      let phase1Done = false;
      try {
        setItems((prev) => [
          ...prev,
          {
            kind: 'info',
            id: `echo-${advanceCounterRef.current}`,
            text: `> ${value}`,
            color: 'prompt',
          },
        ]);
        setAwaitingVariable(null);
        setAwaitingStageName(null);
        const r = await api.submitInput(sessionId, { variable, value });
        handleResponse(r);
        phase1Done = true;
        // Two-phase check: the stage streamed its "wait…" narrative; now run
        // the deferred check while the verifying spinner masks the latency.
        if (r.checkPending) await resolveAndApply(sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        if (msg.startsWith('404')) {
          dropStaleSession(KICK_NOTICE);
        } else if (phase1Done) {
          // Check parked server-side; keep the scrollback and just surface the
          // error — the next advance() 409s and re-hydrates to retry the resolve.
        } else {
          setAwaitingVariable(variable);
          awaitingRef.current = variable;
        }
      } finally {
        inFlightRef.current = false;
        setBusy(false);
        setCheckPending(false);
      }
    },
    [sessionId, handleResponse, dropStaleSession, resolveAndApply],
  );

  const gotoStage = useCallback(
    async (stageName: string) => {
      if (!sessionId) return;
      inFlightRef.current = true;
      setBusy(true);
      setError(null);
      try {
        await api.gotoStage(sessionId, stageName);
        // Reset local state + force a fresh hydrate on the new position.
        hydrated.current = null;
        finishedRef.current = false;
        awaitingRef.current = null;
        setItems([]);
        setAwaitingVariable(null);
        setAwaitingStageName(null);
        setFinished(false);
        await hydrate(sessionId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlightRef.current = false;
        setBusy(false);
      }
    },
    [sessionId, hydrate],
  );

  const switchIdentity = useCallback(async () => {
    if (!sessionId || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.switchIdentity(sessionId);
      // Inline transition: don't wipe the scrollback. Drop a dim separator
      // so the shift is visible, then let the usual advance() flow type
      // the fresh Trigram prompt below it. Prior lore + failure chips stay
      // scrollable above — matches the retry-PIN behaviour (which also
      // never wipes) and preserves the "one ongoing conversation" feel.
      hydrated.current = null;
      finishedRef.current = false;
      awaitingRef.current = null;
      setItems((prev) => [
        ...prev,
        {
          kind: 'info',
          id: `switch-${advanceCounterRef.current++}`,
          text: '[switching agent — enter a new Trigram]',
          color: 'dim',
        },
      ]);
      setAwaitingVariable(null);
      setAwaitingStageName(null);
      setFinished(false);
      setCurrentStage(null);
      await hydrate(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }, [sessionId, hydrate]);

  const reset = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    hydrated.current = null;
    finishedRef.current = false;
    awaitingRef.current = null;
    gatedRef.current = null;
    setSessionId(null);
    setItems([]);
    setAwaitingVariable(null);
    setAwaitingStageName(null);
    setFinished(false);
    setGatedAt(null);
    setError(null);
  }, []);

  return {
    sessionId,
    items,
    awaitingVariable,
    awaitingStageName,
    finished,
    gatedAt,
    busy,
    checkPending,
    error,
    typingSpeedMs,
    currentStage,
    locale,
    createSession,
    resume,
    advance,
    submitInput,
    gotoStage,
    switchIdentity,
    reset,
  };
}
