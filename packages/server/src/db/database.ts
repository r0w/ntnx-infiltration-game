import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrate';

const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export interface DbConfig {
  /** Path to SQLite file, or ':memory:' for tests. */
  path: string;
}

export function openDatabase({ path }: DbConfig): Database {
  const db = new Database(path, { create: true });
  // Migrate FIRST so legacy INTEGER stage columns are rewritten to TEXT before
  // schema.sql's CREATE IF NOT EXISTS statements see a mismatched shape. Safe
  // on fresh DBs (no tables yet → migrator exits early).
  migrate(db);
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  return db;
}
