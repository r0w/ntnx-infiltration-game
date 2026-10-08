import { describe, expect, test } from 'bun:test';
import { readerPosition } from '../src/GameApp';

/**
 * The stage menu draws three states off one number, so getting it wrong shows
 * a player a tick beside a step they have not done. The trap is that the
 * session reports its position two different ways depending on whether a
 * prompt happens to be on screen.
 */

const ORDER = ['welcome', 'quick-tour', 'access', 'workspaces'];

describe('readerPosition', () => {
  test('a fresh session sits on the first stage', () => {
    expect(readerPosition(ORDER, null, null, false)).toEqual({ index: 0, stage: 'welcome' });
  });

  test('parked at a prompt, the awaiting stage is where the player is', () => {
    expect(readerPosition(ORDER, 'welcome', 'quick-tour', false)).toEqual({
      index: 1,
      stage: 'quick-tour',
    });
  });

  // Mid-stream there is no prompt, and currentStage names the stage just
  // *finished* — reading it as the position would tick the current row early.
  test('mid-stream, the position is one past the last completed stage', () => {
    expect(readerPosition(ORDER, 'quick-tour', null, false)).toEqual({
      index: 2,
      stage: 'access',
    });
  });

  test('a finished run is past the end, so every row reads as done', () => {
    expect(readerPosition(ORDER, 'workspaces', null, true)).toEqual({
      index: ORDER.length,
      stage: null,
    });
  });

  // A stage filtered out of this session's run (capability gate) can still be
  // named by the server. Falling back to the start beats reporting -1, which
  // would mark the whole menu as ahead of the player.
  test('an unknown stage name falls back to the start rather than to -1', () => {
    expect(readerPosition(ORDER, 'not-in-this-run', null, false)).toEqual({
      index: 0,
      stage: 'welcome',
    });
  });

  test('the last stage in the run has no next, and says so', () => {
    expect(readerPosition(ORDER, 'workspaces', null, false)).toEqual({
      index: 4,
      stage: null,
    });
  });
});
