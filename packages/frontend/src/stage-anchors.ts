/**
 * Getting the transcript back to the live line.
 *
 * A player who has scrolled up to re-read needs one way back down, and the
 * contents menu offers it. Finding the scroller by class rather than through
 * a prop chain matches the `data-page-break` and `data-primary-input`
 * contracts already in play.
 */
export function jumpToLive(): void {
  const box = document.querySelector<HTMLElement>('.terminal-scroll');
  if (!box) return;
  box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
}
