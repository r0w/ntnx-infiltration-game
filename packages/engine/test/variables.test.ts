import { describe, expect, test, mock } from 'bun:test';
import { VariableStore } from '../src/variables';

describe('VariableStore', () => {
  test('get returns undefined when missing', () => {
    const v = new VariableStore();
    expect(v.get('x')).toBeUndefined();
    expect(v.has('x')).toBe(false);
  });

  test('set stores value', () => {
    const v = new VariableStore();
    v.set('foo', 'bar', 3);
    expect(v.get('foo')).toBe('bar');
    expect(v.has('foo')).toBe(true);
  });

  test('seeds from initial record', () => {
    const v = new VariableStore({ a: 1, b: 'two' });
    expect(v.get('a')).toBe(1);
    expect(v.get('b')).toBe('two');
  });

  test('notifies listener on set', () => {
    const listener = mock(() => {});
    const v = new VariableStore({}, listener);
    v.set('foo', 42, 5);
    expect(listener).toHaveBeenCalledWith('foo', 42, 5);
  });

  test('snapshot returns a flat record', () => {
    const v = new VariableStore({ a: 1 });
    v.set('b', 'two', 2);
    expect(v.snapshot()).toEqual({ a: 1, b: 'two' });
  });

  test('delete removes a var from the store', () => {
    const v = new VariableStore({ a: 1 });
    v.set('b', 'two', 2);
    v.delete('a');
    expect(v.has('a')).toBe(false);
    expect(v.get('a')).toBeUndefined();
    expect(v.has('b')).toBe(true);
  });

  test('delete on a missing name is a no-op', () => {
    const v = new VariableStore();
    expect(() => v.delete('never-set')).not.toThrow();
  });
});
