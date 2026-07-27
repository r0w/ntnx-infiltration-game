import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClusterConfigQueries } from '../src/db/queries';
import {
  effectiveSupportedLocales,
  readEnabledWipLocales,
  writeEnabledWipLocales,
} from '../src/effective-locales';

const SCHEMA = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/db/schema.sql'),
  'utf8',
);

function freshCfg(): ClusterConfigQueries {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return new ClusterConfigQueries(db);
}

describe('effectiveSupportedLocales (issue #65)', () => {
  const supported = ['en', 'fr', 'de', 'es', 'it'];
  const wip = ['es', 'it'];
  let cfg: ClusterConfigQueries;
  beforeEach(() => {
    cfg = freshCfg();
  });

  test('mock mode always exposes WIP locales', () => {
    expect(effectiveSupportedLocales(supported, wip, 'mock', cfg)).toEqual([
      'en',
      'fr',
      'de',
      'es',
      'it',
    ]);
  });

  test('test mode always exposes WIP locales', () => {
    expect(effectiveSupportedLocales(supported, wip, 'test', cfg)).toEqual([
      'en',
      'fr',
      'de',
      'es',
      'it',
    ]);
  });

  test('live mode hides WIP locales by default', () => {
    expect(effectiveSupportedLocales(supported, wip, 'live', cfg)).toEqual([
      'en',
      'fr',
      'de',
    ]);
  });

  test('live mode surfaces a WIP locale once the operator enables it', () => {
    writeEnabledWipLocales(cfg, ['es']);
    expect(effectiveSupportedLocales(supported, wip, 'live', cfg)).toEqual([
      'en',
      'fr',
      'de',
      'es',
    ]);
  });

  test('live mode with both WIP enabled → both visible', () => {
    writeEnabledWipLocales(cfg, ['es', 'it']);
    expect(effectiveSupportedLocales(supported, wip, 'live', cfg)).toEqual(supported);
  });

  test('non-WIP locales are never filtered, even if listed in enabled set', () => {
    // Defensive: garbage in the stored array (a code that isn't WIP) is
    // ignored by the filter — the wip list is the source of truth.
    writeEnabledWipLocales(cfg, ['en']);
    expect(effectiveSupportedLocales(supported, wip, 'live', cfg)).toEqual([
      'en',
      'fr',
      'de',
    ]);
  });

  test('undefined/empty wipLocales → identity filter', () => {
    expect(effectiveSupportedLocales(supported, undefined, 'live', cfg)).toEqual(
      supported,
    );
    expect(effectiveSupportedLocales(supported, [], 'live', cfg)).toEqual(supported);
  });

  test('readEnabledWipLocales returns [] when unset or malformed', () => {
    expect(readEnabledWipLocales(cfg)).toEqual([]);
    // Non-string entries are filtered out defensively.
    cfg.set('wip_locales_enabled', ['es', 42, 'it'] as unknown as string[], 'admin');
    expect(readEnabledWipLocales(cfg)).toEqual(['es', 'it']);
  });

  test('writeEnabledWipLocales dedups + sorts', () => {
    writeEnabledWipLocales(cfg, ['it', 'es', 'it']);
    expect(readEnabledWipLocales(cfg)).toEqual(['es', 'it']);
  });
});
