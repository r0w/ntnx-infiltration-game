import { describe, expect, test } from 'bun:test';
import { insertTerminalPaste, normalizeTerminalInput, terminalPasteLabels } from '../src/terminalPaste';

describe('terminal paste', () => {
  test('inserts at the cursor and replaces only the selected range', () => {
    expect(insertTerminalPaste('abcd', 'XY', 2, 2, 'Name')).toEqual({ value: 'abXYcd', caret: 4 });
    expect(insertTerminalPaste('abcd', 'XY', 1, 3, 'Name')).toEqual({ value: 'aXYd', caret: 3 });
  });
  test('multiline clipboard text stays in one input; spaces are preserved', () => {
    expect(insertTerminalPaste('', ' foo\r\nbar\nbaz ', 0, 0, 'Name'))
      .toEqual({ value: ' foobarbaz ', caret: 11 });
  });
  test('trigram filters invalid characters without displacing unselected text', () => {
    expect(insertTerminalPaste('AC', 'b!d', 1, 1, 'Trigram')).toEqual({ value: 'AbC', caret: 2 });
    expect(insertTerminalPaste('ABC', 'xyz', 1, 1, 'Trigram')).toEqual({ value: 'ABC', caret: 1 });
    expect(insertTerminalPaste('ABC', 'x-y-z', 0, 3, 'Trigram')).toEqual({ value: 'xyz', caret: 3 });
  });
  test('PIN keeps four digits, including leading zeroes', () => {
    expect(insertTerminalPaste('', '0a12 345', 0, 0, 'PIN')).toEqual({ value: '0123', caret: 4 });
    expect(insertTerminalPaste('1234', '09', 1, 3, 'PIN')).toEqual({ value: '1094', caret: 3 });
  });
  test('typing and pasting use the same character filters', () => {
    expect(normalizeTerminalInput('a-b9!', 'Trigram')).toBe('ab9');
    expect(normalizeTerminalInput('01x234', 'PIN')).toBe('0123');
  });
  test('menu and fallback are translated for every supported locale', () => {
    for (const locale of ['en', 'fr', 'de', 'es', 'it']) {
      expect(terminalPasteLabels(locale).paste.length).toBeGreaterThan(0);
      expect(terminalPasteLabels(locale).denied).toContain('V');
    }
    expect(terminalPasteLabels('unknown')).toEqual(terminalPasteLabels('en'));
  });
});
