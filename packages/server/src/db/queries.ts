import type { Database } from 'bun:sqlite';
import type {
  CapabilityFlag,
  ClusterCacheEntry,
  ClusterProfile,
  Locale,
  StageStatus,
} from '@ntnx-game/engine';

export interface SessionRow {
  id: string;
  trigram: string;
  pin_hash: string;
  username: string | null;
  pack_id: string;
  current_stage: string | null;
  started_at: number;
  finished_at: number | null;
  locale: Locale;
  cluster_endpoint: string;
  cluster_profile: ClusterProfile;
  capabilities_json: string;
  awaiting_variable: string | null;
  awaiting_stage: string | null;
  awaiting_render_offset: number | null;
  pending_check_stage: string | null;
  pending_check_retry_variable: string | null;
  pending_check_retry_offset: number | null;
  stage_entered_at: number | null;
}

export interface SessionRecord {
  id: string;
  trigram: string;
  pinHash: string;
  username: string | null;
  packId: string;
  /** Canonical stage name (matches pack.json.stages[i]); `null` = pre-game. */
  currentStage: string | null;
  startedAt: number;
  finishedAt: number | null;
  locale: Locale;
  clusterEndpoint: string;
  clusterProfile: ClusterProfile;
  capabilities: CapabilityFlag[];
  awaiting: { variable: string; stageName: string; renderOffset: number } | null;
  /** Deferred check awaiting /resolve-check: stage owing it + the input to
   *  rewind to on failure. `null` = nothing pending. */
  pendingCheck: { stageName: string; retryVariable: string; retryOffset: number } | null;
  /** When the session entered its current stage segment (ms epoch). Reset on
   *  every current_stage transition; backs per-stage wall-time telemetry. */
  stageEnteredAt: number | null;
}

function rowToSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    trigram: row.trigram,
    pinHash: row.pin_hash,
    username: row.username,
    packId: row.pack_id,
    currentStage: row.current_stage,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    locale: row.locale,
    clusterEndpoint: row.cluster_endpoint,
    clusterProfile: row.cluster_profile,
    capabilities: JSON.parse(row.capabilities_json) as CapabilityFlag[],
    awaiting:
      row.awaiting_variable && row.awaiting_stage !== null
        ? {
            variable: row.awaiting_variable,
            stageName: row.awaiting_stage,
            renderOffset: row.awaiting_render_offset ?? 0,
          }
        : null,
    pendingCheck:
      row.pending_check_stage !== null
        ? {
            stageName: row.pending_check_stage,
            retryVariable: row.pending_check_retry_variable ?? '',
            retryOffset: row.pending_check_retry_offset ?? 0,
          }
        : null,
    stageEnteredAt: row.stage_entered_at,
  };
}

export interface CreateSessionInput {
  id: string;
  trigram: string;
  pinHash: string;
  username?: string | null;
  packId: string;
  locale: Locale;
  clusterEndpoint: string;
  clusterProfile: ClusterProfile;
  capabilities: CapabilityFlag[];
}

export class SessionQueries {
  constructor(private readonly db: Database) {}

  create(input: CreateSessionInput): SessionRecord {
    // current_stage is left NULL (pre-game) — the runner picks the first
    // playable stage on the initial advance. NULL replaces the pre-phase-11
    // `-1` sentinel.
    this.db
      .prepare(
        `INSERT INTO sessions (id, trigram, pin_hash, username, pack_id, current_stage, started_at, locale, cluster_endpoint, cluster_profile, capabilities_json, stage_entered_at)
         VALUES ($id, $trigram, $pinHash, $username, $packId, NULL, $startedAt, $locale, $clusterEndpoint, $clusterProfile, $capsJson, $startedAt)`,
      )
      .run({
        $id: input.id,
        $trigram: input.trigram,
        $pinHash: input.pinHash,
        $username: input.username ?? null,
        $packId: input.packId,
        $startedAt: Date.now(),
        $locale: input.locale,
        $clusterEndpoint: input.clusterEndpoint,
        $clusterProfile: input.clusterProfile,
        $capsJson: JSON.stringify(input.capabilities),
      });
    return this.byId(input.id)!;
  }

  byId(id: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = $id').get({ $id: id }) as
      | SessionRow
      | null;
    return row ? rowToSession(row) : null;
  }

  byTrigram(trigram: string, packId: string): SessionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE trigram = $trigram AND pack_id = $packId')
      .get({ $trigram: trigram, $packId: packId }) as SessionRow | null;
    return row ? rowToSession(row) : null;
  }

  updateCurrentStage(id: string, stageName: string | null): void {
    // Every transition re-stamps stage_entered_at: the delta between two
    // transitions is the wall-clock time the player spent on the stage.
    this.db
      .prepare(
        'UPDATE sessions SET current_stage = $stage, stage_entered_at = $ts WHERE id = $id',
      )
      .run({ $id: id, $stage: stageName, $ts: Date.now() });
  }

  setAwaiting(
    id: string,
    awaiting: { variable: string; stageName: string; renderOffset: number } | null,
  ): void {
    this.db
      .prepare(
        'UPDATE sessions SET awaiting_variable = $var, awaiting_stage = $stage, awaiting_render_offset = $offset WHERE id = $id',
      )
      .run({
        $id: id,
        $var: awaiting?.variable ?? null,
        $stage: awaiting?.stageName ?? null,
        $offset: awaiting?.renderOffset ?? null,
      });
  }

  setPendingCheck(
    id: string,
    pending: { stageName: string; retryVariable: string; retryOffset: number } | null,
  ): void {
    this.db
      .prepare(
        'UPDATE sessions SET pending_check_stage = $stage, pending_check_retry_variable = $var, pending_check_retry_offset = $offset WHERE id = $id',
      )
      .run({
        $id: id,
        $stage: pending?.stageName ?? null,
        $var: pending?.retryVariable ?? null,
        $offset: pending?.retryOffset ?? null,
      });
  }

  markFinished(id: string): void {
    this.db
      .prepare('UPDATE sessions SET finished_at = $ts WHERE id = $id')
      .run({ $id: id, $ts: Date.now() });
  }

  clearFinished(id: string): void {
    this.db
      .prepare('UPDATE sessions SET finished_at = NULL WHERE id = $id')
      .run({ $id: id });
  }

  /**
   * Hard-delete a session. All child rows (variables, history, cluster cache,
   * mock overlay) go with it via `ON DELETE CASCADE` — `PRAGMA foreign_keys`
   * is enabled per-connection in schema.sql. Returns the number of session
   * rows removed (0 or 1) so callers can distinguish "not found" from "done".
   */
  deleteById(id: string): number {
    const r = this.db.prepare('DELETE FROM sessions WHERE id = $id').run({ $id: id });
    return Number(r.changes);
  }

  /**
   * Admin view of sessions. Same join shape as scoreboard but also surfaces
   * the captured PIN — intentionally NOT leaked to the scoreboard (public
   * projector) but required here for the operator to identify a player who
   * claims to be "1234" and help them out.
   */
  listAdmin(packId: string): AdminSessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT
           s.id AS session_id,
           s.current_stage AS current_stage,
           s.started_at AS started_at,
           s.finished_at AS finished_at,
           s.locale AS locale,
           (SELECT value FROM session_variables
              WHERE session_id = s.id AND name = 'Trigram') AS trigram_var,
           (SELECT value FROM session_variables
              WHERE session_id = s.id AND name = 'Username') AS username_var,
           (SELECT value FROM session_variables
              WHERE session_id = s.id AND name = 'PIN') AS pin_var,
           (SELECT COUNT(*) FROM stage_history
              WHERE session_id = s.id AND status = 'passed') AS stages_passed,
           (SELECT COUNT(*) FROM stage_history
              WHERE session_id = s.id AND status = 'disabled') AS stages_disabled,
           (SELECT MAX(checked_at) FROM stage_history
              WHERE session_id = s.id) AS last_activity_at,
           (SELECT stage_name FROM stage_history
              WHERE session_id = s.id AND status = 'failed'
              ORDER BY checked_at DESC LIMIT 1) AS last_fail_stage,
           (SELECT detail FROM stage_history
              WHERE session_id = s.id AND status = 'failed'
              ORDER BY checked_at DESC LIMIT 1) AS last_fail_detail,
           (SELECT checked_at FROM stage_history
              WHERE session_id = s.id AND status = 'failed'
              ORDER BY checked_at DESC LIMIT 1) AS last_fail_at
         FROM sessions s
         WHERE s.pack_id = $packId
         ORDER BY s.started_at DESC`,
      )
      .all({ $packId: packId }) as Array<{
        session_id: string;
        current_stage: string | null;
        started_at: number;
        finished_at: number | null;
        locale: string;
        trigram_var: string | null;
        username_var: string | null;
        pin_var: string | null;
        stages_passed: number;
        stages_disabled: number;
        last_activity_at: number | null;
        last_fail_stage: string | null;
        last_fail_detail: string | null;
        last_fail_at: number | null;
      }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      trigram: parseJsonString(r.trigram_var),
      username: parseJsonString(r.username_var),
      pin: parseJsonString(r.pin_var),
      currentStage: r.current_stage,
      stagesPassed: r.stages_passed,
      stagesDisabled: r.stages_disabled,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      lastActivityAt: r.last_activity_at,
      locale: r.locale,
      lastFailStage: r.last_fail_stage,
      lastFailDetail: r.last_fail_detail,
      lastFailAt: r.last_fail_at,
    }));
  }

  listScoreboard(packId: string): ScoreboardRow[] {
    // We read the real trigram/username from `session_variables` — the
    // `sessions.trigram` column is a UUID placeholder (identification happens
    // in-game via <input/>), so joining on it would surface UUIDs, not the
    // trigram the player actually typed. Same story for username. We include
    // rows without a captured Trigram so the scoreboard can reveal sessions
    // stuck pre-stage-1 (a useful debug signal for the trigram+PIN flow).
    const rows = this.db
      .prepare(
        `SELECT
           s.id AS session_id,
           s.current_stage AS current_stage,
           s.started_at AS started_at,
           s.finished_at AS finished_at,
           (SELECT value FROM session_variables
              WHERE session_id = s.id AND name = 'Trigram') AS trigram_var,
           (SELECT value FROM session_variables
              WHERE session_id = s.id AND name = 'Username') AS username_var,
           (SELECT COUNT(*) FROM stage_history
              WHERE session_id = s.id AND status = 'passed') AS stages_passed,
           (SELECT COUNT(*) FROM stage_history
              WHERE session_id = s.id AND status = 'disabled') AS stages_disabled,
           (SELECT MAX(checked_at) FROM stage_history
              WHERE session_id = s.id) AS last_activity_at
         FROM sessions s
         WHERE s.pack_id = $packId
         ORDER BY
           CASE WHEN s.finished_at IS NOT NULL THEN 0 ELSE 1 END ASC,
           stages_passed DESC,
           s.finished_at ASC,
           last_activity_at DESC,
           s.started_at ASC`,
      )
      .all({ $packId: packId }) as Array<{
        session_id: string;
        current_stage: string | null;
        started_at: number;
        finished_at: number | null;
        trigram_var: string | null;
        username_var: string | null;
        stages_passed: number;
        stages_disabled: number;
        last_activity_at: number | null;
      }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      trigram: parseJsonString(r.trigram_var),
      username: parseJsonString(r.username_var),
      currentStage: r.current_stage,
      stagesPassed: r.stages_passed,
      stagesDisabled: r.stages_disabled,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      lastActivityAt: r.last_activity_at,
    }));
  }
}

export interface ScoreboardRow {
  sessionId: string;
  trigram: string | null;
  username: string | null;
  currentStage: string | null;
  stagesPassed: number;
  /** Stages the engine gated for this session (e.g. `impact: destructive`
   *  when `clusterProfile === 'other'`). Subtracted from totalStages for
   *  the percent calculation so a fully-played session displays 100%. */
  stagesDisabled: number;
  startedAt: number;
  finishedAt: number | null;
  lastActivityAt: number | null;
}

export interface AdminSessionRow extends ScoreboardRow {
  /** Captured PIN (plaintext in `session_variables`). Admin-only. */
  pin: string | null;
  locale: string;
  /** Latest 'failed' stage_history row. Self-cleans on pass (the upsert
   *  flips the row to 'passed'), but an admin-skip can leave a stale one —
   *  the route only surfaces it when it matches the stage being played. */
  lastFailStage: string | null;
  lastFailDetail: string | null;
  lastFailAt: number | null;
}

function parseJsonString(raw: string | null): string | null {
  // session_variables stores values as JSON-encoded strings (see
  // VariableQueries.upsert). Unwrap the outer quoting here so callers get
  // the plain trigram / username, not `"ABC"`. Fall back to raw on bad JSON.
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : String(parsed);
  } catch {
    return raw;
  }
}

export interface VariableRow {
  session_id: string;
  name: string;
  value: string;
  captured_at_stage: string;
}

export class VariableQueries {
  constructor(private readonly db: Database) {}

  upsert(sessionId: string, name: string, value: unknown, stageName: string): void {
    this.db
      .prepare(
        `INSERT INTO session_variables (session_id, name, value, captured_at_stage)
         VALUES ($sid, $name, $value, $stage)
         ON CONFLICT(session_id, name) DO UPDATE SET value = excluded.value, captured_at_stage = excluded.captured_at_stage`,
      )
      .run({
        $sid: sessionId,
        $name: name,
        $value: JSON.stringify(value),
        $stage: stageName,
      });
  }

  all(sessionId: string): Record<string, unknown> {
    const rows = this.db
      .prepare('SELECT name, value FROM session_variables WHERE session_id = $sid')
      .all({ $sid: sessionId }) as Array<{ name: string; value: string }>;
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        out[row.name] = JSON.parse(row.value);
      } catch {
        out[row.name] = row.value;
      }
    }
    return out;
  }

  delete(sessionId: string, name: string): void {
    this.db
      .prepare('DELETE FROM session_variables WHERE session_id = $sid AND name = $name')
      .run({ $sid: sessionId, $name: name });
  }

  /**
   * VLAN IDs held by active (not-finished) sessions. Lets allocation see peers
   * whose subnet isn't on the cluster yet (it's built at stage 10), closing the
   * gap between create() and that subnet appearing.
   */
  activeVlanIds(): number[] {
    const rows = this.db
      .prepare(
        `SELECT sv.value FROM session_variables sv
         JOIN sessions s ON s.id = sv.session_id
         WHERE sv.name = 'Vlanid' AND s.finished_at IS NULL`,
      )
      .all() as Array<{ value: string }>;
    return rows
      .map((r) => Number.parseInt(parseJsonString(r.value) ?? '', 10))
      .filter((n) => Number.isFinite(n));
  }
}

export class MockOverlayQueries {
  constructor(private readonly db: Database) {}

  mark(sessionId: string, kind: string, logicalName: string, op: 'deleted'): void {
    this.db
      .prepare(
        `INSERT INTO session_mock_overlay (session_id, entity_kind, logical_name, op)
         VALUES ($sid, $kind, $name, $op)
         ON CONFLICT(session_id, entity_kind, logical_name) DO UPDATE SET op = excluded.op`,
      )
      .run({ $sid: sessionId, $kind: kind, $name: logicalName, $op: op });
  }

  unmark(sessionId: string, kind: string, logicalName: string): void {
    this.db
      .prepare(
        `DELETE FROM session_mock_overlay
         WHERE session_id = $sid AND entity_kind = $kind AND logical_name = $name`,
      )
      .run({ $sid: sessionId, $kind: kind, $name: logicalName });
  }

  all(sessionId: string): Array<{ kind: string; logicalName: string; op: 'deleted' }> {
    const rows = this.db
      .prepare(
        `SELECT entity_kind, logical_name, op FROM session_mock_overlay WHERE session_id = $sid`,
      )
      .all({ $sid: sessionId }) as Array<{
      entity_kind: string;
      logical_name: string;
      op: string;
    }>;
    return rows.map((r) => ({
      kind: r.entity_kind,
      logicalName: r.logical_name,
      op: r.op as 'deleted',
    }));
  }
}

export class HistoryQueries {
  constructor(private readonly db: Database) {}

  record(
    sessionId: string,
    stageName: string,
    status: StageStatus,
    durationMs: number | null,
    detail: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO stage_history (session_id, stage_name, status, checked_at, duration_ms, detail)
         VALUES ($sid, $stage, $status, $ts, $dur, $detail)
         ON CONFLICT(session_id, stage_name) DO UPDATE SET
           status = excluded.status,
           checked_at = excluded.checked_at,
           duration_ms = excluded.duration_ms,
           detail = excluded.detail`,
      )
      .run({
        $sid: sessionId,
        $stage: stageName,
        $status: status,
        $ts: Date.now(),
        $dur: durationMs,
        $detail: detail,
      });
  }

  /**
   * Remove history entries for stages at or after `fromStageName` (in pack
   * order). Takes the ordered name list so "at-or-after" stays a pure data
   * concept even when stages are reordered — the set is built from the
   * current pack, no numeric index math leaks out.
   */
  deleteFrom(sessionId: string, fromStageName: string, orderedNames: readonly string[]): void {
    const idx = orderedNames.indexOf(fromStageName);
    if (idx < 0) return;
    const targets = orderedNames.slice(idx);
    if (targets.length === 0) return;
    const placeholders = targets.map(() => '?').join(',');
    this.db
      .prepare(
        `DELETE FROM stage_history WHERE session_id = ? AND stage_name IN (${placeholders})`,
      )
      .run(sessionId, ...targets);
  }

  listForSession(sessionId: string): Array<{
    stageName: string;
    status: StageStatus;
    checkedAt: number;
    durationMs: number | null;
    detail: string | null;
  }> {
    const rows = this.db
      .prepare(
        'SELECT stage_name, status, checked_at, duration_ms, detail FROM stage_history WHERE session_id = $sid',
      )
      .all({ $sid: sessionId }) as Array<{
      stage_name: string;
      status: StageStatus;
      checked_at: number;
      duration_ms: number | null;
      detail: string | null;
    }>;
    return rows.map((r) => ({
      stageName: r.stage_name,
      status: r.status,
      checkedAt: r.checked_at,
      durationMs: r.duration_ms,
      detail: r.detail,
    }));
  }
}

/** Append-only trail of check attempts — see schema.sql `check_attempts`. */
export class AttemptQueries {
  constructor(private readonly db: Database) {}

  record(
    sessionId: string,
    stageName: string,
    status: 'passed' | 'failed',
    durationMs: number | null,
    detail: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO check_attempts (session_id, stage_name, status, checked_at, duration_ms, detail)
         VALUES ($sid, $stage, $status, $ts, $dur, $detail)`,
      )
      .run({
        $sid: sessionId,
        $stage: stageName,
        $status: status,
        $ts: Date.now(),
        $dur: durationMs,
        $detail: detail,
      });
  }

  /** Newest-first attempts for the pack, with the session's trigram/username
   *  joined in so the admin Logs tab renders without a second lookup. */
  listRecent(packId: string, limit: number): AttemptRow[] {
    const rows = this.db
      .prepare(
        `SELECT
           a.id AS id,
           a.session_id AS session_id,
           a.stage_name AS stage_name,
           a.status AS status,
           a.checked_at AS checked_at,
           a.duration_ms AS duration_ms,
           a.detail AS detail,
           (SELECT value FROM session_variables
              WHERE session_id = a.session_id AND name = 'Trigram') AS trigram_var,
           (SELECT value FROM session_variables
              WHERE session_id = a.session_id AND name = 'Username') AS username_var
         FROM check_attempts a
         JOIN sessions s ON s.id = a.session_id
         WHERE s.pack_id = $packId
         ORDER BY a.checked_at DESC, a.id DESC
         LIMIT $limit`,
      )
      .all({ $packId: packId, $limit: limit }) as Array<{
        id: number;
        session_id: string;
        stage_name: string;
        status: string;
        checked_at: number;
        duration_ms: number | null;
        detail: string | null;
        trigram_var: string | null;
        username_var: string | null;
      }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      trigram: parseJsonString(r.trigram_var),
      username: parseJsonString(r.username_var),
      stageName: r.stage_name,
      status: r.status as 'passed' | 'failed',
      checkedAt: r.checked_at,
      durationMs: r.duration_ms,
      detail: r.detail,
    }));
  }
}

export interface AttemptRow {
  id: number;
  sessionId: string;
  trigram: string | null;
  username: string | null;
  stageName: string;
  status: 'passed' | 'failed';
  checkedAt: number;
  durationMs: number | null;
  detail: string | null;
}

export class ClusterCacheQueries {
  constructor(private readonly db: Database) {}

  get(sessionId: string, kind: string, logicalName: string): ClusterCacheEntry | undefined {
    const row = this.db
      .prepare(
        'SELECT entity_kind, logical_name, uuid, extra_json FROM cluster_cache WHERE session_id = $sid AND entity_kind = $kind AND logical_name = $name',
      )
      .get({ $sid: sessionId, $kind: kind, $name: logicalName }) as
      | { entity_kind: string; logical_name: string; uuid: string; extra_json: string | null }
      | null;
    if (!row) return undefined;
    return {
      kind: row.entity_kind,
      logicalName: row.logical_name,
      uuid: row.uuid,
      extra: row.extra_json ? JSON.parse(row.extra_json) : undefined,
    };
  }

  set(sessionId: string, entry: ClusterCacheEntry): void {
    this.db
      .prepare(
        `INSERT INTO cluster_cache (session_id, entity_kind, logical_name, uuid, extra_json)
         VALUES ($sid, $kind, $name, $uuid, $extra)
         ON CONFLICT(session_id, entity_kind, logical_name) DO UPDATE SET uuid = excluded.uuid, extra_json = excluded.extra_json`,
      )
      .run({
        $sid: sessionId,
        $kind: entry.kind,
        $name: entry.logicalName,
        $uuid: entry.uuid,
        $extra: entry.extra ? JSON.stringify(entry.extra) : null,
      });
  }

  all(sessionId: string): ClusterCacheEntry[] {
    const rows = this.db
      .prepare(
        'SELECT entity_kind, logical_name, uuid, extra_json FROM cluster_cache WHERE session_id = $sid',
      )
      .all({ $sid: sessionId }) as Array<{
      entity_kind: string;
      logical_name: string;
      uuid: string;
      extra_json: string | null;
    }>;
    return rows.map((r) => ({
      kind: r.entity_kind,
      logicalName: r.logical_name,
      uuid: r.uuid,
      extra: r.extra_json ? JSON.parse(r.extra_json) : undefined,
    }));
  }
}

/**
 * Tracks which `adminGate: true` stages have been unlocked by an operator.
 * Per-pack, not per-session — flipping a gate open lets every blocked
 * session resume on its next advance. Session-service holds the unlocked
 * set in memory and refreshes from this table on boot + after each
 * lock/unlock call.
 */
export class GateUnlockQueries {
  constructor(private readonly db: Database) {}

  unlock(packId: string, stageName: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO gate_unlocks (pack_id, stage_name, unlocked_at)
         VALUES ($pid, $sid, $now)
         ON CONFLICT(pack_id, stage_name) DO UPDATE SET unlocked_at = excluded.unlocked_at`,
      )
      .run({ $pid: packId, $sid: stageName, $now: now });
  }

  lock(packId: string, stageName: string): void {
    this.db
      .prepare(`DELETE FROM gate_unlocks WHERE pack_id = $pid AND stage_name = $sid`)
      .run({ $pid: packId, $sid: stageName });
  }

  list(packId: string): Array<{ stageName: string; unlockedAt: number }> {
    const rows = this.db
      .prepare(
        `SELECT stage_name, unlocked_at FROM gate_unlocks WHERE pack_id = $pid`,
      )
      .all({ $pid: packId }) as Array<{ stage_name: string; unlocked_at: number }>;
    return rows.map((r) => ({ stageName: r.stage_name, unlockedAt: r.unlocked_at }));
  }
}

export interface PackOverlayRow {
  stageName: string;
  /** null = use the JSON default; boolean = override. */
  active: boolean | null;
  /** null = use the JSON default; boolean = override. */
  adminGate: boolean | null;
}

/**
 * Operator overrides on the JSON-loaded pack. Sparse rows: a stage only
 * has a row if at least one field is overridden. The route handler is
 * responsible for upserting + then asking the SessionService to rebuild
 * its effective stage list (which is what the runner sees).
 */
export class PackOverlayQueries {
  constructor(private readonly db: Database) {}

  list(packId: string): PackOverlayRow[] {
    const rows = this.db
      .prepare(
        `SELECT stage_name, active, admin_gate FROM pack_overlay WHERE pack_id = $pid`,
      )
      .all({ $pid: packId }) as Array<{
        stage_name: string;
        active: number | null;
        admin_gate: number | null;
      }>;
    return rows.map((r) => ({
      stageName: r.stage_name,
      active: r.active === null ? null : r.active === 1,
      adminGate: r.admin_gate === null ? null : r.admin_gate === 1,
    }));
  }

  /**
   * Set ONE field of the overlay for a stage. The other field is preserved
   * if a row already exists, NULL otherwise (no override). Pass `null` for
   * `value` to clear the override and fall back to the JSON default.
   */
  setField(
    packId: string,
    stageName: string,
    field: 'active' | 'adminGate',
    value: boolean | null,
  ): void {
    const col = field === 'active' ? 'active' : 'admin_gate';
    const v = value === null ? null : value ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO pack_overlay (pack_id, stage_name, ${col})
         VALUES ($pid, $sid, $v)
         ON CONFLICT(pack_id, stage_name) DO UPDATE SET ${col} = excluded.${col}`,
      )
      .run({ $pid: packId, $sid: stageName, $v: v });
    // Garbage-collect rows that ended up with NO overrides — keeps the
    // table sparse and `list()` cheap.
    this.db
      .prepare(
        `DELETE FROM pack_overlay
           WHERE pack_id = $pid AND stage_name = $sid
             AND active IS NULL AND admin_gate IS NULL`,
      )
      .run({ $pid: packId, $sid: stageName });
  }

  /**
   * Swap the whole overlay for a pack in one transaction. Used by the
   * config import: replacing rather than merging is what makes an imported
   * config reproduce the source setup instead of layering onto whatever
   * the local operator had already flipped.
   */
  replaceAll(packId: string, rows: readonly PackOverlayRow[]): void {
    const del = this.db.prepare(`DELETE FROM pack_overlay WHERE pack_id = $pid`);
    const ins = this.db.prepare(
      `INSERT INTO pack_overlay (pack_id, stage_name, active, admin_gate)
       VALUES ($pid, $sid, $a, $g)`,
    );
    this.db.transaction(() => {
      del.run({ $pid: packId });
      for (const r of rows) {
        if (r.active === null && r.adminGate === null) continue; // nothing to store
        ins.run({
          $pid: packId,
          $sid: r.stageName,
          $a: r.active === null ? null : r.active ? 1 : 0,
          $g: r.adminGate === null ? null : r.adminGate ? 1 : 0,
        });
      }
    })();
  }

  /** Drop every override for a pack — back to the JSON defaults. */
  clear(packId: string): number {
    const res = this.db
      .prepare(`DELETE FROM pack_overlay WHERE pack_id = $pid`)
      .run({ $pid: packId });
    return res.changes;
  }
}

/**
 * Pack-wide pause flag (lunch break, theory recap, Q&A, etc.). One row per
 * pack at most: present = paused, absent = running. Persisted so the pause
 * survives a server restart — instructor doesn't have to reapply it after
 * a process bounce mid-event.
 */
export class PackPauseQueries {
  constructor(private readonly db: Database) {}

  set(packId: string, reason = 'lunch', now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO pack_pauses (pack_id, paused_at, reason)
         VALUES ($pid, $at, $reason)
         ON CONFLICT(pack_id) DO UPDATE SET paused_at = excluded.paused_at, reason = excluded.reason`,
      )
      .run({ $pid: packId, $at: now, $reason: reason });
  }

  clear(packId: string): void {
    this.db.prepare(`DELETE FROM pack_pauses WHERE pack_id = $pid`).run({ $pid: packId });
  }

  get(packId: string): { pausedAt: number; reason: string | null } | null {
    const row = this.db
      .prepare(`SELECT paused_at, reason FROM pack_pauses WHERE pack_id = $pid`)
      .get({ $pid: packId }) as { paused_at: number; reason: string | null } | null;
    return row ? { pausedAt: row.paused_at, reason: row.reason } : null;
  }
}

export interface ClusterConfigRow {
  key: string;
  value: unknown;     // JSON-decoded
  updatedAt: number;
  source: 'probe' | 'admin';
}

/**
 * Cluster-wide read-only config (rackable unit serials, LCM update count,
 * etc.). Populated at boot from the live cluster (only if absent — never
 * overwrites operator-set rows) and editable through `/admin`. Checks
 * read it via `CheckContext.clusterConfig` to avoid slow live queries.
 */
export class ClusterConfigQueries {
  constructor(private readonly db: Database) {}

  /** Fetch one row with its `source`. Checks use it to tell an operator's
   *  deliberate value (`admin`) from whatever the probe last read (`probe`). */
  getRow<T = unknown>(key: string): { value: T; source: 'probe' | 'admin' } | undefined {
    const row = this.db
      .prepare(`SELECT value, source FROM cluster_config WHERE key = $k`)
      .get({ $k: key }) as { value: string; source: string } | null;
    if (!row) return undefined;
    try {
      return {
        value: JSON.parse(row.value) as T,
        source: row.source === 'admin' ? 'admin' : 'probe',
      };
    } catch {
      return undefined;
    }
  }

  /** Fetch a single value. Returns the parsed JSON `value` or undefined. */
  get<T = unknown>(key: string): T | undefined {
    const row = this.db
      .prepare(`SELECT value FROM cluster_config WHERE key = $k`)
      .get({ $k: key }) as { value: string } | null;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  /** Fetch every row with metadata — used by /admin to render the editor. */
  list(): ClusterConfigRow[] {
    const rows = this.db
      .prepare(`SELECT key, value, updated_at, source FROM cluster_config ORDER BY key`)
      .all() as Array<{ key: string; value: string; updated_at: number; source: string }>;
    return rows.map((r) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.value);
      } catch {
        parsed = undefined;
      }
      return {
        key: r.key,
        value: parsed,
        updatedAt: r.updated_at,
        source: r.source === 'admin' ? 'admin' : 'probe',
      };
    });
  }

  /** Upsert. `source` discriminates probe-populated vs operator-edited rows. */
  set(key: string, value: unknown, source: 'probe' | 'admin', now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO cluster_config (key, value, updated_at, source)
         VALUES ($k, $v, $at, $src)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at,
           source = excluded.source`,
      )
      .run({ $k: key, $v: JSON.stringify(value), $at: now, $src: source });
  }

  /**
   * Boot-probe insert: set the row only if it doesn't exist yet. This is
   * how the live cluster snapshot populates the cache without ever
   * overwriting an operator's manual edit (those are tagged source='admin'
   * and are sticky).
   */
  setIfAbsent(key: string, value: unknown, now = Date.now()): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO cluster_config (key, value, updated_at, source)
         VALUES ($k, $v, $at, 'probe')`,
      )
      .run({ $k: key, $v: JSON.stringify(value), $at: now });
    return r.changes > 0;
  }

  /** Clear a key (defensive — used by tests / refresh flows). */
  delete(key: string): void {
    this.db.prepare(`DELETE FROM cluster_config WHERE key = $k`).run({ $k: key });
  }
}

export interface ScoreboardPeerRow {
  id: number;
  label: string;
  baseUrl: string;
  enabled: boolean;
  addedAt: number;
}

/**
 * Peer instances whose `/api/scoreboard` should be merged into the local
 * combined view. Curated via /admin. `baseUrl` is the peer game's base
 * (e.g. `http://10.55.89.44:3000`); the combined endpoint appends
 * `/api/scoreboard` internally.
 */
export class ScoreboardPeerQueries {
  constructor(private readonly db: Database) {}

  list(): ScoreboardPeerRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, label, base_url, enabled, added_at
           FROM scoreboard_peers
           ORDER BY added_at ASC`,
      )
      .all() as Array<{
        id: number;
        label: string;
        base_url: string;
        enabled: number;
        added_at: number;
      }>;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      baseUrl: r.base_url,
      enabled: r.enabled === 1,
      addedAt: r.added_at,
    }));
  }

  add(label: string, baseUrl: string, now = Date.now()): ScoreboardPeerRow {
    const r = this.db
      .prepare(
        `INSERT INTO scoreboard_peers (label, base_url, enabled, added_at)
         VALUES ($l, $u, 1, $at)
         RETURNING id, label, base_url, enabled, added_at`,
      )
      .get({ $l: label, $u: baseUrl, $at: now }) as {
        id: number;
        label: string;
        base_url: string;
        enabled: number;
        added_at: number;
      };
    return {
      id: r.id,
      label: r.label,
      baseUrl: r.base_url,
      enabled: r.enabled === 1,
      addedAt: r.added_at,
    };
  }

  remove(id: number): boolean {
    const r = this.db
      .prepare(`DELETE FROM scoreboard_peers WHERE id = $id`)
      .run({ $id: id });
    return r.changes > 0;
  }

  setEnabled(id: number, enabled: boolean): boolean {
    const r = this.db
      .prepare(`UPDATE scoreboard_peers SET enabled = $e WHERE id = $id`)
      .run({ $id: id, $e: enabled ? 1 : 0 });
    return r.changes > 0;
  }
}

export interface EmailRosterRow {
  id: number;
  seat: number;
  email: string;
  addedAt: number;
  /** templateId → sentAt (ms) of the last successful delivery. */
  sent: Record<string, number>;
}

/**
 * Participant roster for the /admin Emails tab. Seat = the participant's
 * VDI account number ({ID} in templates), assigned lowest-free-first so a
 * deleted participant frees their account for the next addition. Sends
 * are one-shot per (participant, template type) — "pending" targeting
 * means adding someone late never re-emails the room.
 */
export class EmailRosterQueries {
  constructor(private readonly db: Database) {}

  list(): EmailRosterRow[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.seat, r.email, r.added_at, s.template_id, s.sent_at
           FROM email_roster r
           LEFT JOIN email_sends s ON s.roster_id = r.id
          ORDER BY r.seat ASC`,
      )
      .all() as Array<{
        id: number;
        seat: number;
        email: string;
        added_at: number;
        template_id: string | null;
        sent_at: number | null;
      }>;
    // One row per (entry, send); rows for the same seat are adjacent
    // thanks to the ORDER BY, and Map preserves that order.
    const byId = new Map<number, EmailRosterRow>();
    for (const row of rows) {
      let entry = byId.get(row.id);
      if (!entry) {
        entry = { id: row.id, seat: row.seat, email: row.email, addedAt: row.added_at, sent: {} };
        byId.set(row.id, entry);
      }
      if (row.template_id !== null && row.sent_at !== null) {
        entry.sent[row.template_id] = row.sent_at;
      }
    }
    return [...byId.values()];
  }

  /** Add one address on the lowest free seat. Returns null on duplicate. */
  add(email: string, now = Date.now()): EmailRosterRow | null {
    const taken = (
      this.db.prepare(`SELECT seat FROM email_roster ORDER BY seat ASC`).all() as Array<{
        seat: number;
      }>
    ).map((r) => r.seat);
    let seat = 1;
    for (const t of taken) {
      if (t === seat) seat++;
      else if (t > seat) break;
    }
    try {
      const r = this.db
        .prepare(
          `INSERT INTO email_roster (seat, email, added_at) VALUES ($s, $e, $at)
           RETURNING id, seat, email, added_at`,
        )
        .get({ $s: seat, $e: email, $at: now }) as {
          id: number; seat: number; email: string; added_at: number;
        };
      return { id: r.id, seat: r.seat, email: r.email, addedAt: r.added_at, sent: {} };
    } catch (err) {
      // Only the email-uniqueness violation means "already on the roster";
      // anything else (SQLITE_BUSY, disk errors) must surface, not be
      // reported to the operator as a benign skip.
      if (err instanceof Error && err.message.includes('UNIQUE') && err.message.includes('email')) {
        return null;
      }
      throw err;
    }
  }

  remove(id: number): boolean {
    // No FK pragma in this DB — clean the send log by hand. One transaction so a
    // mid-delete crash can't leave email_sends rows orphaned from their roster.
    const tx = this.db.transaction((rowId: number) => {
      this.db.prepare(`DELETE FROM email_sends WHERE roster_id = $id`).run({ $id: rowId });
      const r = this.db.prepare(`DELETE FROM email_roster WHERE id = $id`).run({ $id: rowId });
      return r.changes > 0;
    });
    return tx(id);
  }

  /** Roster entries with no successful delivery of this template yet. */
  pendingFor(templateId: string): EmailRosterRow[] {
    return this.list().filter((r) => r.sent[templateId] === undefined);
  }

  byIds(ids: number[]): EmailRosterRow[] {
    const set = new Set(ids);
    return this.list().filter((r) => set.has(r.id));
  }

  markSent(rosterId: number, templateId: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO email_sends (roster_id, template_id, sent_at)
         VALUES ($id, $t, $at)
         ON CONFLICT(roster_id, template_id) DO UPDATE SET sent_at = excluded.sent_at`,
      )
      .run({ $id: rosterId, $t: templateId, $at: now });
  }
}
