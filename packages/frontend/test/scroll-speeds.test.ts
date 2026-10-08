import { describe, expect, test } from 'bun:test';
import { isScoreboardDisplaySettings } from '@ntnx-game/shared';
import { SCROLL_SPEEDS, SCROLL_SPEED_LABELS } from '../src/scrollSpeeds';

describe('scroll speeds', () => {
  test('are listed from the slowest to the fastest, up to 96 px/s', () => {
    expect([...SCROLL_SPEEDS]).toEqual([12, 24, 48, 96]);
  });

  test('each one has a name, in the order of the menu', () => {
    expect(SCROLL_SPEEDS.map((speed) => SCROLL_SPEED_LABELS[speed])).toEqual(['Slow', 'Normal', 'Fast', 'Turbo']);
  });

  test('each one is a valid display setting, and a speed outside the list is not', () => {
    const settings = { mode: 'scroll', paused: false, view: 'detailed', highlightProgress: true };
    for (const speed of SCROLL_SPEEDS) expect(isScoreboardDisplaySettings({ ...settings, speed })).toBe(true);
    expect(isScoreboardDisplaySettings({ ...settings, speed: 72 })).toBe(false);
  });
});
