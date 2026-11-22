import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPack } from '../src/pack-loader';

// Two layers: the loader rejects malformed `help` / `helpPenaltySec` fields,
// and the shipped pack keeps its help blocks consistent (keys exist, images
// exist, variables are defined) so a typo never reaches a player.

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

async function loadWithStage(extra: Record<string, unknown>) {
  const packsDir = mkdtempSync(join(tmpdir(), 'ntnx-help-pack-'));
  tmpRoots.push(packsDir);
  const dir = join(packsDir, 'p');
  mkdirSync(join(dir, 'stages'), { recursive: true });
  writeFileSync(
    join(dir, 'pack.json'),
    JSON.stringify({
      id: 'p',
      name: 'P',
      version: '0.0.0',
      checks: './checks.ts',
      stagesDir: './stages',
      stages: ['one'],
      defaultLocale: 'en',
      supportedLocales: ['en'],
    }),
  );
  writeFileSync(
    join(dir, 'stages', 'one.json'),
    JSON.stringify({ id: 'eg-001', name: 'one', active: true, messages: ['k'], ...extra }),
  );
  return loadPack(packsDir, 'p');
}

describe('pack-loader help validation', () => {
  test('accepts a stage with help keys and a penalty', async () => {
    const pack = await loadWithStage({ help: ['h.1', 'h.2'], helpPenaltySec: 90 });
    expect(pack.stages[0]!.help).toEqual(['h.1', 'h.2']);
    expect(pack.stages[0]!.helpPenaltySec).toBe(90);
  });

  test('accepts help without a penalty (free help)', async () => {
    const pack = await loadWithStage({ help: ['h.1'] });
    expect(pack.stages[0]!.helpPenaltySec).toBeUndefined();
  });

  test('accepts a zero penalty', async () => {
    const pack = await loadWithStage({ help: ['h.1'], helpPenaltySec: 0 });
    expect(pack.stages[0]!.helpPenaltySec).toBe(0);
  });

  test.each([
    ['an empty help list', { help: [] }],
    ['a non-array help', { help: 'h.1' }],
    ['a non-string key', { help: ['h.1', 2] }],
    ['an empty key', { help: [''] }],
  ])('rejects %s', async (_label, extra) => {
    await expect(loadWithStage(extra)).rejects.toThrow('help must be a non-empty array of locale keys');
  });

  test.each([
    ['a negative penalty', { help: ['h.1'], helpPenaltySec: -5 }],
    ['a fractional penalty', { help: ['h.1'], helpPenaltySec: 1.5 }],
    ['a non-numeric penalty', { help: ['h.1'], helpPenaltySec: '120' }],
  ])('rejects %s', async (_label, extra) => {
    await expect(loadWithStage(extra)).rejects.toThrow('helpPenaltySec must be a non-negative integer');
  });

  test('rejects a penalty on a stage without help', async () => {
    await expect(loadWithStage({ helpPenaltySec: 60 })).rejects.toThrow('has no help');
  });
});

// ─── the shipped pack ────────────────────────────────────────────────

const ROOT = resolve(import.meta.dir, '../../..');
const PACK = join(ROOT, 'packs/ntnx-infiltration');

interface StageFile {
  name: string;
  help?: string[];
  helpPenaltySec?: number;
}

const stageFiles: StageFile[] = readdirSync(join(PACK, 'stages'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(PACK, 'stages', f), 'utf8')) as StageFile);
const withHelp = stageFiles.filter((s) => s.help !== undefined);

const catalogs: Record<string, Record<string, string>> = Object.fromEntries(
  readdirSync(join(PACK, 'locales'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => [
      f.replace(/\.json$/, ''),
      JSON.parse(readFileSync(join(PACK, 'locales', f), 'utf8')) as Record<string, string>,
    ]),
);
const en = catalogs.en!;

// Variables a help text may use: seeded from the env at boot (see
// packages/server/src/index.ts) or captured from the player's first inputs.
const KNOWN_VARS = new Set([
  'Trigram',
  'PIN',
  'Username',
  'PC',
  'PCUser',
  'PCPassword',
  'ImageURL',
  'SecondaryNetwork',
  'EmailReport',
  'ProdUsername',
  'ProdPassword',
  'frontendHost',
  'Vlanid',
  'OldPC',
  'OldPCUsername',
  'OldPCPassword',
]);

// Same filename rule as GET /api/pack-assets/:file in app.ts.
const ASSET_RE = /^[\w.-]+\.(png|jpe?g|webp|gif|svg)$/i;

describe('shipped pack help blocks', () => {
  test('at least the pilot stages ship a help block', () => {
    const names = withHelp.map((s) => s.name);
    for (const pilot of ['create-microseg-policy', 'allow-ssh-in-microseg', 'create-ncm-playbook']) {
      expect(names).toContain(pilot);
    }
  });

  test.each(withHelp.map((s) => [s.name, s] as const))('%s: every help key exists in en', (_n, stage) => {
    const missing = (stage.help ?? []).filter((k) => !Object.prototype.hasOwnProperty.call(en, k));
    expect(missing).toEqual([]);
  });

  test.each(withHelp.map((s) => [s.name, s] as const))('%s: help keys follow the stage prefix', (_n, stage) => {
    for (const key of stage.help ?? []) expect(key).toMatch(/^stage-\d{3}\.help-\d{2}$/);
  });

  test.each(withHelp.map((s) => [s.name, s] as const))('%s: penalty is a non-negative integer', (_n, stage) => {
    if (stage.helpPenaltySec === undefined) return;
    expect(Number.isInteger(stage.helpPenaltySec)).toBe(true);
    expect(stage.helpPenaltySec).toBeGreaterThanOrEqual(0);
  });

  test('help texts only use variables the game defines', () => {
    const unknown = new Set<string>();
    for (const stage of withHelp) {
      for (const key of stage.help ?? []) {
        for (const locale of Object.keys(catalogs)) {
          const text = catalogs[locale]![key];
          if (text === undefined) continue;
          for (const m of text.matchAll(/\{([A-Za-z_]\w*)\}/g)) {
            if (!KNOWN_VARS.has(m[1]!)) unknown.add(`${locale}:${key}:{${m[1]}}`);
          }
        }
      }
    }
    expect([...unknown]).toEqual([]);
  });

  test('help images exist in the pack assets and have a servable name', () => {
    const problems: string[] = [];
    for (const stage of withHelp) {
      for (const key of stage.help ?? []) {
        for (const locale of Object.keys(catalogs)) {
          const text = catalogs[locale]![key];
          if (text === undefined) continue;
          for (const m of text.matchAll(/<image\s+src=['"]([^'"]+)['"]/g)) {
            const file = m[1]!;
            if (!ASSET_RE.test(file)) problems.push(`${locale}:${key}: bad asset name ${file}`);
            else if (!existsSync(join(PACK, 'assets', file))) problems.push(`${locale}:${key}: missing ${file}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('translated help keys always have an en counterpart', () => {
    const orphans: string[] = [];
    for (const [locale, catalog] of Object.entries(catalogs)) {
      if (locale === 'en') continue;
      for (const key of Object.keys(catalog)) {
        if (/\.help-\d+$/.test(key) && !(key in en)) orphans.push(`${locale}:${key}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  test('help blocks carry no flow tags', () => {
    const flow = /<(input|pause|clear|pagebreak|action)\b/i;
    const offenders: string[] = [];
    for (const stage of withHelp) {
      for (const key of stage.help ?? []) {
        for (const [locale, catalog] of Object.entries(catalogs)) {
          if (catalog[key] !== undefined && flow.test(catalog[key]!)) offenders.push(`${locale}:${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
