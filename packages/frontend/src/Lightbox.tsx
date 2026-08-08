import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * What the lightbox can show. A screenshot the player wants to read, or an
 * interactive sandbox they step through — same frame, same way out.
 */
export type LightboxContent =
  | { kind: 'image'; src: string; alt?: string }
  | { kind: 'embed'; src: string; title: string };

type LightboxApi = { open: (content: LightboxContent) => void };

const LightboxContext = createContext<LightboxApi>({ open: () => {} });

export function useLightbox(): LightboxApi {
  return useContext(LightboxContext);
}

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<LightboxContent | null>(null);
  // The terminal steals focus back to its input on every click, so we hand
  // focus to the close button while open and give it back on the way out.
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const open = useCallback((next: LightboxContent) => {
    openerRef.current = document.activeElement as HTMLElement | null;
    setContent(next);
  }, []);

  const close = useCallback(() => {
    setContent(null);
    openerRef.current?.focus?.();
    openerRef.current = null;
  }, []);

  useEffect(() => {
    if (!content) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        // The terminal listens for keys too; this one is ours.
        ev.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [content, close]);

  const api = useMemo(() => ({ open }), [open]);

  return (
    <LightboxContext.Provider value={api}>
      {children}
      {content && (
        <div
          className="lightbox-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={content.kind === 'image' ? (content.alt ?? 'Enlarged image') : content.title}
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget) close();
          }}
        >
          <div className={`lightbox-frame lightbox-frame-${content.kind}`}>
            <button
              type="button"
              ref={closeRef}
              className="lightbox-close"
              onClick={close}
              aria-label="Close"
            >
              close ✕
            </button>
            {content.kind === 'image' ? (
              <img className="lightbox-image" src={content.src} alt={content.alt ?? ''} />
            ) : (
              <iframe
                className="lightbox-embed"
                src={content.src}
                title={content.title}
                allow="fullscreen"
                loading="lazy"
              />
            )}
            {content.kind === 'image' && content.alt && (
              <p className="lightbox-caption">{content.alt}</p>
            )}
          </div>
        </div>
      )}
    </LightboxContext.Provider>
  );
}
