import { describe, expect, test } from 'bun:test';
import { fmtDuration, fmtPenaltyShort } from '../src/duration';

describe('fmtDuration', () => {
  test('seconds, minutes and hours', () => {
    expect(fmtDuration(45_000)).toBe('45s');
    expect(fmtDuration(12 * 60_000 + 5_000)).toBe('12m05');
    expect(fmtDuration(2 * 60_000)).toBe('2m00');
    expect(fmtDuration(72 * 60_000 + 23_000)).toBe('1h12');
    expect(fmtDuration(60 * 60_000)).toBe('1h00');
  });

  test('a fraction of a second is dropped', () => {
    expect(fmtDuration(59_999)).toBe('59s');
  });

  test('anything that is not a duration shows a dash', () => {
    expect(fmtDuration(-1)).toBe('—');
    expect(fmtDuration(Number.NaN)).toBe('—');
    expect(fmtDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('fmtPenaltyShort', () => {
  test('the same format as the clocks, with a plus', () => {
    expect(fmtPenaltyShort(270)).toBe('+4m30');
    expect(fmtPenaltyShort(120)).toBe('+2m00');
    expect(fmtPenaltyShort(180)).toBe('+3m00');
    expect(fmtPenaltyShort(45)).toBe('+45s');
    expect(fmtPenaltyShort(3600)).toBe('+1h00');
  });

  test('a free help shows nothing', () => {
    expect(fmtPenaltyShort(0)).toBe('');
    expect(fmtPenaltyShort(-5)).toBe('');
    expect(fmtPenaltyShort(Number.NaN)).toBe('');
  });
});
