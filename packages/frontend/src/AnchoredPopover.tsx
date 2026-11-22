import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

export interface AnchoredPopoverProps {
  /** The element the popover hangs from (a button). */
  anchorRef: RefObject<HTMLElement | null>;
  /** Called when the popover should go away: Escape, a click outside, a scroll, a resize. */
  onClose: () => void;
  /** Width in px; the popover never leaves the window. */
  width: number;
  /** ARIA role of the popover (`dialog` for a form, `menu` for a list). */
  role?: 'dialog' | 'menu';
  label: string;
  children: ReactNode;
}

/**
 * A small floating panel pinned under (or over) an anchor button. It is
 * rendered in a portal with `position: fixed` because the admin tables sit in
 * a horizontally scrollable wrapper that would clip an absolutely positioned
 * child. It closes when the page scrolls or resizes rather than trying to
 * follow the anchor.
 */
export function AnchoredPopover({
  anchorRef,
  onClose,
  width,
  role = 'dialog',
  label,
  children,
}: AnchoredPopoverProps) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Measure after the first paint of the content, then place it: below the
  // anchor, or above when there is no room below.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const a = anchor.getBoundingClientRect();
    const h = pop.offsetHeight;
    const gap = 6;
    const left = Math.max(8, Math.min(a.left, window.innerWidth - width - 8));
    const below = a.bottom + gap;
    const fitsBelow = below + h <= window.innerHeight - 8;
    const top = fitsBelow || a.top - gap - h < 8 ? below : a.top - gap - h;
    setPos({ top, left });
  }, [anchorRef, width]);

  useEffect(() => {
    const close = () => onCloseRef.current();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
      anchorRef.current?.focus();
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && popRef.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchorRef]);

  return createPortal(
    <div
      ref={popRef}
      className="admin-pop"
      role={role}
      aria-label={label}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
    >
      {children}
    </div>,
    document.body,
  );
}
