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

type LightboxApi = {
  /**
   * `opener` is the control that triggered this, and focus goes back to it
   * when the lightbox closes inside a panel of its own. Pass it explicitly:
   * `document.activeElement` is not reliable here, because Safari does not
   * focus a button on click and a programmatic click focuses nothing at all.
   */
  open: (content: LightboxContent, opener?: HTMLElement | null) => void;
  /**
   * True while something is enlarged. Overlays underneath read this so they
   * do not act on the same Escape: whatever is on top owns the key, and only
   * one layer closes per press.
   */
  isOpen: boolean;
};

const LightboxContext = createContext<LightboxApi>({ open: () => {}, isOpen: false });

export function useLightbox(): LightboxApi {
  return useContext(LightboxContext);
}

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<LightboxContent | null>(null);
  // The terminal steals focus back to its input on every click, so we hand
  // focus to the close button while open and give it back on the way out.
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const open = useCallback((next: LightboxContent, opener?: HTMLElement | null) => {
    openerRef.current = opener ?? (document.activeElement as HTMLElement | null);
    setContent(next);
  }, []);

  const close = useCallback(() => {
    setContent(null);
    const opener = openerRef.current;
    openerRef.current = null;
    // Opened from a panel of its own (the stage reader), the usual pattern is
    // right: focus goes back to the thing that was clicked, and the panel
    // keeps the keyboard.
    if (opener?.closest('[role="dialog"]')) {
      opener.focus();
      return;
    }
    // Opened from the transcript, it is not. The trigger is a button and Enter
    // is how the player continues the game: they would press Enter to move on
    // and reopen the lightbox instead. Hand focus to whatever the page marks
    // as its primary input; failing that, blur rather than restore, because a
    // dead Enter beats a looping one.
    const primary = document.querySelector<HTMLElement>('[data-primary-input]');
    if (primary) primary.focus();
    else opener?.blur?.();
  }, []);

  useEffect(() => {
    if (!content) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        // The terminal listens for keys too, and so does any panel this was
        // opened from. stopImmediatePropagation, not stopPropagation: the
        // others are bound to this same target, where plain propagation
        // control does not reach them.
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [content, close]);

  const api = useMemo(() => ({ open, isOpen: content !== null }), [open, content]);

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
            {/* A sandbox is third-party and can be blocked by an extension, a
                proxy, or a policy we cannot see from here. Always leave a door
                that does not depend on framing working. */}
            {content.kind === 'embed' && (
              <a
                className="lightbox-external"
                href={content.src}
                target="_blank"
                rel="noreferrer noopener"
              >
                open in a new tab ↗
              </a>
            )}
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
              /* No loading="lazy": the player just clicked to open this, so
                 deferring the fetch buys nothing and risks an empty frame. */
              <iframe
                className="lightbox-embed"
                src={content.src}
                title={content.title}
                allow="fullscreen"
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
