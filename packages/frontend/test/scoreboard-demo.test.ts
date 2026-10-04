import { describe, expect, test } from 'bun:test';
import { advanceDemo, makeDemoPayload } from '../src/scoreboardDemo';

describe('scoreboard simulation', () => {
  test('every unfinished participant can advance, across all ranks and clusters', () => {
    const original = makeDemoPayload(50, true);
    const snapshot = structuredClone(original);
    const playing = original.entries.filter((entry) => entry.finishedAt === null);
    const selected = new Set<string>();
    for (let index = 0; index < playing.length; index++) {
      const next = advanceDemo(original, () => (index + 0.5) / playing.length)!;
      const changed = next.entries.filter((entry) =>
        entry.stagesPassed !== original.entries.find((before) => before.sessionId === entry.sessionId)!.stagesPassed);
      expect(changed).toHaveLength(1);
      expect(changed[0]!.sessionId).toBe(playing[index]!.sessionId);
      expect(changed[0]!.stagesPassed).toBe(playing[index]!.stagesPassed + 1);
      selected.add(changed[0]!.sessionId);
      expect(next.entries.map((entry) => entry.rank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      expect(next.entries.every((entry, i, entries) => i === 0 || entries[i - 1]!.stagesPassed >= entry.stagesPassed)).toBe(true);
    }
    expect(selected.size).toBe(49);
    expect(original).toEqual(snapshot);
  });

  test('completes the last stage once and preserves finished participants', () => {
    const original = makeDemoPayload(1, false);
    expect(original.entries[0]!.stagesPassed).toBeLessThan(original.totalStages);
    const completed = advanceDemo(original, () => 0)!;
    expect(completed.entries[0]).toMatchObject({
      status: 'finished', stageName: null, stagesPassed: original.totalStages,
    });
    expect(completed.entries[0]!.finishedAt).toBeNumber();
    expect(advanceDemo(completed)).toBe(completed);
    expect(advanceDemo(null)).toBeNull();
    const empty = { ...original, entries: [] };
    expect(advanceDemo(empty)).toBe(empty);
  });
});
