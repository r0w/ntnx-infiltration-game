import type { ScoreboardDisplayMode } from '@ntnx-game/shared';
export type { ScoreboardDisplayMode, ScoreboardDisplaySettings, ScrollSpeed } from '@ntnx-game/shared';

const GAP = 6;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 88;

export function scoreboardLayout(count: number, width: number, height: number, mode: ScoreboardDisplayMode) {
  width = Math.max(1, width);
  height = Math.max(1, height);
  count = Math.max(1, count);
  const capacity = Math.max(1, Math.min(5, Math.floor((width + GAP) / (MIN_WIDTH + GAP))));
  const rowsThatFit = Math.max(1, Math.floor((height + GAP) / (MIN_HEIGHT + GAP)));
  let cols = Math.max(1, Math.min(capacity, Math.ceil(count / Math.min(8, rowsThatFit))));
  let scale = 1;

  if (mode === 'fit') {
    // Find the arrangement that needs the least reduction. Retain the normal
    // layout whenever it already fits, including the 50-player Full HD view.
    const scaleFor = (columns: number) => Math.min(
      1,
      width / (columns * MIN_WIDTH + (columns - 1) * GAP),
      height / (Math.ceil(count / columns) * (MIN_HEIGHT + GAP) - GAP),
    );
    scale = scaleFor(cols);
    for (let candidate = 1; candidate <= count && scale < 1; candidate++) {
      const next = scaleFor(candidate);
      if (next > scale) {
        cols = candidate;
        scale = next;
      }
    }
  }

  const rows = Math.ceil(count / cols);
  const gridHeight = Math.max(
    rows * (MIN_HEIGHT + GAP) - GAP,
    Math.min(height / scale, rows * (220 + GAP) - GAP),
  );
  return {
    cols, rows, scale,
    width: width / scale,
    height: gridHeight,
    visibleHeight: gridHeight * scale,
    compact: (gridHeight - (rows - 1) * GAP) / rows < 130,
  };
}
