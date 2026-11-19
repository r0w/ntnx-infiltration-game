import { CopyValue } from './CopyValue';
import { useEffect, useLayoutEffect, useRef, useState, useId, type ReactNode } from 'react';
import type { MessageUnit } from '@ntnx-game/shared';
import { HelpIcon } from './AgentIcons';
import { CodeBlock } from './CodeBlock';
import { fmtPenaltyShort } from './duration';
import { helpLabels, type HelpLabels } from './helpLabels';
import { createPortal } from 'react-dom';
import { textClasses } from './textClasses';

export interface HelpBlockProps {
  /** Item id; also exposed as `data-help-id` so the terminal can scroll to it. */
  id: string;
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
export function HelpBlock({ id, openRequestId = id, units, penaltySec, locale, isActive, onDone }: HelpBlockProps) {
  const labels = helpLabels(locale);
  const cost = fmtPenaltyShort(penaltySec);
  const [open, setOpen] = useState(false);
  const [zoomed, setZoomed] = useState<Zoomed | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const scrollTop = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
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

  const close = () => {
    if (bodyRef.current) scrollTop.current = bodyRef.current.scrollTop;
    bodyRef.current?.closest('dialog')?.close();
    setZoomed(null);
    setOpen(false);
    sectionRef.current?.closest('.terminal')?.querySelector<HTMLInputElement>('[data-primary-input]:not(:disabled)')?.focus({ preventScroll: true });
  };
  return (
    <section ref={sectionRef} className="help-block" data-help-id={id} aria-label={labels.title}>
      <button type="button" className="help-head" aria-haspopup="dialog" aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(true); }}>
        <HelpIcon /><span className="help-title">{labels.title}</span>
        {cost && <span className="help-pill">{cost}</span>}
        <span className="help-fold">{labels.review} ↗</span>
      </button>
      {open && <HelpDialog title={labels.title} closeLabel={labels.close} onClose={close} initialScrollTop={scrollTop.current}>
        <div className="help-body help-reader-body"
          ref={bodyRef}
          onScroll={e => { if (e.currentTarget.closest('dialog')?.open) scrollTop.current = e.currentTarget.scrollTop; }}>
          {units.map((unit, i) => <HelpUnit key={i} unit={unit} locale={locale} labels={labels} onZoom={setZoomed} />)}
        </div>
        {cost && <div className="help-foot">{labels.charged(cost)}</div>}
      </HelpDialog>}
      {zoomed && <HelpDialog title={zoomed.alt ?? labels.title} closeLabel={labels.close} onClose={() => setZoomed(null)}>
        <div className="help-reader-body help-reader-zoom">
          <img className="help-zoom" src={assetUrl(zoomed.src)} alt={zoomed.alt ?? ''} />
        </div>
      </HelpDialog>}
    </section>
  );
}

/** Native modal supplies focus trapping, inert background and topmost Escape.
 * Portal keeps copy controls outside the terminal's DOM focus scope.
 */
function HelpDialog({ title, closeLabel, onClose, children, initialScrollTop = 0 }: {
  title: string; closeLabel: string; onClose: () => void; children: ReactNode; initialScrollTop?: number;
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
    <dialog ref={ref} className="help-reader" aria-labelledby={titleId}
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
    if (unit.copyable) return <CopyValue text={unit.text} className={cls} locale={locale}>{unit.text}</CopyValue>;
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
          onClick={(e) => {
            e.stopPropagation();
            onZoom({ src: unit.src, alt: unit.alt });
          }}
        >
          <img src={assetUrl(unit.src)} alt={unit.alt ?? ''} />
          <span className="help-zoom-hint" aria-hidden="true">⤢ {labels.zoomHint}</span>
        </button>
        {unit.alt && <figcaption className="help-caption">{unit.alt}</figcaption>}
      </figure>
    );
  }
  return null;
}
