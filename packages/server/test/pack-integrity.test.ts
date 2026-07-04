import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Locks two invariants that silently rotted in the past: the dependency
// audit's orphan detection (issue #31 session) and fixture placeholders
// that only resolved through a since-removed captured var ({UserUUID}).

const ROOT = resolve(import.meta.dir, '../../..');
const PACK = join(ROOT, 'packs/ntnx-infiltration');
const SCRIPT = join(PACK, 'scripts/audit-stage-deps.ts');

function runAudit(flag: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(['bun', SCRIPT, flag], { cwd: ROOT });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe('pack integrity', () => {
  test('dependency graph has no orphan variables', () => {
    const { code, out } = runAudit('--json');
    expect(code).toBe(0);
    const report = JSON.parse(out) as { orphans: unknown[] };
    expect(report.orphans).toEqual([]);
  });

  test('stage JSON needs/captures carry no drift vs --apply', () => {
    const { code, out, err } = runAudit('--check');
    expect(`${out}${err}`).not.toContain('out of date');
    expect(code).toBe(0);
  });

  test('every fixture placeholder resolves to a seeded or player-input var', () => {
    const fixtures = readFileSync(join(PACK, 'fixtures.json'), 'utf8');
    const en = JSON.parse(readFileSync(join(PACK, 'locales/en.json'), 'utf8')) as Record<
      string,
      string
    >;
    const inputVars = new Set<string>();
    for (const template of Object.values(en)) {
      for (const m of String(template).matchAll(/<input\s+var=['"](\w+)['"]\s*\/>/g)) {
        inputVars.add(m[1]);
      }
    }
    // Mirrors initialVariables (packages/server/src/index.ts) + the
    // session-init vars (Vlanid, OldPC*) projected at session create.
    const seeded = [
      'PC',
      'PCUser',
      'PCPassword',
      'ImageURL',
      'EmailReport',
      'ProdUsername',
      'ProdPassword',
      'frontendHost',
      'Vlanid',
      'OldPC',
      'OldPCUsername',
      'OldPCPassword',
    ];
    const allowed = new Set([...seeded, ...inputVars]);
    const unresolved = new Set<string>();
    for (const m of fixtures.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) {
      if (!allowed.has(m[1])) unresolved.add(m[1]);
    }
    expect([...unresolved]).toEqual([]);
  });
});
