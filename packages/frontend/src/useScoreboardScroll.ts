import { useEffect, useRef, type RefObject } from 'react';

type ScrollPhase = 'top' | 'down' | 'bottom' | 'up';

/** Scroll only the rankings; live refreshes must not restart the cycle. */
export function useScoreboardScroll(
  ref: RefObject<HTMLDivElement>,
  enabled: boolean,
  paused: boolean,
  speed: number,
  contentHeight: number,
  viewportHeight: number,
) {
  const phaseRef = useRef<ScrollPhase>('top');
  useEffect(() => {
    const roster = ref.current;
    if (!roster || !enabled || paused || contentHeight <= viewportHeight + 1) return;
    let frame = 0;
    let last = 0;
    let elapsed = 0;
    let position = roster.scrollTop;
    let manualPauseUntil = 0;
    let phase: ScrollPhase = position === 0 ? 'top' : phaseRef.current === 'top' ? 'down' : phaseRef.current;
    const interact = () => { manualPauseUntil = performance.now() + 4000; };
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const event of events) roster.addEventListener(event, interact, { passive: true });

    const tick = (time: number) => {
      const delta = last ? Math.min(time - last, 64) : 0;
      last = time;
      const max = Math.max(0, roster.scrollHeight - roster.clientHeight);
      // Dialogs, background tabs and manual navigation suspend the movement.
      if (document.hidden || document.querySelector('dialog[open]') || time < manualPauseUntil) {
        position = roster.scrollTop;
        if (time < manualPauseUntil) {
          if (phase === 'top' || phase === 'bottom') phase = 'down';
          elapsed = 0;
        }
      } else {
        elapsed += delta;
        if (phase === 'top' && elapsed >= 2000) {
          phase = 'down';
          elapsed = 0;
        } else if (phase === 'down') {
          position = Math.min(max, position + speed * delta / 1000);
          roster.scrollTop = position;
          if (position >= max) {
            phase = 'bottom';
            elapsed = 0;
          }
        } else if (phase === 'bottom' && elapsed >= 2000) {
          phase = 'up';
          elapsed = 0;
        } else if (phase === 'up') {
          position = Math.max(0, position - speed * delta / 1000);
          roster.scrollTop = position;
          if (position === 0) {
            phase = 'top';
            elapsed = 0;
          }
        }
      }
      phaseRef.current = phase;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      for (const event of events) roster.removeEventListener(event, interact);
    };
  }, [ref, enabled, paused, speed, contentHeight, viewportHeight]);
}
