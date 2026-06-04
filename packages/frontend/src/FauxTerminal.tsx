import { useCallback, useEffect, useRef, useState } from 'react';
import { BrailleSpinner, TerminalItem, VERIFYING_LABELS } from './renderer';
import { usePageBreakScrollPin } from './usePageBreakScrollPin';
import { awaitingLabel, CONTINUE_VAR, type GatedAt, type RenderItem } from './useSession';

export interface FauxTerminalProps {
  items: RenderItem[];
  awaitingVariable: string | null;
  busy: boolean;
  /** True between the player's submit and the server response landing — drives
   *  the inline "verifying…" spinner so live cluster checks (2–15 s) don't
   *  look hung. */
  checkPending: boolean;
  /** Active session locale; picks the spinner label translation. */
  locale: string;
  finished: boolean;
  typingSpeedMs: number;
  /** Dev toggle: fire <pause/> beats + check dwells instantly. */
  skipPauses: boolean;
  /**
   * When set, the player is parked at an admin-gated stage. The banner
   * surfaces only after the typewriter has caught up to items.length so
   * it doesn't pop in over the previous stage's still-typing text.
   */
  gatedAt: GatedAt | null;
  /**
   * When true, every press-enter-to-continue prompt (variable === CONTINUE_VAR)
   * is auto-advanced (submitted empty, like pressing Enter) once the typewriter
   * catches up. Named-var prompts are left to the player. Each await-input is
   * auto-submitted at most once — a failed check leaves the same await-input id
   * in items, so the per-id guard breaks any retry loop on check failures.
   */
  autoPlay: boolean;
  onSubmit: (value: string) => void;
  /**
   * Called instead of a bare submit when auto-play fires. The parent can
   * augment it with mode-specific work — e.g. firing the stage's seed handler
   * in `test` mode before pressing Enter — without leaking that policy into
   * FauxTerminal.
   */
  onAutoPlayOk: () => void | Promise<void>;
  onAdvance: () => void;
  /**
   * When set, pressing ↓ inside the input fires this handler instead of the
   * usual history-no-op. GameApp passes it only during identity capture
   * (currentStage < 1) so the shortcut doesn't hijack ↓ once the game proper
   * starts.
   */
  onSwitchIdentity?: () => void;
}

export function FauxTerminal({
  items,
  awaitingVariable,
  busy,
  checkPending,
  locale,
  finished,
  typingSpeedMs,
  skipPauses,
  gatedAt,
  autoPlay,
  onSubmit,
  onAutoPlayOk,
  onAdvance,
  onSwitchIdentity,
}: FauxTerminalProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState('');
  // activeIdx = index of the item currently being revealed. Everything before
  // it is fully rendered, nothing after it is mounted yet.
  const [activeIdx, setActiveIdx] = useState(0);

  const advanceSequencer = useCallback(() => {
    setActiveIdx((prev) => Math.min(prev + 1, items.length));
  }, [items.length]);

  // When the items array shrinks — a `<clear/>` wipe, a goto, a reset, or a
  // new session — the remaining items are fresh content that still needs to
  // type in from the start. Merely clamping activeIdx to the new length left
  // it at items.length (= "done" to the sequencer), so newly-pushed text
  // items never activated and rendered empty. Reset to 0 on any shrink so
  // the typewriter replays from the top.
  const prevLenRef = useRef(items.length);
  useEffect(() => {
    if (items.length < prevLenRef.current) setActiveIdx(0);
    prevLenRef.current = items.length;
  }, [items.length]);

  const inputVisible = !!awaitingVariable && !busy && activeIdx >= items.length;
  useEffect(() => {
    if (inputVisible) {
      inputRef.current?.focus();
    }
  }, [inputVisible]);

  // Auto-play: when armed, press Enter (submit empty) at every CONTINUE_VAR
  // prompt so the narrative + check chain rolls without operator input. We key the guard
  // on the latest matching await-input's id — a failed check returns
  // `units: []` and re-arms the same await-input, so its id is unchanged
  // and the guard prevents an infinite resubmit loop. A fresh prompt in a
  // new stage gets a new id, so submission resumes naturally.
  // Auto-fillable named vars — server-side endpoint can look up the live
  // cluster value for these, so auto-play submits the answer instead of
  // skipping the prompt. Trigram/PIN/Username stay manual (player identity).
  const AUTOFILLABLE = new Set(['NodeSerial', 'NumberUpdates', 'Runway']);
  const autoSubmittedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoPlay) {
      autoSubmittedIdRef.current = null;
      return;
    }
    if (!inputVisible) return;
    const isContinue = awaitingVariable === CONTINUE_VAR;
    const isAutoFillable = awaitingVariable !== null && AUTOFILLABLE.has(awaitingVariable);
    if (!isContinue && !isAutoFillable) return;
    let target: string | null = null;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'await-input' && it.variable === awaitingVariable) {
        target = it.id;
        break;
      }
    }
    if (!target || autoSubmittedIdRef.current === target) return;
    const id = target;
    const t = window.setTimeout(() => {
      autoSubmittedIdRef.current = id;
      void onAutoPlayOk();
    }, 350);
    return () => window.clearTimeout(t);
  }, [autoPlay, inputVisible, awaitingVariable, items, onAutoPlayOk]);

  const focusInput = () => {
    const sel = typeof window !== 'undefined' ? window.getSelection()?.toString() : '';
    if (sel && sel.length > 0) return;
    inputRef.current?.focus();
  };

  // Scroll policy: when a pagebreak is the latest one and the content
  // between it and the end still fits in one viewport, pin the pagebreak's
  // top at the viewport's top so the new stage reads as "page 2" — old
  // content is above the fold, fresh text fills down from the separator.
  // Once content after the pagebreak exceeds the viewport, fall back to
  // scroll-to-bottom so the typewriter stays visible.
  usePageBreakScrollPin(scrollerRef, [items, activeIdx]);

  // Gate banner forces a scroll-to-bottom — overrides usePageBreakScrollPin's
  // userParked guard. The pin hook respects user scroll-up to avoid yanking
  // them mid-read while content streams in; the gate banner is a system
  // signal ("paused — waiting for instructor") the player has to see, not
  // narrative content. Fires when the banner becomes visible (gatedAt set
  // AND typewriter has caught up to items.length so the banner is in DOM).
  useEffect(() => {
    if (!gatedAt) return;
    if (activeIdx < items.length) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  }, [gatedAt, activeIdx, items.length]);

  // A validation is a system signal the player must see — same rationale as
  // the gate banner. The pin hook parks on user scroll-up, so once the
  // player has scrolled back to re-read, the "verifying…" spinner, the
  // verdict, and the stage that follows all happen below the fold with no
  // scroll (reproduced: parked at top, a check ran 500+px down, view never
  // moved). Force a scroll-to-bottom both when the check fires
  // (`checkPending`) and when the verdict lands (a `check-result` becomes
  // the last item). The scroll event this emits also lands within the pin
  // hook's "at bottom" band, which un-parks it so subsequent content follows
  // normally. No-op for short stages that already fit (scrollHeight ≤
  // clientHeight ⇒ scrollTop stays 0).
  const lastItem = items[items.length - 1];
  const lastCheckResultId =
    lastItem?.kind === 'check-result' ? lastItem.id : null;
  useEffect(() => {
    if (!checkPending && !lastCheckResultId) return;
    if (activeIdx < items.length) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  }, [checkPending, lastCheckResultId, activeIdx, items.length]);

  useEffect(() => {
    if (!awaitingVariable && !busy && !finished && activeIdx >= items.length && items.length > 0) {
      // Hold longer when the last item is a successful check-result so the
      // player has time to read the cheer / "validated" line before the
      // next stage scrolls in (especially noticeable when the next stage
      // opens with `<pagebreak/>`). Failures keep the snappy 150 ms — the
      // retry input pops up immediately so the player can react.
      const last = items[items.length - 1];
      const isCheckPass = last?.kind === 'check-result' && last.pass === true;
      const delay = isCheckPass ? 2500 : 150;
      const t = setTimeout(() => onAdvance(), delay);
      return () => clearTimeout(t);
    }
  }, [awaitingVariable, busy, finished, activeIdx, items, onAdvance]);

  useEffect(() => {
    if (items.length === 0 && !busy && !finished && !awaitingVariable) {
      onAdvance();
    }
  }, [items.length, busy, finished, awaitingVariable, onAdvance]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !awaitingVariable) return;
    const v = inputValue;
    // Named-var prompts (Trigram, PIN, NodeSerial, etc.) reject empty
    // submits silently at the input level so the player doesn't
    // accidentally send "" and trigger an opaque "No <var> captured"
    // check failure. CONTINUE_VAR (the "press Enter to continue"
    // prompt) is fine with empty — the server treats no-value as the
    // implicit "Ok".
    if (awaitingVariable !== CONTINUE_VAR && v.trim().length === 0) return;
    setInputValue('');
    onSubmit(v);
  };

  const isEmpty = items.length === 0 && !awaitingVariable && !finished;
  const visibleItems = items.slice(0, Math.min(activeIdx + 1, items.length));

  return (
    <div className="terminal" onClick={focusInput}>
      <div className="terminal-scroll" ref={scrollerRef}>
        {isEmpty && (
          <div className="terminal-line c-dim">
            {busy ? 'connecting...' : 'idle — press enter to advance'}
          </div>
        )}
        {visibleItems.map((item, idx) => (
          <Line
            key={item.id}
            item={item}
            typingSpeedMs={typingSpeedMs}
            skipPauses={skipPauses}
            isActive={idx === activeIdx}
            onDone={advanceSequencer}
          />
        ))}
        {gatedAt && activeIdx >= items.length && (
          <div className={`terminal-gated terminal-gated-${gatedAt.reason}`}>
            <span className="terminal-gated-icon">
              {gatedAt.reason === 'global' ? '🍽' : '⏸'}
            </span>
            <span className="terminal-gated-body">
              <span className="terminal-gated-title">
                {gatedAt.reason === 'global' ? 'lunch break' : 'paused'}
              </span>
              <span className="terminal-gated-sub">
                {gatedAt.reason === 'global'
                  ? 'back soon — instructor paused the session'
                  : 'waiting for the instructor to unlock'}
              </span>
            </span>
            <span className="terminal-gated-spinner" aria-hidden="true" />
          </div>
        )}
        {checkPending && activeIdx >= items.length && !awaitingVariable && (
          <div className="terminal-check-pending" aria-live="polite">
            <BrailleSpinner className="terminal-check-pending-spinner" />
            <span className="c-dim">{VERIFYING_LABELS[locale] ?? VERIFYING_LABELS.en}</span>
          </div>
        )}
        {awaitingVariable && activeIdx >= items.length && (
          <div className="terminal-input-wrap">
            <form
              onSubmit={handleSubmit}
              className="terminal-input-line"
              autoComplete="off"
            >
              <span className="c-prompt">&gt;&nbsp;</span>
              {/* Browsers and password managers (LastPass, 1Password, …) love
                  to hijack a lone text input with login-shaped hints. Even
                  `autoComplete='off'` is routinely ignored. Pile on the
                  vendor-specific opt-outs + a randomized `name` so the field
                  doesn't pattern-match anything they recognise. */}
              <input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => {
                  let v = e.target.value;
                  // Per-variable saisie constraints — keep the field
                  // physically incapable of accepting an invalid value
                  // so the player gets immediate feedback (no "type 8
                  // chars then learn it had to be 3"). Server-side
                  // CheckTrigram enforces the same rules defensively.
                  if (awaitingVariable === 'Trigram') {
                    v = v.replace(/[^A-Za-z0-9]/g, '').slice(0, 3);
                  } else if (awaitingVariable === 'PIN') {
                    v = v.replace(/\D/g, '').slice(0, 4);
                  }
                  setInputValue(v);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' && onSwitchIdentity) {
                    e.preventDefault();
                    setInputValue('');
                    onSwitchIdentity();
                  }
                }}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                inputMode={awaitingVariable === 'PIN' ? 'numeric' : undefined}
                maxLength={
                  awaitingVariable === 'Trigram' ? 3
                    : awaitingVariable === 'PIN' ? 4
                    : undefined
                }
                name={`game-input-${awaitingVariable ?? 'idle'}`}
                data-form-type="other"
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                aria-label={`Input for ${awaitingLabel(awaitingVariable)}`}
              />
              {onSwitchIdentity && (
                <span className="terminal-input-hint c-dim">
                  &nbsp;&nbsp;[↓ switch agent]
                </span>
              )}
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

function Line({
  item,
  typingSpeedMs,
  skipPauses,
  isActive,
  onDone,
}: {
  item: RenderItem;
  typingSpeedMs: number;
  skipPauses: boolean;
  isActive: boolean;
  onDone: () => void;
}) {
  const doneRef = useRef(false);
  useEffect(() => {
    if (!isActive || doneRef.current) return;
    if (item.kind === 'await-input') {
      doneRef.current = true;
      onDone();
    }
  }, [isActive, item.kind, onDone]);

  if (item.kind === 'await-input') return null;

  const handleDone = () => {
    if (!doneRef.current) {
      doneRef.current = true;
      onDone();
    }
  };

  // Text and pause flow inline so multiple tokens stay on the same line; the
  // server injects "\n" between game messages which CSS `white-space: pre-wrap`
  // renders as an actual line break. Block-level items (info, check-result,
  // finished) wrap themselves.
  return (
    <TerminalItem
      item={item}
      typingSpeedMs={typingSpeedMs}
      skipPauses={skipPauses}
      isActive={isActive}
      onDone={handleDone}
    />
  );
}
