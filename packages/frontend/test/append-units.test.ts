import { describe, expect, test } from 'bun:test';
import type { MessageUnit } from '@ntnx-game/shared';
import { appendUnits } from '../src/useSession';

/**
 * The unit-to-item conversion whitelists kinds with an if/else chain, so a
 * kind added to the protocol and to the render types still vanishes here
 * unless someone remembers this file. TypeScript does not catch it: both
 * unions accept the new kind, and the chain simply never matches.
 *
 * That is exactly how the `demo` unit shipped invisible — the server streamed
 * it, the renderer knew how to draw it, and it was dropped in between.
 */

/** One sample per kind the parser can emit. Add a kind, add a sample. */
const SAMPLES: MessageUnit[] = [
  { kind: 'text', text: 'hello' },
  { kind: 'pause', ms: 10 },
  { kind: 'await-input', variable: '$continue' },
  { kind: 'code', text: 'kubectl get pods', lang: 'bash' },
  { kind: 'image', src: 'shot.png', alt: 'a screenshot' },
  { kind: 'demo', src: 'https://example.com/demo', poster: 'p.png', label: 'Take the tour' },
  { kind: 'page-break' },
  { kind: 'clear' },
];

describe('appendUnits', () => {
  test('every protocol unit kind survives the conversion', () => {
    // `clear` wipes rather than appends, so it is the one kind with no item.
    const appended = SAMPLES.filter((u) => u.kind !== 'clear');
    const { next } = appendUnits([], appended, 'x', true);
    expect(next.map((i) => i.kind)).toEqual(appended.map((u) => u.kind));
  });

  test('a demo unit keeps its sandbox url, poster and label', () => {
    const { next } = appendUnits(
      [],
      [{ kind: 'demo', src: 'https://example.com/d', poster: 'p.png', label: 'Tour' }],
      'x',
      true,
    );
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      kind: 'demo',
      src: 'https://example.com/d',
      poster: 'p.png',
      label: 'Tour',
    });
  });

  test('await-input reports the variable the terminal must prompt for', () => {
    const { awaiting } = appendUnits([], [{ kind: 'await-input', variable: 'UserNum' }], 'x', true);
    expect(awaiting).toBe('UserNum');
  });

  // firstId is what the stage menu anchors on. Point it at the wrong item and
  // "read this step again" scrolls to somebody else's step.
  test('firstId names the first line this batch printed, not the last', () => {
    const prior = appendUnits([], [{ kind: 'text', text: 'earlier' }], 'a', true).next;
    const { firstId } = appendUnits(
      prior,
      [{ kind: 'text', text: 'opening line' }, { kind: 'text', text: 'and more' }],
      'b',
      true,
    );
    expect(firstId).toBe('b-0-1');
  });

  test('a batch that prints nothing claims no anchor of its own', () => {
    const prior = appendUnits([], [{ kind: 'text', text: 'earlier' }], 'a', true).next;
    const { firstId } = appendUnits(prior, [], 'b', true);
    expect(firstId).toBeNull();
  });

  // A wipe means the earlier text is gone from the screen, so the anchor has
  // to be whatever survived the wipe — not the line that preceded it.
  test('a clear mid-batch moves the anchor to the first line after the wipe', () => {
    const prior = appendUnits([], [{ kind: 'text', text: 'earlier' }], 'a', true).next;
    const { next, firstId } = appendUnits(
      prior,
      [{ kind: 'text', text: 'doomed' }, { kind: 'clear' }, { kind: 'text', text: 'fresh start' }],
      'b',
      true,
    );
    expect(next).toHaveLength(1);
    expect(firstId).toBe(next[0]!.id);
  });

  test('clear wipes the scrollback only when clears are allowed', () => {
    const prior = appendUnits([], [{ kind: 'text', text: 'earlier' }], 'a', true).next;
    expect(appendUnits(prior, [{ kind: 'clear' }], 'b', true).next).toEqual([]);
    expect(appendUnits(prior, [{ kind: 'clear' }], 'b', false).next).toEqual(prior);
  });
});
