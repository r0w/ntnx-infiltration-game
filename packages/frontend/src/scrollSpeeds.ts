import { SCROLL_SPEEDS, type ScrollSpeed } from '@ntnx-game/shared';

export { SCROLL_SPEEDS, type ScrollSpeed };

/** What the operator calls each auto-scroll speed. */
export const SCROLL_SPEED_LABELS: Record<ScrollSpeed, string> = {
  12: 'Slow',
  24: 'Normal',
  48: 'Fast',
  96: 'Turbo',
};
