import { useEffect, useRef, useState } from 'react';
import type { MessageUnit } from '@ntnx-game/shared';
import { CodeBlock } from './CodeBlock';
import { fmtPenaltyShort } from './duration';
import { helpLabels, type HelpLabels } from './helpLabels';
import { Modal } from './Modal';
import { textClasses } from './textClasses';

export interface HelpBlockProps {
  /** Item id; also exposed as `data-help-id` so the terminal can scroll to it. */
  id: string;
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

/**
 * The framed step-by-step help block of a stage. Reference material the
 * player reads while working in another window, so it appears at once (no
 * typewriter), can be folded to get the prompt back, and its screenshots open
 * large in a modal. Content is the pack's own message grammar, rendered from
 * the units the server sent: coloured text, links, copyable code, images.
 */
export function HelpBlock({ id, units, penaltySec, locale, isActive, onDone }: HelpBlockProps) {
  const labels = helpLabels(locale);
  const cost = fmtPenaltyShort(penaltySec);
  const [open, setOpen] = useState(true);
  const [zoomed, setZoomed] = useState<Zoomed | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (isActive) onDoneRef.current();
  }, [isActive]);

  return (
    <section
      className={`help-block${open ? ' is-open' : ''}`}
      data-help-id={id}
      aria-label={labels.title}
    >
      <button
        type="button"
        className="help-head"
        aria-expanded={open}
        // Keep the terminal's click-to-focus out of it: folding is not an input.
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="help-bulb" aria-hidden="true">💡</span>
        <span className="help-title">{labels.title}</span>
        {cost && <span className="help-pill">{cost}</span>}
        <span className="help-fold">
          {open ? '▴' : '▾'} {open ? labels.fold : labels.unfold}
        </span>
      </button>
      {open && (
        <>
          <div className="help-body">
            {units.map((unit, i) => (
              <HelpUnit key={i} unit={unit} labels={labels} onZoom={setZoomed} />
            ))}
          </div>
          {cost && <div className="help-foot">{labels.charged(cost)}</div>}
        </>
      )}
      {zoomed && (
        <Modal title={zoomed.alt ?? labels.title} onClose={() => setZoomed(null)} wide className="modal-card-zoom">
          <img className="help-zoom" src={assetUrl(zoomed.src)} alt={zoomed.alt ?? ''} />
          <div className="modal-actions">
            <button type="button" className="modal-btn" onClick={() => setZoomed(null)} autoFocus>
              {labels.close}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function HelpUnit({
  unit,
  labels,
  onZoom,
}: {
  unit: MessageUnit;
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
