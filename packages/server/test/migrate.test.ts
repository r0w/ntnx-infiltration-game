import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/database';
import { migrate } from '../src/db/migrate';

// An instance rolled with the day-2 UpdateGame action keeps its SQLite file,
// so a column added to `sessions` must be created on the existing table:
// `CREATE TABLE IF NOT EXISTS` in schema.sql never alters one.

function columns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

/** `sessions` as it was before the step-by-step help feature (no help_enabled). */
const OLD_SESSIONS = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    trigram TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    username TEXT,
    pack_id TEXT NOT NULL,
    current_stage TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    locale TEXT NOT NULL DEFAULT 'en',
    cluster_endpoint TEXT NOT NULL DEFAULT '',
    cluster_profile TEXT NOT NULL DEFAULT 'other',
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    awaiting_variable TEXT,
    awaiting_stage TEXT,
    awaiting_render_offset INTEGER,
    pending_check_stage TEXT,
    pending_check_retry_variable TEXT,
    pending_check_retry_offset INTEGER,
    session_mode TEXT NOT NULL DEFAULT 'manual',
    stage_entered_at INTEGER
  );
`;

describe('sessions.help_enabled migration', () => {
  test('adds the column to an existing table and keeps its rows', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SESSIONS);
    db.prepare(
      `INSERT INTO sessions (id, trigram, pin_hash, pack_id, started_at)
       VALUES ('s1', 'abc', '', 'p', 1000)`,
    ).run();
    expect(columns(db, 'sessions')).not.toContain('help_enabled');

    migrate(db);

    expect(columns(db, 'sessions')).toContain('help_enabled');
    const row = db.prepare('SELECT id, help_enabled FROM sessions').get() as {
      id: string;
      help_enabled: number | null;
    };
    expect(row).toEqual({ id: 's1', help_enabled: null });
  });

  test('is idempotent', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SESSIONS);
    migrate(db);
    migrate(db);
    expect(columns(db, 'sessions').filter((c) => c === 'help_enabled')).toHaveLength(1);
  });

  test('openDatabase on an old file yields a usable help_usage table and the new column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ntnx-migrate-'));
    try {
      const path = join(dir, 'game.db');
      const old = new Database(path, { create: true });
      old.exec(OLD_SESSIONS);
      old.prepare(
        `INSERT INTO sessions (id, trigram, pin_hash, pack_id, started_at)
         VALUES ('s1', 'abc', '', 'p', 1000)`,
      ).run();
      old.close();

      const db = openDatabase({ path });
      expect(columns(db, 'sessions')).toContain('help_enabled');
      db.prepare(
        `INSERT INTO help_usage (session_id, stage_name, penalty_sec, used_at) VALUES ('s1', 'x', 60, 1)`,
      ).run();
      expect((db.prepare('SELECT COUNT(*) AS n FROM help_usage').get() as { n: number }).n).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a fresh database already has the column and the table', () => {
    const db = openDatabase({ path: ':memory:' });
    expect(columns(db, 'sessions')).toContain('help_enabled');
    expect(columns(db, 'help_usage')).toEqual(['session_id', 'stage_name', 'penalty_sec', 'used_at']);
  });
});

/** `pack_overlay` as it was before the help-penalty override (no help_penalty_sec). */
const OLD_OVERLAY = `
  CREATE TABLE pack_overlay (
    pack_id TEXT NOT NULL,
    stage_name TEXT NOT NULL,
    active INTEGER,
    admin_gate INTEGER,
    PRIMARY KEY (pack_id, stage_name)
  );
`;

describe('pack_overlay.help_penalty_sec migration', () => {
  test('adds the column to an existing table and keeps its rows', () => {
    const db = new Database(':memory:');
    db.exec(OLD_OVERLAY);
    db.prepare(
      `INSERT INTO pack_overlay (pack_id, stage_name, active, admin_gate) VALUES ('p', 'create-vm', 0, 1)`,
    ).run();
    expect(columns(db, 'pack_overlay')).not.toContain('help_penalty_sec');

    migrate(db);

    expect(columns(db, 'pack_overlay')).toContain('help_penalty_sec');
    expect(db.prepare('SELECT stage_name, active, admin_gate, help_penalty_sec FROM pack_overlay').get()).toEqual({
      stage_name: 'create-vm',
      active: 0,
      admin_gate: 1,
      help_penalty_sec: null,
    });
  });

  test('is idempotent, and a database without the table is left alone', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(columns(db, 'pack_overlay')).toEqual([]);

    db.exec(OLD_OVERLAY);
    migrate(db);
    migrate(db);
    expect(columns(db, 'pack_overlay').filter((c) => c === 'help_penalty_sec')).toHaveLength(1);
  });

  test('openDatabase on an old file keeps the overrides and accepts a penalty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ntnx-migrate-overlay-'));
    try {
      const path = join(dir, 'game.db');
      const old = new Database(path, { create: true });
      old.exec(OLD_OVERLAY);
      old.exec(OLD_SESSIONS);
      old.prepare(
        `INSERT INTO pack_overlay (pack_id, stage_name, active, admin_gate) VALUES ('p', 'create-vm', 0, NULL)`,
      ).run();
      old.close();

      const db = openDatabase({ path });
      db.prepare(
        `UPDATE pack_overlay SET help_penalty_sec = 150 WHERE pack_id = 'p' AND stage_name = 'create-vm'`,
      ).run();
      expect(db.prepare('SELECT active, help_penalty_sec FROM pack_overlay').get()).toEqual({
        active: 0,
        help_penalty_sec: 150,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a fresh database has the column', () => {
    const db = openDatabase({ path: ':memory:' });
    expect(columns(db, 'pack_overlay')).toContain('help_penalty_sec');
  });
});

