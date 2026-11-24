import type { Database } from 'bun:sqlite';

export interface IdentityAttempt {
  revision: number;
  code: string;
  intent: 'register' | 'resume';
  targetId: string | null;
}
export interface IdentityOwner {
  sessionId: string;
  code: string;
  pin: string;
  finishedAt: number | null;
}
export type IdentityOutcome =
  | { kind: 'registered' | 'resumed'; targetId: string }
  | { kind: 'code-taken' | 'target-gone' | 'wrong-pin' | 'invalid-pin' };
export interface IdentityReceipt<T> {
  outcome: IdentityOutcome;
  response: T;
  replayed: boolean;
}
export class IdentityError extends Error {
  constructor(public readonly kind: 'invalid-code' | 'confirmed-session' | 'missing-session' | 'stale-input' | 'choose-code') {
    super(kind);
  }
}

/** Identity decisions and the resulting game transition share one SQLite commit. */
export class IdentityStore {
  constructor(
    private readonly db: Database,
    private readonly packId: string,
    private readonly options: { allowFinishedReuse?: boolean } = {},
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS identity_owners (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        pack_id TEXT NOT NULL,
        code TEXT NOT NULL,
        pin TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS identity_active_code
        ON identity_owners(pack_id, code) WHERE active = 1;
      CREATE TABLE IF NOT EXISTS identity_attempts (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        code TEXT,
        intent TEXT,
        target_id TEXT
      );
      CREATE TABLE IF NOT EXISTS identity_receipts (
        source_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        pack_id TEXT NOT NULL,
        target_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        outcome_json TEXT NOT NULL,
        response_json TEXT NOT NULL,
        PRIMARY KEY(source_id, revision)
      );
    `);
  }

  owner(code: string): IdentityOwner | null {
    const result = this.db.query(`SELECT o.session_id AS sessionId, o.code, o.pin,
        s.finished_at AS finishedAt FROM identity_owners o JOIN sessions s ON s.id = o.session_id
        WHERE o.pack_id = ? AND o.code = ? AND o.active = 1`).get(this.packId, code.toLowerCase()) as IdentityOwner | null;
    return result && this.options.allowFinishedReuse && result.finishedAt !== null ? null : result;
  }

  isConfirmed(sessionId: string): boolean {
    return !!this.db.query('SELECT 1 FROM identity_owners WHERE pack_id = ? AND session_id = ?').get(this.packId, sessionId);
  }

  attempt(sessionId: string): IdentityAttempt | null {
    return this.db.query(`SELECT a.revision, a.code, a.intent, a.target_id AS targetId
      FROM identity_attempts a JOIN sessions s ON s.id = a.session_id
      WHERE a.session_id = ? AND s.pack_id = ? AND a.intent IS NOT NULL`).get(sessionId, this.packId) as IdentityAttempt | null;
  }

  private requireSession(sessionId: string) {
    if (!this.db.query('SELECT 1 FROM sessions WHERE id = ? AND pack_id = ?').get(sessionId, this.packId)) {
      throw new IdentityError('missing-session');
    }
  }

  revision(sessionId: string): number {
    return (this.db.query(`SELECT a.revision FROM identity_attempts a JOIN sessions s ON s.id = a.session_id
      WHERE a.session_id = ? AND s.pack_id = ?`).get(sessionId, this.packId) as { revision: number } | null)?.revision ?? 0;
  }

  select(sessionId: string, rawCode: string, expectedRevision?: number): IdentityAttempt {
    const code = rawCode.trim().toLowerCase();
    if (!/^[a-z0-9]{3}$/.test(code)) throw new IdentityError('invalid-code');
    return this.db.transaction(() => {
      this.requireSession(sessionId);
      if (this.isConfirmed(sessionId)) throw new IdentityError('confirmed-session');
      if (expectedRevision !== undefined && this.revision(sessionId) !== expectedRevision) throw new IdentityError('stale-input');
      const owner = this.owner(code);
      this.db.query(`INSERT INTO identity_attempts(session_id, revision, code, intent, target_id)
        VALUES (?, 1, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
        revision = revision + 1, code = excluded.code, intent = excluded.intent, target_id = excluded.target_id`)
        .run(sessionId, code, owner ? 'resume' : 'register', owner?.sessionId ?? null);
      return this.attempt(sessionId)!;
    }).immediate();
  }

  reset(sessionId: string): void {
    this.db.transaction(() => {
      this.requireSession(sessionId);
      if (this.isConfirmed(sessionId)) throw new IdentityError('confirmed-session');
      this.db.query(`INSERT INTO identity_attempts(session_id, revision) VALUES (?, 1)
        ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1, code = NULL, intent = NULL, target_id = NULL`)
        .run(sessionId);
    }).immediate();
  }

  receipt<T>(sessionId: string, revision?: number): IdentityReceipt<T> | null {
    const row = this.db.query(`SELECT r.outcome_json, r.response_json FROM identity_receipts r
      LEFT JOIN identity_attempts a ON a.session_id = r.source_id
      WHERE r.source_id = ? AND r.pack_id = ? AND (? IS NULL OR r.revision = ?)
        AND (a.revision IS NULL OR a.revision = r.revision)
      ORDER BY r.revision DESC LIMIT 1`).get(sessionId, this.packId, revision ?? null, revision ?? null) as {
        outcome_json: string; response_json: string;
      } | null;
    return row ? { outcome: JSON.parse(row.outcome_json), response: JSON.parse(row.response_json), replayed: true } : null;
  }

  finish<T>(sessionId: string, revision: number, pin: string, commit: (outcome: IdentityOutcome) => T): IdentityReceipt<T> {
    return this.db.transaction(() => {
      const prior = this.receipt<T>(sessionId, revision);
      if (prior) return prior;
      this.requireSession(sessionId);
      const attempt = this.attempt(sessionId);
      if (!attempt) throw new IdentityError('choose-code');
      if (attempt.revision !== revision) throw new IdentityError('stale-input');
      let outcome: IdentityOutcome;
      const owner = this.owner(attempt.code);
      if (!/^\d{4}$/.test(pin)) outcome = { kind: 'invalid-pin' };
      else if (attempt.intent === 'register') {
        if (owner) outcome = { kind: 'code-taken' };
        else {
          // Mock runs may reuse a finished code, but the old run stays confirmed.
          this.db.query('UPDATE identity_owners SET active = 0 WHERE pack_id = ? AND code = ? AND active = 1')
            .run(this.packId, attempt.code);
          this.db.query('INSERT INTO identity_owners(session_id, pack_id, code, pin) VALUES (?, ?, ?, ?)')
            .run(sessionId, this.packId, attempt.code, pin);
          outcome = { kind: 'registered', targetId: sessionId };
        }
      } else if (!owner || owner.sessionId !== attempt.targetId) outcome = { kind: 'target-gone' };
      else if (owner.pin !== pin) outcome = { kind: 'wrong-pin' };
      else outcome = { kind: 'resumed', targetId: owner.sessionId };
      const response = commit(outcome);
      if (response instanceof Promise) throw new Error('Identity commit must be synchronous');
      if (outcome.kind !== 'wrong-pin' && outcome.kind !== 'invalid-pin') {
        this.db.query(`INSERT INTO identity_receipts(source_id, revision, pack_id, target_id, outcome_json, response_json)
          VALUES (?, ?, ?, ?, ?, ?)`).run(sessionId, revision, this.packId,
            'targetId' in outcome ? outcome.targetId : sessionId, JSON.stringify(outcome), JSON.stringify(response));
      }
      return { outcome, response, replayed: false };
    }).immediate();
  }

  /** Import only identities whose login was already confirmed before this store existed. */
  importConfirmed(sessionId: string, rawCode: string, pin: string): boolean {
    const code = rawCode.trim().toLowerCase();
    if (!/^[a-z0-9]{3}$/.test(code) || !/^\d{4}$/.test(pin)) return false;
    this.requireSession(sessionId);
    return this.db.query('INSERT OR IGNORE INTO identity_owners(session_id, pack_id, code, pin) VALUES (?, ?, ?, ?)')
      .run(sessionId, this.packId, code, pin).changes > 0;
  }
}
