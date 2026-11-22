import { describe, expect, test } from 'bun:test';
import { scoreboardLayout } from '../src/scoreboardDisplay';

describe('scoreboard display', () => {
  test('fit keeps every row and column on screen across roster sizes and aspect ratios', () => {
    for (const [width, height] of [[1872, 943], [1318, 627], [366, 600], [812, 250]]) {
      for (let count = 1; count <= 200; count++) {
        const layout = scoreboardLayout(count, width!, height!, 'fit');
        expect(layout.cols * layout.rows).toBeGreaterThanOrEqual(count);
        expect(layout.width * layout.scale).toBeLessThanOrEqual(width! + 0.01);
        expect(layout.visibleHeight).toBeLessThanOrEqual(height! + 0.01);
        expect((layout.width - (layout.cols - 1) * 6) / layout.cols).toBeGreaterThanOrEqual(319.99);
        expect((layout.height - (layout.rows - 1) * 6) / layout.rows).toBeGreaterThanOrEqual(87.99);
      }
    }
  });

  test('50 players fit in Full HD without reducing text', () => {
    const layout = scoreboardLayout(50, 1872, 943, 'fit');
    expect(layout.cols).toBe(5);
    expect(layout.rows).toBe(10);
    expect(layout.scale).toBe(1);
  });

  test('scroll retains natural card size and uses more height when necessary', () => {
    const layout = scoreboardLayout(50, 366, 600, 'scroll');
    expect(layout.scale).toBe(1);
    expect(layout.cols).toBe(1);
    expect(layout.visibleHeight).toBeGreaterThan(600);
  });

});
