import { describe, expect, test } from 'bun:test';
import { activePath } from '../src/StageRail';
import type { PackNavChapter } from '../src/api';

/**
 * The menu opens shut. What decides which sections stand open is this one
 * function: the chapter the player is in, and every heading down to them.
 */

const row = (stage: string, index: number, items: any[] = []) =>
  ({ stage, title: stage, index, hasCheck: false, items });
const head = (title: string, items: any[]) =>
  ({ title, index: items[0].index, hasCheck: false, items });

const CHAPTERS: PackNavChapter[] = [
  { id: 'fundamentals', title: 'Fundamentals', optional: false, items: [
    row('quick-tour', 0),
    row('storage-intro', 1, [row('block-storage', 2), row('file-storage', 3)]),
  ] },
  { id: 'optional', title: 'Optional Labs', optional: true, items: [
    row('ndk', 4),
    head('Deploy and expose an app', [
      row('web-ide', 5),
      head('Expose app on production', [row('loadbalancer', 6), row('ingress', 7)]),
    ]),
  ] },
];

describe('activePath', () => {
  test('a top-level row opens only its chapter', () => {
    expect(activePath(CHAPTERS, 'quick-tour', 0)).toEqual(['ch:fundamentals']);
  });

  test('a nested row opens the chapter and its parent row, not itself', () => {
    expect(activePath(CHAPTERS, 'block-storage', 2)).toEqual(['ch:fundamentals', 'ch:fundamentals/1']);
  });

  test('a row three levels down opens every heading above it', () => {
    expect(activePath(CHAPTERS, 'ingress', 7)).toEqual([
      'ch:optional',
      'ch:optional/1',
      'ch:optional/1/1',
    ]);
  });

  test('nothing ahead of the player is opened', () => {
    // Standing in the first chapter, the optional labs stay shut.
    const path = activePath(CHAPTERS, 'quick-tour', 0);
    expect(path.some((k) => k.startsWith('ch:optional'))).toBe(false);
  });

  test('with no active stage it falls back to the furthest reached index', () => {
    expect(activePath(CHAPTERS, null, 6)).toEqual(['ch:optional', 'ch:optional/1', 'ch:optional/1/1']);
  });

  test('an empty run still opens the first chapter', () => {
    expect(activePath(CHAPTERS, null, -1)).toEqual(['ch:fundamentals']);
  });

  test('no chapters, no keys', () => {
    expect(activePath([], null, 0)).toEqual([]);
  });
});
