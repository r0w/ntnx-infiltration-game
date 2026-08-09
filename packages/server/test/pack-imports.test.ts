/**
 * A pack may only *type*-import a workspace package.
 *
 * This is not a style rule. The runtime image bundles the server and copies
 * `packs/` beside it, with **no `node_modules` anywhere** — so a bare specifier
 * in a pack file resolves fine on a developer's machine, where the workspace
 * links exist, and kills the container at boot with `Cannot find module`. That
 * asymmetry is the whole danger: every local check passes, and the first sign
 * of trouble is a game that will not start on the cluster it was rolled to.
 *
 * Type imports are erased before anything runs, so they cost nothing and stay
 * allowed. Anything a pack needs at *runtime* either lives in the pack (see
 * `checks/helpers.ts`) or is handed to it on a context (see `PackProbes`).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');
const PACKS = join(ROOT, 'packs');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'assets') continue;
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** `import type { … } from '@ntnx-game/x'` and `import { type A } from …`. */
function isTypeOnly(statement: string): boolean {
  if (/^import\s+type\b/.test(statement)) return true;
  const braces = statement.match(/^import\s*\{([^}]*)\}/);
  if (!braces) return false;
  const names = braces[1]!
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((n) => n.startsWith('type '));
}

describe('packs never value-import a workspace package', () => {
  const files = tsFilesUnder(PACKS);

  test('there are pack sources to check at all', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  test('every @ntnx-game import in every pack is type-only', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/^import[\s\S]*?from\s*'(@ntnx-game\/[^']+)';/gm)) {
        if (!isTypeOnly(m[0]!)) {
          offenders.push(`${relative(ROOT, file)} → ${m[1]}`);
        }
      }
      // A dynamic import is the same failure, deferred to first call.
      for (const m of src.matchAll(/import\(\s*'(@ntnx-game\/[^']+)'/g)) {
        offenders.push(`${relative(ROOT, file)} → await import(${m[1]})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
