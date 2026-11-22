import { describe, expect, test } from 'bun:test';
import { helpLabels, HELP_LABELS } from '../src/helpLabels';

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
