import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keeps the most-recent `<pagebreak/>` marker pinned at the top of a scroll
 * container while fresh content after it still fits in one viewport; falls
 * back to stick-to-bottom once it overflows. The scroller gets a dynamic
 * inline `paddingBottom` to extend its virtual scroll-range so the
 * marker-to-top assignment isn't clamped by the browser.
 *
 * Auto-scroll yields to the reader: any scroll that lands outside the
 * "at bottom" band (40px) parks the pin so the user can read backlog
 * without being yanked. Returning to within 40px of the bottom unparks
 * and the next trigger tick re-engages pin/follow. Our own programmatic
 * writes are ignored via the `lastProgrammaticTop` guard so they never
 * self-park.
 *
 * Re-runs on every trigger tick AND on async layout shifts that React
 * wouldn't observe on its own:
 * - `ResizeObserver` on the scroller (flex-parent resize, devtools open).
 * - `window` resize for viewport changes.
 * - `load` on each `<img>` inside the scroller — pack-asset images land
 *   after the stage is already queued, and their final layout height
 *   otherwise shifts scrollHeight between ticks without a re-run.
 *
 * RAF debouncing coalesces the fan-in so a single frame only runs one
 * apply — prevents feedback loops from our own paddingBottom writes.
 */
export function usePageBreakScrollPin(
  scrollerRef: RefObject<HTMLElement | null>,
  triggers: ReadonlyArray<unknown>,
): void {
  // Refs so parked-state survives the trigger-driven effect re-runs below.
  const userParkedRef = useRef(false);
  const lastProgrammaticTopRef = useRef(-1);

  // Scroll listener: mounted once per scroller. Distinguishes our writes
  // (matches lastProgrammaticTopRef within 1px) from real user scrolls.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = () => {
      const top = scroller.scrollTop;
      if (Math.abs(top - lastProgrammaticTopRef.current) < 1) return;
      const distanceFromBottom = scroller.scrollHeight - top - scroller.clientHeight;
      userParkedRef.current = distanceFromBottom >= 40;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [scrollerRef]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const apply = () => {
      if (userParkedRef.current) return;
      const breaks = scroller.querySelectorAll<HTMLElement>('[data-page-break]');
      const lastBreak = breaks[breaks.length - 1];
      const currentPad = parseFloat(scroller.style.paddingBottom || '') || 0;
      const naturalScrollHeight = scroller.scrollHeight - currentPad;
      if (lastBreak) {
        const scrollerRect = scroller.getBoundingClientRect();
        const markerRect = lastBreak.getBoundingClientRect();
        const markerPos = markerRect.top - scrollerRect.top + scroller.scrollTop;
        const contentAfterMarker = naturalScrollHeight - markerPos;
        if (contentAfterMarker <= scroller.clientHeight) {
          const neededHeight = markerPos + scroller.clientHeight;
          const needPad = Math.max(0, neededHeight - naturalScrollHeight);
          if (Math.abs(needPad - currentPad) > 0.5) {
            scroller.style.paddingBottom = `${needPad}px`;
          }
          if (Math.abs(scroller.scrollTop - markerPos) > 0.5) {
            lastProgrammaticTopRef.current = markerPos;
            scroller.scrollTop = markerPos;
          }
          return;
        }
      }
      if (currentPad !== 0) scroller.style.paddingBottom = '0px';
      lastProgrammaticTopRef.current = scroller.scrollHeight;
      scroller.scrollTop = scroller.scrollHeight;
    };

    let rafHandle = 0;
    const schedule = () => {
      cancelAnimationFrame(rafHandle);
      rafHandle = requestAnimationFrame(apply);
    };

    schedule();

    const ro = new ResizeObserver(schedule);
    ro.observe(scroller);
    window.addEventListener('resize', schedule);

    const imgs = Array.from(scroller.querySelectorAll<HTMLImageElement>('img'));
    imgs.forEach((img) => {
      if (!img.complete) img.addEventListener('load', schedule, { once: true });
    });

    return () => {
      cancelAnimationFrame(rafHandle);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      imgs.forEach((img) => img.removeEventListener('load', schedule));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollerRef, ...triggers]);
}
