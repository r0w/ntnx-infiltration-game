import { describe, expect, test } from 'bun:test';
import { StageRunner } from '../src/stage-runner';
import { CheckRegistry } from '../src/check-registry';
import { VariableStore } from '../src/variables';
import type { LocaleBundle, StageDefinition } from '../src/types';

/**
 * A screenshot that scrolls away while the next line types is a screenshot the
 * player never read. `pauseAfterImages` parks the stream on each one — but it
 * must not stack a second prompt where the content already has one.
 */

function bundle(text: string): LocaleBundle {
  return { defaultLocale: 'en', supported: ['en'], catalogs: { en: { 'k.a': text } } };
}

const STAGE: StageDefinition = {
  id: 's-000',
  name: 'demo-stage',
  index: 0,
  active: true,
  messages: ['k.a'],
};

function render(text: string, pauseAfterImages: boolean) {
  const runner = new StageRunner([STAGE], new CheckRegistry(), { pauseAfterImages });
  return runner
    .render(STAGE, new VariableStore(), 'en', bundle(text))
    .units.map((u) => u.kind);
}

describe('pauseAfterImages', () => {
  test('off by default, so the infiltration game keeps its own pacing', () => {
    expect(render("before<image src='a.png'/>after", false)).not.toContain('await-input');
  });

  test('an image with text after it gets a prompt', () => {
    const kinds = render("before<image src='a.png'/>after", true);
    expect(kinds.slice(0, 3)).toEqual(['text', 'image', 'await-input']);
  });

  test('an image the author already followed with a prompt gets only one', () => {
    const kinds = render("<image src='a.png'/><input/>", true);
    expect(kinds.filter((k) => k === 'await-input')).toHaveLength(1);
  });

  // The runner appends a newline between messages, so the prompt an author
  // wrote is rarely the immediately-next unit.
  test('blank text between the image and an existing prompt does not fool it', () => {
    const kinds = render("<image src='a.png'/>\n\n<input/>", true);
    expect(kinds.filter((k) => k === 'await-input')).toHaveLength(1);
  });

  test('back-to-back images each get their own prompt', () => {
    const kinds = render("<image src='a.png'/><image src='b.png'/>", true);
    expect(kinds.filter((k) => k === 'await-input')).toHaveLength(2);
  });

  // The runner appends its own newline after each message, so the prompt is
  // the last thing that stops the stream, not the last unit in the list.
  test('a stage ending on an image still lets the player look at it', () => {
    const kinds = render("read this<image src='a.png'/>", true);
    expect(kinds.indexOf('await-input')).toBe(kinds.indexOf('image') + 1);
  });
});
