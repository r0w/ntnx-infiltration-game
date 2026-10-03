import { describe, expect, test } from 'bun:test';
import { formatPenalty, helpLabels, HELP_LABELS } from '../src/helpLabels';

describe('formatPenalty', () => {
  test('whole minutes', () => {
    expect(formatPenalty(120)).toBe('+2 min');
    expect(formatPenalty(180)).toBe('+3 min');
    expect(formatPenalty(60)).toBe('+1 min');
  });

  test('minutes and seconds', () => {
    expect(formatPenalty(150)).toBe('+2 min 30 s');
    expect(formatPenalty(90)).toBe('+1 min 30 s');
  });

  test('seconds only', () => {
    expect(formatPenalty(45)).toBe('+45 s');
    expect(formatPenalty(1)).toBe('+1 s');
  });

  test('a free help shows no cost at all', () => {
    expect(formatPenalty(0)).toBe('');
    expect(formatPenalty(-5)).toBe('');
    expect(formatPenalty(Number.NaN)).toBe('');
  });

  test('fractions are floored', () => {
    expect(formatPenalty(119.9)).toBe('+1 min 59 s');
  });
});

describe('helpLabels', () => {
  test('falls back to English for an unknown locale', () => {
    expect(helpLabels('xx')).toBe(HELP_LABELS.en!);
  });

  test('every shipped locale defines every label', () => {
    const keys = Object.keys(HELP_LABELS.en!).sort();
    for (const [locale, labels] of Object.entries(HELP_LABELS)) {
      expect(Object.keys(labels).sort()).toEqual(keys);
      expect(labels.confirm('+2 min')).toContain('+2 min');
      expect(labels.charged('+2 min')).toContain('+2 min');
      expect(locale.length).toBe(2);
    }
  });

  test('the games locales are all covered', () => {
    for (const locale of ['en', 'fr', 'de', 'es', 'it']) {
      expect(HELP_LABELS[locale]).toBeDefined();
    }
  });
});
