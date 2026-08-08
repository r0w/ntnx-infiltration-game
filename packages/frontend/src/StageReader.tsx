import { useEffect, useRef } from 'react';
import type { MessageUnit } from '@ntnx-game/shared';
import { useLightbox } from './Lightbox';
import { assetUrl, textClasses } from './renderer';

/**
 * A step of the bootcamp, re-read.
 *
 * Deliberately not the terminal: no typewriter, no prompts, no check. The
 * server strips those and this shows what is left, all at once, the way the
 * bootcamp page it came from would. The player's own run is untouched behind
 * it — nothing here can advance, fail, or re-answer anything.
 */
export function StageReader({
  title,
  units,
  loading,
  error,
  onClose,
}: {
  title: string;
  units: MessageUnit[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // A screenshot opened from in here sits on top of this panel. Escape must
  // peel one layer at a time, so while it is up this panel ignores the key.
  const { isOpen: lightboxOpen } = useLightbox();
  const lightboxOpenRef = useRef(lightboxOpen);
  lightboxOpenRef.current = lightboxOpen;

  // Opening focus, once. Kept apart from the key listener below: that effect
  // re-runs whenever `onClose` changes identity, and folding the two together
  // yanked focus back to the close button on every render — including the one
  // right after a screenshot closed, which is where it belonged.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || lightboxOpenRef.current) return;
      ev.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="reader-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <article className="reader-panel">
        <header className="reader-head">
          <span className="reader-eyebrow">re-reading</span>
          <h2 className="reader-title">{title}</h2>
          <button
            type="button"
            ref={closeRef}
            className="reader-close"
            onClick={onClose}
            aria-label="Close"
          >
            close ✕
          </button>
        </header>
        <div className="reader-body">
          {loading && <p className="c-dim">loading…</p>}
          {error && <p className="c-red">{error}</p>}
          {!loading && !error && units.map((u, i) => <ReadUnit key={i} unit={u} />)}
        </div>
      </article>
    </div>
  );
}

function ReadUnit({ unit }: { unit: MessageUnit }) {
  const lightbox = useLightbox();

  if (unit.kind === 'text') {
    const cls = textClasses(unit.color, unit.styles);
    if (unit.href) {
      return (
        <a className={`${cls} terminal-link`} href={unit.href} target="_blank" rel="noreferrer noopener">
          {unit.text}
        </a>
      );
    }
    return <span className={cls}>{unit.text}</span>;
  }

  if (unit.kind === 'code') {
    return <pre className="code-block">{unit.text}</pre>;
  }

  if (unit.kind === 'image') {
    const url = assetUrl(unit.src);
    return (
      <figure className="img-figure">
        <button
          type="button"
          className="img-56k-wrap img-56k-done"
          onClick={(ev) => lightbox.open({ kind: 'image', src: url, alt: unit.alt }, ev.currentTarget)}
          aria-label={unit.alt ? `Enlarge: ${unit.alt}` : 'Enlarge image'}
        >
          <img className="img-56k" src={url} alt={unit.alt ?? ''} />
          <span className="img-zoom-hint" aria-hidden="true">⤢</span>
        </button>
        {unit.alt && <figcaption className="img-caption">{unit.alt}</figcaption>}
      </figure>
    );
  }

  if (unit.kind === 'demo') {
    const title = unit.label ?? 'Interactive demo';
    return (
      <button
        type="button"
        className="demo-tile"
        onClick={(ev) => lightbox.open({ kind: 'embed', src: unit.src, title }, ev.currentTarget)}
      >
        {unit.poster && <img className="demo-tile-poster" src={assetUrl(unit.poster)} alt="" />}
        <span className="demo-tile-label">▶ {title}</span>
      </button>
    );
  }

  // page-break and anything else carry no meaning outside the running stream.
  return null;
}
