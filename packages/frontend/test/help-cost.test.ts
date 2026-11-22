import { describe, expect, test } from 'bun:test';
import { formatCost, HELP_COST_PRESETS, splitSeconds, validateCost } from '../src/helpCost';

describe('splitSeconds', () => {
  test('splits into minutes and seconds', () => {
    expect(splitSeconds(150)).toEqual({ min: 2, sec: 30 });
    expect(splitSeconds(60)).toEqual({ min: 1, sec: 0 });
    expect(splitSeconds(45)).toEqual({ min: 0, sec: 45 });
    expect(splitSeconds(0)).toEqual({ min: 0, sec: 0 });
  });

  test('negative and fractional values are clamped / floored', () => {
    expect(splitSeconds(-10)).toEqual({ min: 0, sec: 0 });
    expect(splitSeconds(119.9)).toEqual({ min: 1, sec: 59 });
  });

  test('every preset survives a split and a re-read', () => {
    for (const p of HELP_COST_PRESETS) {
      const { min, sec } = splitSeconds(p);
      expect(validateCost(String(min), String(sec))).toEqual({ seconds: p });
    }
  });
});

describe('validateCost', () => {
  test('combines minutes and seconds', () => {
    expect(validateCost('2', '30')).toEqual({ seconds: 150 });
    expect(validateCost('0', '45')).toEqual({ seconds: 45 });
  });

  test('an empty field counts as zero', () => {
    expect(validateCost('2', '')).toEqual({ seconds: 120 });
    expect(validateCost('', '30')).toEqual({ seconds: 30 });
    expect(validateCost('', '')).toEqual({ seconds: 0 });
    expect(validateCost('  ', ' ')).toEqual({ seconds: 0 });
  });

  test('whole numbers only', () => {
    for (const bad of ['1.5', '-1', 'abc', '1e2', '+3']) {
      expect(validateCost(bad, '0')).toEqual({ error: 'whole numbers only' });
      expect(validateCost('0', bad)).toEqual({ error: 'whole numbers only' });
    }
  });

  test('seconds stop at 59', () => {
    expect(validateCost('0', '59')).toEqual({ seconds: 59 });
    expect(validateCost('0', '60')).toEqual({ error: 'seconds go from 0 to 59' });
  });

  test('the total is capped at one hour, like the server', () => {
    expect(validateCost('60', '0')).toEqual({ seconds: 3600 });
    expect(validateCost('60', '1')).toEqual({ error: 'at most 60 min' });
    expect(validateCost('61', '0')).toEqual({ error: 'at most 60 min' });
  });
});

describe('formatCost', () => {
  test('free when there is nothing to pay', () => {
    expect(formatCost(0)).toBe('free');
  });

  test('in the same format as the clocks, without the leading plus', () => {
    expect(formatCost(120)).toBe('2m00');
    expect(formatCost(150)).toBe('2m30');
    expect(formatCost(45)).toBe('45s');
    expect(formatCost(3600)).toBe('1h00');
  });
});
