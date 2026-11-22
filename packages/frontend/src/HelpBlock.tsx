import { CopyValue } from './CopyValue';
import { useEffect, useLayoutEffect, useRef, useState, useId, useMemo, type ReactNode } from 'react';
import type { MessageUnit } from '@ntnx-game/shared';
import { HelpIcon } from './AgentIcons';
import { CodeBlock } from './CodeBlock';
import { fmtPenaltyShort } from './duration';
import { helpLabels, type HelpLabels } from './helpLabels';
import { createPortal } from 'react-dom';
import { textClasses } from './textClasses';
import { helpSections } from './helpSections';

export interface HelpBlockProps {
  /** Item id; also exposed as `data-help-id` so the terminal can scroll to it. */
  id: string;
  title?: string;
  openRequestId?: string;
  units: MessageUnit[];
  /** What the first display cost, in seconds. 0 = free: no cost is shown. */
  penaltySec: number;
  locale: string;
  isActive: boolean;
  onDone: () => void;
}

type Zoomed = { src: string; alt?: string };

const noop = () => {};

/** Pack assets are served flat from `/api/pack-assets/`; absolute URLs pass through. */
function assetUrl(src: string): string {
  return src.startsWith('http') || src.startsWith('/') ? src : `/api/pack-assets/${src}`;
}

/** A compact terminal entry opens a scroll-preserving help reader. */
export function HelpBlock({ id, openRequestId = id, units, penaltySec, locale, isActive, onDone, title }: HelpBlockProps) {
  const labels = helpLabels(locale);
  const readerTitle = title ?? labels.title;
  const sections = useMemo(() => helpSections(units), [units]);
  const readerId = useId();
  const [activeSection, setActiveSection] = useState(0);
  const cost = fmtPenaltyShort(penaltySec);
  const [open, setOpen] = useState(false);
  const [zoomed, setZoomed] = useState<Zoomed | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const scrollTop = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const selectedPosition = useRef<number | null>(null);
  const pan = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | null>(null);
  const lastRequest = useRef<string>();
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (!isActive && lastRequest.current === undefined) return;
    if (lastRequest.current !== openRequestId) {
      lastRequest.current = openRequestId;
      setOpen(true);
    }
    if (isActive) onDoneRef.current();
  }, [isActive, openRequestId]);

  const syncSection = (body: HTMLDivElement) => {
    if (!body.closest('dialog')?.open) return;
    scrollTop.current = body.scrollTop;
    // A clicked heading may be clamped to the same bottom position as later
    // headings. Keep that explicit choice until the reader scrolls again.
    if (selectedPosition.current !== null && Math.abs(body.scrollTop - selectedPosition.current) <= 2) return;
    selectedPosition.current = null;
    const top = body.getBoundingClientRect().top;
    const headings = [...body.querySelectorAll<HTMLElement>('[data-help-section]')];
    const atEnd = body.scrollTop > 0 && body.scrollHeight - body.clientHeight - body.scrollTop <= 2;
    const current = atEnd ? headings.at(-1) : headings.filter(h => h.getBoundingClientRect().top <= top + 72).at(-1) ?? headings[0];
    if (current) setActiveSection(Number(current.dataset.helpSection));
  };
  const resumeScrollTracking = (body: HTMLDivElement) => {
    selectedPosition.current = null;
    syncSection(body);
  };

  const close = () => {
    if (bodyRef.current) scrollTop.current = bodyRef.current.scrollTop;
    bodyRef.current?.closest('dialog')?.close();
    setZoomed(null);
    setOpen(false);
    sectionRef.current?.closest('.terminal')?.querySelector<HTMLInputElement>('[data-primary-input]:not(:disabled)')?.focus({ preventScroll: true });
  };
  return (
    <section ref={sectionRef} className="help-block" data-help-id={id} aria-label={readerTitle}>
      <button type="button" className="help-head" aria-haspopup="dialog" aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(true); }}>
        <HelpIcon /><span className="help-title">{readerTitle}</span>
        {cost && <span className="help-pill">{cost}</span>}
        <span className="help-fold">{labels.review} ↗</span>
      </button>
      {open && <HelpDialog title={readerTitle} closeLabel={labels.close} onClose={close} initialScrollTop={scrollTop.current}>
        <div className="help-reader-layout">
          {sections.filter(s => s.heading).length > 1 && <nav className="help-outline" aria-label={labels.contents}>
            <p className="help-outline-title">{labels.contents}</p>
            {sections.map((section, i) => section.heading && <button key={i} type="button"
              aria-current={activeSection === i ? 'step' : undefined}
              onClick={() => {
                const heading = document.getElementById(`${readerId}-${i}`);
                heading?.scrollIntoView({ block: 'start' });
                selectedPosition.current = bodyRef.current?.scrollTop ?? null;
                heading?.focus({ preventScroll: true });
                setActiveSection(i);
              }} aria-label={section.heading}><span className="help-outline-number" aria-hidden="true">{section.number}</span><span>{section.label}</span></button>)}
          </nav>}
          <div className="help-body help-reader-body" ref={bodyRef}
            onScroll={e => syncSection(e.currentTarget)}
            onWheel={e => resumeScrollTracking(e.currentTarget)}
            onTouchMove={e => resumeScrollTracking(e.currentTarget)}
            onKeyDown={e => {
              if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
                resumeScrollTracking(e.currentTarget);
              }
            }}>
            {sections.map((section, i) => <section className="help-step" key={i}
              aria-labelledby={section.heading ? `${readerId}-${i}` : undefined}>
              {section.heading && <h3 id={`${readerId}-${i}`} data-help-section={i} tabIndex={-1}>{section.heading}</h3>}
              <HelpContent units={section.units} locale={locale} labels={labels} onZoom={setZoomed} />
            </section>)}
          </div>
        </div>
        {cost && <div className="help-foot">{labels.charged(cost)}</div>}
      </HelpDialog>}
      {zoomed && <HelpDialog zoom title={zoomed.alt ?? readerTitle} closeLabel={labels.close} onClose={() => setZoomed(null)}>
        <div className="help-reader-body help-reader-zoom" tabIndex={0} aria-label={zoomed.alt ?? labels.zoomHint}
          onPointerDown={e => {
            if (e.pointerType !== 'mouse' || e.button !== 0) return;
            const body = e.currentTarget;
            pan.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, left: body.scrollLeft, top: body.scrollTop };
            body.setPointerCapture(e.pointerId);
            body.classList.add('is-panning');
            body.focus({ preventScroll: true });
            e.preventDefault();
          }}
          onPointerMove={e => {
            const start = pan.current;
            if (!start || start.pointer !== e.pointerId) return;
            e.currentTarget.scrollLeft = start.left - (e.clientX - start.x);
            e.currentTarget.scrollTop = start.top - (e.clientY - start.y);
          }}
          onPointerUp={e => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onLostPointerCapture={e => { pan.current = null; e.currentTarget.classList.remove('is-panning'); }}
          onPointerCancel={e => { pan.current = null; e.currentTarget.classList.remove('is-panning'); }}>
          <img className="help-zoom" draggable={false} src={assetUrl(zoomed.src)} alt={zoomed.alt ?? ''} />
        </div>
      </HelpDialog>}
    </section>
  );
}

/** Native modal supplies focus trapping, inert background and topmost Escape.
 * Portal keeps copy controls outside the terminal's DOM focus scope.
 */
function HelpDialog({ title, closeLabel, onClose, children, initialScrollTop = 0, zoom = false }: {
  title: string; closeLabel: string; onClose: () => void; children: ReactNode; initialScrollTop?: number; zoom?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const body = dialog.querySelector<HTMLElement>('.help-body');
    if (body) body.scrollTop = initialScrollTop;
    return () => dialog.close();
  }, []);
  return createPortal(
    <dialog ref={ref} className={`help-reader${zoom ? " help-reader-expanded" : ""}`} aria-labelledby={titleId}
      onCancel={e => { e.preventDefault(); onClose(); }}
      onClick={e => e.stopPropagation()}
      onMouseDown={e => {
        e.stopPropagation();
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
        }
      }}>
      <header className="help-reader-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="modal-btn" onClick={onClose} autoFocus>{closeLabel} ✕</button>
      </header>
      {children}
    </dialog>, document.body,
  );
}

function HelpContent({ units, locale, labels, onZoom }: {
  units: MessageUnit[]; locale: string; labels: HelpLabels; onZoom: (z: Zoomed) => void;
}) {
  const blocks: MessageUnit[][] = [];
  for (const unit of units) {
    if (unit.kind === 'text' && blocks.at(-1)?.[0]?.kind === 'text') blocks.at(-1)!.push(unit);
    else blocks.push([unit]);
  }
  return <div className="help-step-content">{blocks.map((block, i) => {
    if (block.every(u => u.kind === 'text' && !u.text.trim())) return null;
    const content = block.map((unit, j) => <HelpUnit key={j}
      unit={j === 0 && unit.kind === 'text' ? { ...unit, text: unit.text.trimStart() } : unit}
      locale={locale} labels={labels} onZoom={onZoom} />);
    return block[0]?.kind === 'text' ? <p className="help-prose" key={i}>{content}</p> : <div key={i}>{content}</div>;
  })}</div>;
}

function HelpUnit({
  unit,
  locale,
  labels,
  onZoom,
}: {
  unit: MessageUnit;
  locale?: string;
  labels: HelpLabels;
  onZoom: (z: Zoomed) => void;
}) {
  if (unit.kind === 'text') {
    const cls = textClasses(unit.color, unit.styles);
    if (unit.href) {
      return (
        <a
          className={`${cls} terminal-link`}
          href={unit.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {unit.text}
        </a>
      );
    }
    if (unit.copyable) return <CopyValue text={unit.copyText ?? unit.text} className={cls} locale={locale}>{unit.text}</CopyValue>;
    return <span className={cls}>{unit.text}</span>;
  }
  if (unit.kind === 'code') {
    return <CodeBlock text={unit.text} lang={unit.lang} isActive={false} onDone={noop} />;
  }
  if (unit.kind === 'image') {
    return (
      <figure className="help-figure">
        <button
          type="button"
          className="help-shot"
          title={labels.zoomHint}
          aria-label={`${labels.zoomHint}${unit.alt ? `: ${unit.alt}` : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onZoom({ src: unit.src, alt: unit.alt });
          }}
        >
          <img src={assetUrl(unit.src)} alt={unit.alt ?? ''} />
          <span className="help-zoom-hint" aria-hidden="true">{labels.zoomHint}</span>
        </button>
        {unit.alt && <figcaption className="help-caption">{unit.alt}</figcaption>}
      </figure>
    );
  }
  return null;
}
