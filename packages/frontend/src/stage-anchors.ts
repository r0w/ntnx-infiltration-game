/**
 * Scrolling the transcript back to where a stage began.
 *
 * The link between the menu and the terminal is a DOM contract, not a prop
 * chain: FauxTerminal stamps `data-stage="<name>"` on a marker in front of
 * each stage's first line, and this module finds it. Same shape as the
 * `data-page-break` marker the scroll pin uses and the `data-primary-input`
 * the lightbox hands focus back to.
 */

export const STAGE_ANCHOR_ATTR = 'data-stage';

function scroller(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>('.terminal-scroll');
}

/**
 * Put the top of `stage` at the top of the terminal viewport.
 *
 * Returns false when that stage is not in the scrollback — after a reload
 * the transcript starts empty, and a menu row that cannot deliver has to say
 * so rather than scroll somewhere arbitrary.
 */
export function jumpToStage(stage: string): boolean {
  const anchor = document.querySelector<HTMLElement>(`[${STAGE_ANCHOR_ATTR}="${CSS.escape(stage)}"]`);
  if (!anchor) return false;
  const box = scroller(anchor);
  if (!box) return false;
  const top = anchor.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  // A few pixels of air above the first line so it doesn't sit flush against
  // the top edge and read as cut off.
  box.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' });
  return true;
}

/** Back to the live line, which is always the bottom of the transcript. */
export function jumpToLive(): void {
  const box = document.querySelector<HTMLElement>('.terminal-scroll');
  if (!box) return;
  box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
}
