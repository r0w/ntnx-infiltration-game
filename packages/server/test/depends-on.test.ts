import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { StageDefinition } from '@ntnx-game/engine';
import { analyzeDeps, cascadeDisable } from '../src/dep-analysis';
import { loadPack } from '../src/pack-loader';

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

  test('a variable seeded before the run does not count as missing', () => {
    const stages = [stage('uses-it', { needs: ['DashboardUrl'] })];
    // Without being told, the analysis only knows the infiltration game's own
    // seeded names and calls a second game's stage broken.
    expect(analyzeDeps({ stages }).broken.map((b) => b.stageName)).toEqual(['uses-it']);
    expect(
      analyzeDeps({ stages, envSeeded: new Set(['DashboardUrl']) }).broken,
    ).toEqual([]);
  });
});

/**
 * The shipped packs, not a fixture. Issue #71: the machinery was intact but the
 * infiltration game declared no prerequisites at all, so `/admin` let an
 * operator turn off `create-vm` and still call the six stages that act on that
 * VM healthy.
 */
describe('the shipped packs declare their prerequisites', () => {
  const packsDir = resolve(import.meta.dir, '../../../packs');

  test('ntnx-infiltration: disabling create-vm takes everything that touches the VM', async () => {
    const pack = await loadPack(packsDir, 'ntnx-infiltration');
    const { cascade } = cascadeDisable(pack.stages, new Set(['create-vm']));
    expect(cascade.map((b) => b.stageName)).toEqual([
      'verify-prod-user-isolation',
      'live-migrate-vm',
      'apply-category-to-vm',
      'incident-freeze',
      'restore-vm-from-recovery',
      'test-ncm-playbook',
    ]);
  });

  test('ntnx-infiltration: the policy chain cascades from the category', async () => {
    const pack = await loadPack(packsDir, 'ntnx-infiltration');
    const { cascade } = cascadeDisable(pack.stages, new Set(['create-category']));
    expect(cascade.map((b) => b.stageName).sort()).toEqual([
      'allow-ssh-in-microseg',
      'apply-category-to-vm',
      'create-approval-policy',
      'create-microseg-policy',
      'create-protection-policy',
      'verify-protection-secure',
    ]);
  });

  test('nkp-bootcamp: disabling create-project takes the labs that live in its namespace', async () => {
    const pack = await loadPack(packsDir, 'nkp-bootcamp');
    const { cascade } = cascadeDisable(pack.stages, new Set(['create-project']));
    expect(cascade.map((b) => b.stageName).sort()).toEqual([
      'block-storage',
      'dynamic-gitops',
      'file-storage',
      'gitops-app',
      'gitops-source',
      'wordpress-ingress',
    ]);
  });

  test('nkp-bootcamp: the optional terminal labs are outside the project', async () => {
    const pack = await loadPack(packsDir, 'nkp-bootcamp');
    const { disabled } = cascadeDisable(pack.stages, new Set(['create-project']));
    // deploy-app writes to `default` on the management cluster, so the project
    // going away must not take it — the cleanup removes those objects by hand
    // precisely because nothing else does.
    for (const lab of ['deploy-app', 'expose-service', 'loadbalancer', 'ingress']) {
      expect(`${lab}:${disabled.has(lab)}`).toBe(`${lab}:false`);
    }
  });
});
