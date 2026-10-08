import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPack } from '../src/pack-loader';
import { analyzeDeps } from '../src/dep-analysis';

test('the real pack loads with valid resource dependencies and no broken stages', async () => {
  const pack = await loadPack(resolve(import.meta.dir, '../../../packs'), 'ntnx-infiltration');
  expect(pack.stages.find((s) => s.name === 'apply-category-to-vm')?.dependsOn)
    .toEqual(['create-vm', 'create-category']);
  expect(analyzeDeps({ stages: pack.stages }).broken).toEqual([]);
});

for (const [dependencies, error] of [
  [['unknown'], 'must name an earlier stage'],
  [['second'], 'must name an earlier stage'],
  [['first', 'first'], 'duplicate dependencies'],
  ['first', 'must be an array'],
] as const) {
  test(`loader rejects invalid dependencies: ${JSON.stringify(dependencies)}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'nig-deps-'));
    try {
      await mkdir(join(root, 'test', 'stages'), { recursive: true });
      await writeFile(join(root, 'test', 'pack.json'), JSON.stringify({
        stagesDir: 'stages', stages: ['first', 'second'], checks: 'unused.ts',
      }));
      for (const name of ['first', 'second']) {
        await writeFile(join(root, 'test', 'stages', `${name}.json`), JSON.stringify({
          id: name, name, active: true, messages: [],
          ...(name === 'second' ? { dependsOn: dependencies } : {}),
        }));
      }
      await expect(loadPack(root, 'test')).rejects.toThrow(error);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
