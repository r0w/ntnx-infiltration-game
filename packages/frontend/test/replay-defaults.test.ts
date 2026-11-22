import { describe, expect, test } from 'bun:test';
import { effectiveSkipPauses, effectiveTypingSpeed } from '../src/replay-defaults';

describe('effectiveTypingSpeed', () => {
  test('test and mock modes default to instant text', () => {
    expect(effectiveTypingSpeed(null, 15, 'test')).toBe(0);
    expect(effectiveTypingSpeed(null, 15, 'mock')).toBe(0);
  });

  test('live mode, or a pack not loaded yet, keeps the pack speed', () => {
    expect(effectiveTypingSpeed(null, 15, 'live')).toBe(15);
    expect(effectiveTypingSpeed(null, 15, undefined)).toBe(15);
  });

  test('an explicit choice wins in every mode', () => {
    expect(effectiveTypingSpeed(20, 15, 'test')).toBe(20);
    expect(effectiveTypingSpeed(0, 15, 'live')).toBe(0);
  });
});

describe('effectiveSkipPauses', () => {
  test('test and mock modes skip pauses by default', () => {
    expect(effectiveSkipPauses(null, 'test')).toBe(true);
    expect(effectiveSkipPauses(null, 'mock')).toBe(true);
  });

  test('live mode, or a pack not loaded yet, keeps the pauses', () => {
    expect(effectiveSkipPauses(null, 'live')).toBe(false);
    expect(effectiveSkipPauses(null, undefined)).toBe(false);
  });

  test('an explicit choice wins in every mode', () => {
    expect(effectiveSkipPauses(false, 'mock')).toBe(false);
    expect(effectiveSkipPauses(true, 'live')).toBe(true);
  });
});
