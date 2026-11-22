import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Locks invariants that silently rotted in the past: the dependency audit's
// orphan detection (issue #31 session), fixture placeholders that only
// resolved through a since-removed captured var ({UserUUID}), and — since the
// second pack — prerequisites naming a stage the pack cannot satisfy.
//
// Every pack in the repo is audited. A test that names one pack stops covering
// the pack added after it, which is exactly how the first game's assumptions
// reached the second.

const ROOT = resolve(import.meta.dir, '../../..');
const PACKS = join(ROOT, 'packs');
const SCRIPT = join(ROOT, 'tooling/audit-stage-deps.ts');

const PACK_IDS = readdirSync(PACKS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((id) => {
    try {
      readFileSync(join(PACKS, id, 'pack.json'), 'utf8');
      return true;
    } catch {
      return false;
    }
  })
  .sort();

function runAudit(...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(['bun', SCRIPT, ...args], { cwd: ROOT });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe('pack integrity', () => {
  test('at least the two shipped packs are audited', () => {
    expect(PACK_IDS).toContain('ntnx-infiltration');
    expect(PACK_IDS).toContain('nkp-bootcamp');
  });

  for (const id of PACK_IDS) {
    test(`${id}: dependency graph has no orphan variables`, () => {
      const { code, out } = runAudit(id, '--json');
      expect(code).toBe(0);
      const report = JSON.parse(out) as { orphans: unknown[] };
      expect(report.orphans).toEqual([]);
    });

    test(`${id}: every dependsOn names an earlier stage of the same pack`, () => {
      const { code, out } = runAudit(id, '--json');
      expect(code).toBe(0);
      const report = JSON.parse(out) as { brokenPrereqs: unknown[] };
      expect(report.brokenPrereqs).toEqual([]);
    });
  }

  test('stage JSON needs/captures carry no drift vs --apply, in any pack', () => {
    const { code, out, err } = runAudit('--check');
    expect(`${out}${err}`).not.toContain('out of date');
    expect(code).toBe(0);
  });

  test('every fixture placeholder resolves to a seeded or player-input var', () => {
    for (const id of PACK_IDS) {
      const dir = join(PACKS, id);
      const fixtures = readFileSync(join(dir, 'fixtures.json'), 'utf8');
      const en = JSON.parse(readFileSync(join(dir, 'locales/en.json'), 'utf8')) as Record<
        string,
        string
      >;
      const inputVars = new Set<string>();
      for (const template of Object.values(en)) {
        for (const m of String(template).matchAll(/<input\s+var=['"](\w+)['"]\s*\/>/g)) {
          inputVars.add(m[1]);
        }
      }
      // The pack's own audit config is the list of what exists before a stage
      // runs — the same source the audit reads, so the two cannot drift apart.
      const cfg = JSON.parse(readFileSync(join(dir, 'audit.json'), 'utf8')) as {
        envSeeded?: string[];
        checkCaptures?: Record<string, string[]>;
      };
      const captured = Object.values(cfg.checkCaptures ?? {}).flat();
      // Projected at session create rather than seeded at boot, so they are in
      // neither list but are just as available to a fixture.
      const sessionProjected = ['OldPC', 'OldPCUsername', 'OldPCPassword'];
      const allowed = new Set([
        ...(cfg.envSeeded ?? []),
        ...captured,
        ...sessionProjected,
        ...inputVars,
      ]);
      const unresolved = new Set<string>();
      for (const m of fixtures.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) {
        if (!allowed.has(m[1])) unresolved.add(m[1]);
      }
      expect({ pack: id, unresolved: [...unresolved] }).toEqual({ pack: id, unresolved: [] });
    }
  });
});
