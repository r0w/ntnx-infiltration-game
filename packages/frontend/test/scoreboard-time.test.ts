import { describe, expect, test } from 'bun:test';
import { heldMs, idleMs, netElapsedMs, scoreTimeMs, type CardClock } from '../src/scoreboardTime';

const MIN = 60_000;

function clock(over: Partial<CardClock> = {}): CardClock {
  return { startedAt: 0, finishedAt: null, lastActivityAt: null, ...over };
}

describe('netElapsedMs', () => {
  test('a player who was never held plays for the whole elapsed time', () => {
    expect(netElapsedMs(clock(), 40 * MIN)).toBe(40 * MIN);
  });

  test('time held in waits that are over is not counted', () => {
    expect(netElapsedMs(clock({ blockedMs: 12 * MIN }), 40 * MIN)).toBe(28 * MIN);
  });

  test('the clock stops while the player is held, however long the wait lasts', () => {
    const held = clock({ blockedMs: 5 * MIN, blockedSince: 20 * MIN });
    expect(netElapsedMs(held, 25 * MIN)).toBe(15 * MIN);
    expect(netElapsedMs(held, 90 * MIN)).toBe(15 * MIN);
  });

  test('a finished player stops at the finish', () => {
    const done = clock({ finishedAt: 50 * MIN, blockedMs: 20 * MIN });
    expect(netElapsedMs(done, 500 * MIN)).toBe(30 * MIN);
  });

  test('a late start counts from the start', () => {
    expect(netElapsedMs(clock({ startedAt: 20 * MIN, finishedAt: 65 * MIN }), 99 * MIN)).toBe(45 * MIN);
  });

  test('never negative', () => {
    expect(netElapsedMs(clock({ blockedMs: 90 * MIN }), 40 * MIN)).toBe(0);
  });
});

describe('scoreTimeMs', () => {
  test('is the playing time when no help was used', () => {
    expect(scoreTimeMs(clock(), 40 * MIN)).toBe(40 * MIN);
    expect(scoreTimeMs(clock({ helpPenaltySec: 0 }), 40 * MIN)).toBe(40 * MIN);
  });

  test('adds the help penalties to the playing time', () => {
    expect(scoreTimeMs(clock({ helpPenaltySec: 270 }), 40 * MIN)).toBe(40 * MIN + 270_000);
    expect(scoreTimeMs(clock({ blockedMs: 10 * MIN, helpPenaltySec: 120 }), 40 * MIN)).toBe(32 * MIN);
  });

  test('is the time a finished player is ranked on', () => {
    const done = clock({ startedAt: 5 * MIN, finishedAt: 50 * MIN, blockedMs: 20 * MIN, helpPenaltySec: 270 });
    expect(scoreTimeMs(done, 500 * MIN)).toBe(25 * MIN + 270_000);
  });

  test('a held player keeps a stopped clock, penalty included', () => {
    const held = clock({ blockedSince: 20 * MIN, helpPenaltySec: 120 });
    expect(scoreTimeMs(held, 25 * MIN)).toBe(22 * MIN);
    expect(scoreTimeMs(held, 90 * MIN)).toBe(22 * MIN);
  });

  test('a negative or missing penalty adds nothing', () => {
    expect(scoreTimeMs(clock({ helpPenaltySec: -30 }), 10 * MIN)).toBe(10 * MIN);
    expect(scoreTimeMs(clock({ helpPenaltySec: undefined }), 10 * MIN)).toBe(10 * MIN);
  });
});

describe('heldMs', () => {
  test('null when the player is not held, else the time since the wait began', () => {
    expect(heldMs({ blockedSince: null }, 10 * MIN)).toBeNull();
    expect(heldMs({}, 10 * MIN)).toBeNull();
    expect(heldMs({ blockedSince: 4 * MIN }, 10 * MIN)).toBe(6 * MIN);
  });
});

describe('idleMs', () => {
  test('time since the last check', () => {
    expect(idleMs(clock({ lastActivityAt: 6 * MIN }), 10 * MIN)).toBe(4 * MIN);
  });

  test('a player who has done nothing yet has no idle time to show', () => {
    expect(idleMs(clock(), 10 * MIN)).toBeNull();
  });

  test('not shown for a finished player', () => {
    expect(idleMs(clock({ finishedAt: 9 * MIN, lastActivityAt: 1 * MIN }), 10 * MIN)).toBeNull();
  });

  test('not shown while the player is held: that is a wait, not inactivity', () => {
    expect(idleMs(clock({ lastActivityAt: 1 * MIN, blockedSince: 2 * MIN }), 30 * MIN)).toBeNull();
  });

  test('restarts at the release, so the wait does not show up as inactivity', () => {
    const released = clock({ lastActivityAt: 1 * MIN, lastReleasedAt: 30 * MIN });
    expect(idleMs(released, 31 * MIN)).toBe(1 * MIN);
  });

  test('a check after the release takes over again', () => {
    const resumed = clock({ lastActivityAt: 33 * MIN, lastReleasedAt: 30 * MIN });
    expect(idleMs(resumed, 34 * MIN)).toBe(1 * MIN);
  });
});
