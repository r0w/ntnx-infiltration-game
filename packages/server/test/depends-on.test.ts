import { describe, expect, test } from 'bun:test';
import type { StageDefinition } from '@ntnx-game/engine';
import { analyzeDeps, cascadeDisable } from '../src/dep-analysis';

/**
 * `needs` models data flowing between stages. `dependsOn` models state left on
 * the cluster: the bootcamp's storage lab consumes the namespace create-project
 * made, not a variable, so only a named prerequisite catches that break.
 */

const stage = (name: string, extra: Partial<StageDefinition> = {}): StageDefinition =>
  ({ id: name, name, index: 0, active: true, messages: [], ...extra }) as StageDefinition;

const PACK: StageDefinition[] = [
  stage('create-project'),
  stage('block-storage', { dependsOn: ['create-project'] }),
  stage('file-storage', { dependsOn: ['block-storage'] }),
  stage('quick-tour'),
];

describe('stage prerequisites', () => {
  test('nothing is broken while every prerequisite is on', () => {
    expect(analyzeDeps({ stages: PACK }).broken).toEqual([]);
  });

  test('disabling a prerequisite breaks the stage that needs its state', () => {
    const r = analyzeDeps({ stages: PACK, disabledNames: new Set(['create-project']) });
    expect(r.broken.map((b) => b.stageName)).toEqual(['block-storage']);
    expect(r.broken[0]!.missingStages).toEqual(['create-project']);
    expect(r.broken[0]!.missingVars).toEqual([]);
  });

  test('the cascade follows the chain to the end', () => {
    const { disabled, cascade } = cascadeDisable(PACK, new Set(['create-project']));
    expect([...disabled].sort()).toEqual(['block-storage', 'create-project', 'file-storage']);
    expect(cascade.map((b) => b.stageName)).toEqual(['block-storage', 'file-storage']);
  });

  test('a stage off the chain is left alone', () => {
    const { disabled } = cascadeDisable(PACK, new Set(['create-project']));
    expect(disabled.has('quick-tour')).toBe(false);
  });

  test('a prerequisite the pack does not ship is ignored, not fatal', () => {
    const odd = [stage('a', { dependsOn: ['ghost'] })];
    expect(analyzeDeps({ stages: odd }).broken).toEqual([]);
  });
});
