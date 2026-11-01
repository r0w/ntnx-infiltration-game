import { describe, expect, test } from 'bun:test';
import { StageRunner } from '../src/stage-runner';
import { CheckRegistry } from '../src/check-registry';
import { VariableStore } from '../src/variables';
import type { LocaleBundle, StageDefinition } from '../src/types';

/**
 * A stage names a role (`system`, `tank`); the pack says who fills it. The
 * infiltration game's operator is a character called Tank, and a bootcamp
 * learner being addressed by him is a joke they are not in on.
 */

const BUNDLE: LocaleBundle = {
  defaultLocale: 'en',
  supported: ['en'],
  catalogs: { en: { 'k.a': 'hello' } },
};

function stage(prompt?: string): StageDefinition {
  return { id: 's-000', name: 'demo', index: 0, active: true, messages: ['k.a'], prompt };
}

function firstText(speakers: Record<string, string> | undefined, prompt?: string): string {
  const runner = new StageRunner([stage(prompt)], new CheckRegistry(), { speakers });
  const units = runner.render(stage(prompt), new VariableStore(), 'en', BUNDLE).units;
  return units[0]!.kind === 'text' ? units[0].text : '';
}

describe('speaker names', () => {
  test('with no map the label renders as the stage wrote it', () => {
    expect(firstText(undefined, 'tank')).toBe('<tank> ');
  });

  test('a pack can rename the operator without touching a single stage', () => {
    expect(firstText({ tank: 'instructor' }, 'tank')).toBe('<instructor> ');
  });

  // Renaming one role must not quietly rename the others.
  test('a label the map does not mention is left alone', () => {
    expect(firstText({ tank: 'instructor' }, 'system')).toBe('<system> ');
  });

  test('a stage with no speaker gets no tag, mapped or not', () => {
    expect(firstText({ tank: 'instructor' }, undefined)).not.toContain('<');
  });
});
