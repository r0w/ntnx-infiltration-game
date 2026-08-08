import { describe, expect, test } from 'bun:test';
import { CheckRegistry, makeBundle, type StageDefinition } from '@ntnx-game/engine';
import { resolvePackNav } from '../src/pack-nav';
import type { LoadedPack, PackNavChapter } from '../src/pack-loader';

/**
 * The menu is generated from the manifest, so the two ways it can lie are
 * both structural: a row whose title never got translated, and a row pointing
 * at a stage the pack does not ship.
 */

function stage(name: string, index: number, check?: string): StageDefinition {
  return {
    id: `s-${index}`,
    name,
    index,
    active: true,
    messages: [],
    ...(check ? { check: { fn: check } } : {}),
  } as StageDefinition;
}

function pack(nav: PackNavChapter[]): LoadedPack {
  return {
    dir: '/nowhere',
    manifest: {
      id: 'test-pack',
      name: 'Test',
      version: '0',
      checks: './checks',
      defaultLocale: 'en',
      supportedLocales: ['en', 'fr'],
      stages: [],
      locales: './locales',
      nav,
    },
    stages: [stage('one', 0), stage('two', 1, 'CheckTwo'), stage('three', 2)],
    checks: new CheckRegistry(),
    actions: new Map(),
    acts: new Map(),
    cleanups: new Map(),
    bundle: makeBundle('en', {
      en: { 'c.a': 'Chapter A', 't.one': 'One', 't.two': 'Two', 't.three': 'Three' },
      fr: { 'c.a': 'Chapitre A', 't.one': 'Un' },
    }),
  } as unknown as LoadedPack;
}

const NAV: PackNavChapter[] = [
  {
    id: 'a',
    title: 'c.a',
    items: [
      { stage: 'one', title: 't.one', items: [{ stage: 'two', title: 't.two' }] },
      { stage: 'three', title: 't.three' },
    ],
  },
];

describe('resolvePackNav', () => {
  test('a pack with no nav gets no menu, and the caller renders nothing', () => {
    const p = pack([]);
    expect(resolvePackNav(p, 'en')).toEqual([]);
  });

  test('titles resolve, nesting survives, and each row carries its run index', () => {
    const [chapter] = resolvePackNav(pack(NAV), 'en');
    expect(chapter!.title).toBe('Chapter A');
    expect(chapter!.items.map((i) => [i.stage, i.title, i.index])).toEqual([
      ['one', 'One', 0],
      ['three', 'Three', 2],
    ]);
    expect(chapter!.items[0]!.items[0]).toMatchObject({ stage: 'two', title: 'Two', index: 1 });
  });

  test('a stage with a check is flagged, so the menu can call it a lab', () => {
    const [chapter] = resolvePackNav(pack(NAV), 'en');
    expect(chapter!.items[0]!.items[0]!.hasCheck).toBe(true);
    expect(chapter!.items[0]!.hasCheck).toBe(false);
  });

  // Same fallback chain as the stage text: a half-translated menu shows the
  // default language rather than a raw key.
  test('an untranslated row falls back to the default locale', () => {
    const [chapter] = resolvePackNav(pack(NAV), 'fr');
    expect(chapter!.title).toBe('Chapitre A');
    expect(chapter!.items.map((i) => i.title)).toEqual(['Un', 'Three']);
  });

  test('a row naming a stage the pack does not ship is dropped, loudly', () => {
    const warnings: string[] = [];
    const chapters = resolvePackNav(
      pack([{ id: 'a', title: 'c.a', items: [{ stage: 'ghost', title: 't.one' }] }]),
      'en',
      (m) => warnings.push(m),
    );
    // The chapter had one row and it was a ghost, so the heading goes too.
    expect(chapters).toEqual([]);
    expect(warnings).toEqual(['pack nav names a stage the pack does not have: ghost']);
  });
});
