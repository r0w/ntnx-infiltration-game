import type { Database } from 'bun:sqlite';

/**
 * Phase 11 migration — stage identity switches from sparse numeric `id` to
 * stable string `name`. Detects the old INTEGER schema by looking at
 * `sessions.current_stage`'s declared type; when old, rewrites every
 * stage-id-bearing column to TEXT and backfills from the hardcoded
 * pre-phase-11 id→name map for the ntnx-infiltration pack.
 *
 * Fresh DBs get the new schema directly from schema.sql and this migration
 * is a no-op.
 *
 * The map is a literal snapshot of the pack as-of 2026-04-24 (39 stages,
 * gap at id=5 from the intro-credentials merge). Legacy rows referencing
 * an id that's not in the map (none expected; this is dev data) fall
 * through to NULL on sessions.current_stage and are dropped from
 * stage_history / pack_overlay / gate_unlocks.
 */
const NTNX_INFILTRATION_OLD_IDS: Record<number, string> = {
  0: 'lore',
  1: 'login',
  2: 'recovery-gate',
  3: 'intro-tank-greet',
  4: 'intro-mission',
  // 5 was the merged-away intro-credentials — no mapping
  6: 'create-admin-user',
  7: 'create-auth-policy',
  8: 'switch-to-admin-user',
  9: 'create-project',
  10: 'create-subnet',
  11: 'add-ubuntu-image',
  12: 'create-vm',
  13: 'verify-prod-user-isolation',
  14: 'live-migrate-vm',
  15: 'create-category',
  16: 'apply-category-to-vm',
  17: 'create-storage-policy',
  18: 'create-microseg-policy',
  19: 'allow-ssh-in-microseg',
  20: 'create-protection-policy',
  21: 'create-approval-policy',
  22: 'verify-protection-secure',
  23: 'incident-freeze',
  24: 'incident-reconnect',
  25: 'welcome-back',
  26: 'restore-vm-from-recovery',
  27: 'create-report',
  28: 'expand-cluster',
  29: 'lcm-check-updates',
  30: 'security-dashboard',
  31: 'capacity-runway',
  32: 'resource-optimization',
  33: 'create-ncm-playbook',
  34: 'test-ncm-playbook',
  35: 'clone-app-blueprint',
  36: 'schedule-day2-action',
  37: 'modify-blueprint',
  38: 'mission-complete',
  39: 'outro-cleanup',
};

function columnType(db: Database, table: string, column: string): string | null {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string; type: string }>;
  const col = rows.find((r) => r.name === column);
  return col?.type ?? null;
}

/** Idempotent `ALTER TABLE ADD COLUMN` — no-op if the column already exists. */
function addColumnIfMissing(db: Database, table: string, name: string, ddl: string): void {
  if (columnType(db, table, name) !== null) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

function mapId(id: number | null): string | null {
  if (id === null || id === undefined) return null;
  if (id < 0) return null; // old -1 sentinel = pre-game
  return NTNX_INFILTRATION_OLD_IDS[id] ?? null;
}

export function migrate(db: Database): void {
  // Additive columns, applied before schema.sql's CREATE IF NOT EXISTS pass so
  // they land on both old- and new-schema DBs.
  const hasSessionsTable = columnType(db, 'sessions', 'id') !== null;
  if (hasSessionsTable) {
    // Phase 10: auto-play session mode.
    addColumnIfMissing(db, 'sessions', 'session_mode', `TEXT NOT NULL DEFAULT 'manual'`);
    // Two-phase themed check (2026-06-06): deferred-check state, all nullable.
    addColumnIfMissing(db, 'sessions', 'pending_check_stage', 'TEXT');
    addColumnIfMissing(db, 'sessions', 'pending_check_retry_variable', 'TEXT');
    addColumnIfMissing(db, 'sessions', 'pending_check_retry_offset', 'INTEGER');
  }

  // 2026-04-27: cluster_profile values renamed for clarity.
  //   'shared'    → 'other'  (fail-safe; destructive stages filtered)
  //   'dedicated' → 'hpoc'   (recognized lab cluster; destructives run)
  // Idempotent: re-running on already-migrated rows is a no-op.
  if (hasSessionsTable) {
    db.exec(
      `UPDATE sessions SET cluster_profile = 'other' WHERE cluster_profile = 'shared'`,
    );
    db.exec(
      `UPDATE sessions SET cluster_profile = 'hpoc' WHERE cluster_profile = 'dedicated'`,
    );
  }

  // Phase 11: stage_id INTEGER → stage_name TEXT across the schema. Detect
  // by the `sessions.current_stage` type — it was `INTEGER NOT NULL` under
  // the old schema, is `TEXT` under the new one.
  const currentStageType = columnType(db, 'sessions', 'current_stage');
  if (currentStageType === null) return; // no sessions table yet — fresh DB
  const needsStageNameMigration = currentStageType.toUpperCase().includes('INT');
  if (!needsStageNameMigration) return;

  db.transaction(() => {
    // --- sessions.current_stage + sessions.awaiting_stage_id ---
    db.exec(`ALTER TABLE sessions RENAME COLUMN current_stage TO current_stage_int`);
    db.exec(`ALTER TABLE sessions ADD COLUMN current_stage TEXT`);
    db.exec(`ALTER TABLE sessions RENAME COLUMN awaiting_stage_id TO awaiting_stage_int`);
    db.exec(`ALTER TABLE sessions ADD COLUMN awaiting_stage TEXT`);
    const sessionRows = db
      .prepare(
        `SELECT id, current_stage_int, awaiting_stage_int FROM sessions`,
      )
      .all() as Array<{ id: string; current_stage_int: number | null; awaiting_stage_int: number | null }>;
    const updSession = db.prepare(
      `UPDATE sessions SET current_stage = $cs, awaiting_stage = $aw WHERE id = $id`,
    );
    for (const r of sessionRows) {
      updSession.run({
        $id: r.id,
        $cs: mapId(r.current_stage_int),
        $aw: mapId(r.awaiting_stage_int),
      });
    }
    db.exec(`ALTER TABLE sessions DROP COLUMN current_stage_int`);
    db.exec(`ALTER TABLE sessions DROP COLUMN awaiting_stage_int`);

    // --- session_variables.captured_at_stage ---
    db.exec(`ALTER TABLE session_variables RENAME COLUMN captured_at_stage TO captured_at_stage_int`);
    db.exec(`ALTER TABLE session_variables ADD COLUMN captured_at_stage TEXT`);
    const varRows = db
      .prepare(
        `SELECT session_id, name, captured_at_stage_int FROM session_variables`,
      )
      .all() as Array<{ session_id: string; name: string; captured_at_stage_int: number }>;
    const updVar = db.prepare(
      `UPDATE session_variables SET captured_at_stage = $s WHERE session_id = $sid AND name = $n`,
    );
    for (const r of varRows) {
      const name = mapId(r.captured_at_stage_int) ?? 'unknown';
      updVar.run({ $sid: r.session_id, $n: r.name, $s: name });
    }
    // Replace NULLs with 'unknown' for safety before enforcing NOT NULL.
    db.exec(`UPDATE session_variables SET captured_at_stage = 'unknown' WHERE captured_at_stage IS NULL`);
    db.exec(`ALTER TABLE session_variables DROP COLUMN captured_at_stage_int`);

    // --- stage_history: stage_id INTEGER → stage_name TEXT (PK changes) ---
    db.exec(`ALTER TABLE stage_history RENAME TO stage_history_old`);
    db.exec(`
      CREATE TABLE stage_history (
        session_id TEXT NOT NULL,
        stage_name TEXT NOT NULL,
        status TEXT NOT NULL,
        checked_at INTEGER NOT NULL,
        duration_ms INTEGER,
        detail TEXT,
        PRIMARY KEY (session_id, stage_name),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);
    const histRows = db
      .prepare(
        `SELECT session_id, stage_id, status, checked_at, duration_ms, detail FROM stage_history_old`,
      )
      .all() as Array<{
        session_id: string;
        stage_id: number;
        status: string;
        checked_at: number;
        duration_ms: number | null;
        detail: string | null;
      }>;
    const insHist = db.prepare(
      `INSERT OR IGNORE INTO stage_history (session_id, stage_name, status, checked_at, duration_ms, detail)
       VALUES ($sid, $sn, $st, $ca, $dm, $dt)`,
    );
    for (const r of histRows) {
      const name = mapId(r.stage_id);
      if (!name) continue; // orphaned rows (unknown old id) dropped
      insHist.run({
        $sid: r.session_id,
        $sn: name,
        $st: r.status,
        $ca: r.checked_at,
        $dm: r.duration_ms,
        $dt: r.detail,
      });
    }
    db.exec(`DROP TABLE stage_history_old`);

    // --- gate_unlocks: pack-scoped stage id → name ---
    db.exec(`ALTER TABLE gate_unlocks RENAME TO gate_unlocks_old`);
    db.exec(`
      CREATE TABLE gate_unlocks (
        pack_id TEXT NOT NULL,
        stage_name TEXT NOT NULL,
        unlocked_at INTEGER NOT NULL,
        PRIMARY KEY (pack_id, stage_name)
      )
    `);
    const gateRows = db
      .prepare(`SELECT pack_id, stage_id, unlocked_at FROM gate_unlocks_old`)
      .all() as Array<{ pack_id: string; stage_id: number; unlocked_at: number }>;
    const insGate = db.prepare(
      `INSERT OR IGNORE INTO gate_unlocks (pack_id, stage_name, unlocked_at) VALUES ($pid, $sn, $ua)`,
    );
    for (const r of gateRows) {
      const name = mapId(r.stage_id);
      if (!name) continue;
      insGate.run({ $pid: r.pack_id, $sn: name, $ua: r.unlocked_at });
    }
    db.exec(`DROP TABLE gate_unlocks_old`);

    // --- pack_overlay: per-pack stage override → name ---
    db.exec(`ALTER TABLE pack_overlay RENAME TO pack_overlay_old`);
    db.exec(`
      CREATE TABLE pack_overlay (
        pack_id TEXT NOT NULL,
        stage_name TEXT NOT NULL,
        active INTEGER,
        admin_gate INTEGER,
        PRIMARY KEY (pack_id, stage_name)
      )
    `);
    const overlayRows = db
      .prepare(`SELECT pack_id, stage_id, active, admin_gate FROM pack_overlay_old`)
      .all() as Array<{
        pack_id: string;
        stage_id: number;
        active: number | null;
        admin_gate: number | null;
      }>;
    const insOverlay = db.prepare(
      `INSERT OR IGNORE INTO pack_overlay (pack_id, stage_name, active, admin_gate)
       VALUES ($pid, $sn, $a, $ag)`,
    );
    for (const r of overlayRows) {
      const name = mapId(r.stage_id);
      if (!name) continue;
      insOverlay.run({
        $pid: r.pack_id,
        $sn: name,
        $a: r.active,
        $ag: r.admin_gate,
      });
    }
    db.exec(`DROP TABLE pack_overlay_old`);
  })();
}
