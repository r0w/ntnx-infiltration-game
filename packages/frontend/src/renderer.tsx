import { memo, useEffect, useRef, useState } from 'react';
import { useLightbox } from './Lightbox';
import { CodeBlock } from './CodeBlock';
import type { RenderItem } from './useSession';

export interface TerminalItemProps {
  item: RenderItem;
  typingSpeedMs: number;
  /** When true, <pause/> beats and check-result dwells fire instantly. */
  skipPauses?: boolean;
  /** Print each image's description under it. See PackManifest.imageCaptions. */
  imageCaptions?: boolean;
  isActive: boolean;
  onDone: () => void;
}

/**
 * Renders one item in the terminal scroll. Text items run a typewriter effect
 * only when they're the active (last) item. Older items render fully. Pause
 * items wait out their delay then pass the baton. Instant items (info,
 * check-result, finished) fire onDone immediately.
 */
export const TerminalItem = memo(function TerminalItem({
  item,
  typingSpeedMs,
  skipPauses,
  imageCaptions,
  isActive,
  onDone,
}: TerminalItemProps) {
  if (item.kind === 'text') {
    return (
      <TypewriterText
        text={item.text}
        color={item.color}
        styles={item.styles}
        href={item.href}
        speedMs={typingSpeedMs}
        isActive={isActive}
        onDone={onDone}
      />
    );
  }
  if (item.kind === 'pause') {
    // skip-pauses (dev toggle) drops the <pause/> beats so an operator
    // replaying for the Nth time doesn't wait them out.
    return <PauseUnit ms={skipPauses ? 0 : item.ms} isActive={isActive} onDone={onDone} />;
  }
  if (item.kind === 'check-dwell') {
    // The "let me check…" beat: hold a labelled spinner between the
    // operator's narration and the verdict so the check reads as actually
    // happening, instead of the result landing on the same frame as the
    // line announcing it. skip-pauses drops it for dev/auto replays.
    return (
      <CheckDwell ms={skipPauses ? 0 : item.ms} label={item.label} isActive={isActive} onDone={onDone} />
    );
  }
  if (item.kind === 'info') {
    return (
      <InstantLine color={item.color} isActive={isActive} onDone={onDone}>
        {item.text}
        {'\n'}
      </InstantLine>
    );
  }
  if (item.kind === 'code') {
    return <CodeBlock text={item.text} lang={item.lang} isActive={isActive} onDone={onDone} />;
  }
  if (item.kind === 'image') {
    return (
      <ImageReveal
        src={item.src}
        alt={item.alt}
        showCaption={imageCaptions === true}
        isActive={isActive}
        onDone={onDone}
      />
    );
  }
  if (item.kind === 'demo') {
    return (
      <DemoTile
        src={item.src}
        poster={item.poster}
        label={item.label}
        isActive={isActive}
        onDone={onDone}
      />
    );
  }
  if (item.kind === 'page-break') {
    // data-page-break lets FauxTerminal's scroll policy find the latest
    // break and pin its top to the viewport top.
    return (
      <InstantBlock className="page-break" isActive={isActive} onDone={onDone}>
        <span className="page-break-marker" data-page-break="true" />
        <span className="page-break-line" />
      </InstantBlock>
    );
  }
  if (item.kind === 'check-result') {
    // Neutral = the check couldn't judge (the cluster was mid-rebuild, not the
    // player's doing). Nothing is scored, so it must not read as a failure —
    // its own colour, and the hint IS the message (there's no cheer).
    const neutral = !item.pass && item.neutral === true;
    const cls = neutral ? 'check-wait' : item.pass ? 'check-pass' : 'check-fail';
    const prefix = neutral ? '[…]' : item.pass ? '[✓]' : '[✗]';
    // Two-tier surfacing: the locale-aware `cheer` + an optional `hint`
    // for fails. `hint` says WHICH category broke ("VM is missing a NIC")
    // without revealing the expected value (anti-spoiler). The raw `detail`
    // (which DOES leak expected values like "VM has 1 vCPU expected ≥ 2")
    // stays in the API response + server logs for dev/admin debugging,
    // never on the player's screen.
    const fallback = item.pass ? 'Stage validated.' : 'Check failed. Have another look.';
    const text = neutral ? (item.hint ?? 'Hold on — try again in a moment.') : (item.cheer ?? fallback);
    const hint = !item.pass && !neutral && item.hint ? item.hint : null;
    // Dwell longer when a hint accompanies the fail so the player has time
    // to read both lines before the next stage scrolls in. skip-pauses
    // drops the dwell too.
    const dwellMs = skipPauses ? 0 : hint || neutral ? 2400 : 1800;
    return (
      <DwellBlock className={cls} dwellMs={dwellMs} isActive={isActive} onDone={onDone}>
        {prefix} {text}
        {hint && <div className="check-hint">↳ {hint}</div>}
      </DwellBlock>
    );
  }
  if (item.kind === 'await-input') {
    return null; // handled by the parent (input field + sequencer)
  }
  if (item.kind === 'finished') {
    return (
      <InstantBlock className="finished" isActive={isActive} onDone={onDone}>
        [mission complete]
      </InstantBlock>
    );
  }
  // A unit kind this build does not know — a server ahead of a cached bundle,
  // say. Render nothing, but still release the sequencer: silently skipping a
  // unit is recoverable, freezing the whole run on it is not.
  return <SkippedUnit isActive={isActive} onDone={onDone} />;
});

function SkippedUnit({ isActive, onDone }: { isActive: boolean; onDone: () => void }) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (isActive) onDoneRef.current();
  }, [isActive]);
  return null;
}

/**
 * Show a Braille-dot spinner while the pause is running so the player has
 * a visible "thinking" cue instead of dead silence during longer beats
 * (<pause sec='6'/> et al). The spinner disappears when the pause finishes
 * — the sequencer advances past and the item renders null again.
 *
 * Short pauses (< 400ms) skip the spinner entirely to avoid visual noise.
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAME_MS = 80;
const SPINNER_MIN_PAUSE_MS = 400;

/** Localized label for the check-pending spinner. Falls back to `en` when the
 *  active locale isn't translated. Single source of truth — consumed by the
 *  inline network spinner in FauxTerminal and by the post-narration
 *  `check-dwell` item below. */
export const VERIFYING_LABELS: Record<string, string> = {
  en: 'verifying…',
  fr: 'vérification…',
  de: 'Überprüfung…',
};

/** Animated Braille-dot glyph. Reused by PauseUnit (in-line during long
 *  `<pause/>`s) and by FauxTerminal's `verifying…` indicator. `className`
 *  defaults to `pause-spinner` to match the existing visual; pass a custom
 *  one to retheme the color/size at the call site. */
export function BrailleSpinner({ className = 'pause-spinner' }: { className?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, SPINNER_FRAME_MS);
    return () => clearInterval(id);
  }, []);
  return <span className={className}>{SPINNER_FRAMES[frame]}</span>;
}

function PauseUnit({ ms, isActive, onDone }: { ms: number; isActive: boolean; onDone: () => void }) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!isActive || done) return;
    const t = setTimeout(() => {
      setDone(true);
      onDoneRef.current();
    }, ms);
    return () => clearTimeout(t);
  }, [isActive, ms, done]);
  if (done || !isActive || ms < SPINNER_MIN_PAUSE_MS) return null;
  return <BrailleSpinner />;
}

/** Holds the labelled `verifying…` spinner for `ms` then passes the baton to
 *  the check-result. Same markup as FauxTerminal's network spinner so the two
 *  read as one continuous "checking" beat. Fires onDone once. */
function CheckDwell({
  ms,
  label,
  isActive,
  onDone,
}: {
  ms: number;
  label: string;
  isActive: boolean;
  onDone: () => void;
}) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!isActive || done) return;
    const t = setTimeout(() => {
      setDone(true);
      onDoneRef.current();
    }, ms);
    return () => clearTimeout(t);
  }, [isActive, ms, done]);
  // ms===0 (skip-pauses) would flash the spinner for one frame before the
  // 0ms timeout fires — render nothing in that case.
  if (done || !isActive || ms === 0) return null;
  return (
    <div className="terminal-check-pending" aria-live="polite">
      <BrailleSpinner className="terminal-check-pending-spinner" />
      <span className="c-dim">{label}</span>
    </div>
  );
}

function InstantLine({
  color,
  isActive,
  onDone,
  children,
}: {
  color?: string;
  isActive: boolean;
  onDone: () => void;
  children: React.ReactNode;
}) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (isActive) onDoneRef.current();
  }, [isActive]);
  return <span className={textClasses(color, undefined)}>{children}</span>;
}

function InstantBlock({
  className,
  isActive,
  onDone,
  children,
}: {
  className: string;
  isActive: boolean;
  onDone: () => void;
  children: React.ReactNode;
}) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (isActive) onDoneRef.current();
  }, [isActive]);
  return <div className={className}>{children}</div>;
}

/**
 * Like InstantBlock but holds for `dwellMs` before firing onDone, so a
 * transient row (check-result, etc.) stays readable before the sequencer
 * moves on. Fires exactly once even if the effect re-runs.
 */
function DwellBlock({
  className,
  dwellMs,
  isActive,
  onDone,
  children,
}: {
  className: string;
  dwellMs: number;
  isActive: boolean;
  onDone: () => void;
  children: React.ReactNode;
}) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const firedRef = useRef(false);
  useEffect(() => {
    if (!isActive || firedRef.current) return;
    const t = setTimeout(() => {
      firedRef.current = true;
      onDoneRef.current();
    }, dwellMs);
    return () => clearTimeout(t);
  }, [isActive, dwellMs]);
  return <div className={className}>{children}</div>;
}

interface TypewriterTextProps {
  text: string;
  color?: string;
  styles?: string[];
  href?: string;
  speedMs: number;
  isActive: boolean;
  onDone: () => void;
}

function TypewriterText({ text, color, styles, href, speedMs, isActive, onDone }: TypewriterTextProps) {
  const [shown, setShown] = useState('');
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const completedRef = useRef(false);

  useEffect(() => {
    // Don't touch `shown` in the inactive branch. Upcoming items mount with
    // shown='' (the useState default) and stay empty until they become active;
    // finished items keep whatever they typed out and must not be wiped when
    // the sequencer moves on.
    if (!isActive || completedRef.current) return;
    if (text.length === 0) {
      completedRef.current = true;
      onDoneRef.current();
      return;
    }
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) {
        completedRef.current = true;
        onDoneRef.current();
        return;
      }
      timer = setTimeout(tick, speedMs);
    };
    timer = setTimeout(tick, speedMs);
    return () => clearTimeout(timer);
  }, [text, speedMs, isActive]);

  const className = textClasses(color, styles);
  if (href) {
    return (
      <a
        className={`${className} terminal-link`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {shown}
      </a>
    );
  }
  return <span className={className}>{shown}</span>;
}

/**
 * Compose class names for a text run. `color` is exclusive (whichever tag is
 * topmost in the parser's color stack); `styles` are cumulative modifiers
 * like `bold` or `dim`. Unknown values are dropped — they won't have a
 * matching `.c-*` rule anyway.
 */
/**
 * 56k-style stepped reveal: the image arrives in discrete horizontal bands
 * (clip-path + steps() keyframes) with a cyan scanline trailing the edge.
 * Sequencer integration mirrors TypewriterText — waits for `<img>` onLoad,
 * then flips to the `playing` phase which triggers the CSS animation.
 * `onAnimationEnd` on the img is the single source of truth for reveal
 * completion (earlier versions ran a setTimeout in the same useEffect that
 * setPhase'd — its cleanup fired when phase changed and cancelled the timer
 * before firing, leaving the sequencer stuck).
 */
function ImageReveal({
  src,
  alt,
  showCaption,
  isActive,
  onDone,
}: {
  src: string;
  alt?: string;
  showCaption?: boolean;
  isActive: boolean;
  onDone: () => void;
}) {
  const lightbox = useLightbox();
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'playing' | 'done'>('idle');
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (isActive && phase === 'idle' && loaded) setPhase('playing');
  }, [isActive, phase, loaded]);
  const url = assetUrl(src);
  // Screenshots are dense: readable in the stream, but the detail the step
  // actually points at often needs the full size. Clicking opens it.
  // stopPropagation because the terminal reclaims focus on any click.
  const enlarge = (ev: { stopPropagation: () => void }) => {
    ev.stopPropagation();
    lightbox.open({ kind: 'image', src: url, alt });
  };
  const caption = showCaption && alt ? alt : null;
  const frame = (
    <button
      type="button"
      className={`img-56k-wrap img-56k-${phase}`}
      onClick={enlarge}
      aria-label={alt ? `Enlarge: ${alt}` : 'Enlarge image'}
    >
      <img
        className="img-56k"
        src={url}
        alt={alt ?? ''}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
        onAnimationEnd={() => {
          if (phase === 'playing') {
            setPhase('done');
            onDoneRef.current();
          }
        }}
      />
      <span className="img-zoom-hint" aria-hidden="true">⤢</span>
    </button>
  );
  if (!caption) return frame;
  // A figure so the caption is tied to the image rather than floating as the
  // next line of prose. It sits outside the button: it describes the picture,
  // it is not part of the control.
  return (
    <figure className="img-figure">
      {frame}
      <figcaption className="img-caption">{caption}</figcaption>
    </figure>
  );
}

/** Pack assets are served from one route; absolute URLs pass through. */
export function assetUrl(src: string): string {
  return src.startsWith('http') || src.startsWith('/') ? src : `/api/pack-assets/${src}`;
}

/**
 * An interactive sandbox the player opens. Rendered as a poster tile rather
 * than an inline frame on purpose: the demos are full applications, and one
 * silently loading mid-stream would pull attention away from the step being
 * read. The tile is instant — nothing to reveal, so the sequencer moves on.
 */
function DemoTile({
  src,
  poster,
  label,
  isActive,
  onDone,
}: {
  src: string;
  poster?: string;
  label?: string;
  isActive: boolean;
  onDone: () => void;
}) {
  const lightbox = useLightbox();
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (isActive) onDoneRef.current();
  }, [isActive]);
  const title = label ?? 'Interactive demo';
  return (
    <button
      type="button"
      className="demo-tile"
      onClick={(ev) => {
        ev.stopPropagation();
        lightbox.open({ kind: 'embed', src, title });
      }}
    >
      {poster && <img className="demo-tile-poster" src={assetUrl(poster)} alt="" />}
      <span className="demo-tile-label">▶ {title}</span>
    </button>
  );
}

const KNOWN_COLORS = new Set([
  'red', 'green', 'yellow', 'cyan', 'blue', 'magenta', 'white', 'dim', 'prompt',
]);
const KNOWN_STYLES = new Set(['bold', 'dim']);

export function textClasses(color: string | undefined, styles: string[] | undefined): string {
  const out: string[] = [];
  if (color && KNOWN_COLORS.has(color)) out.push(`c-${color}`);
  else out.push('c-default');
  if (styles) {
    for (const s of styles) {
      if (KNOWN_STYLES.has(s)) out.push(`c-${s}`);
    }
  }
  return out.join(' ');
}
