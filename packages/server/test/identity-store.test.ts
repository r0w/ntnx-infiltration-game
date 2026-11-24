import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityStore } from '../src/identity-store';

function setup(path = ':memory:', mock = false, pack = 'game') {
  const db = new Database(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, finished_at INTEGER, progress TEXT);`);
  const store = new IdentityStore(db, pack, { allowFinishedReuse: mock });
  const create = (id: string) => db.query('INSERT INTO sessions(id, pack_id) VALUES (?, ?)').run(id, pack);
  const finish = (id: string, pin = '1234') => store.finish(id, store.revision(id), pin, outcome => {
    if (outcome.kind === 'registered') db.query("UPDATE sessions SET progress='login-passed' WHERE id=?").run(id);
    if (outcome.kind === 'resumed') db.query('DELETE FROM sessions WHERE id=?').run(id);
    return outcome;
  });
  return { db, store, create, finish };
}

describe('confirmed session identities', () => {
  test('drafts do not claim codes; competing registrations have one winner even with identical PINs', () => {
    const { db, store, create, finish } = setup();
    for (const id of ['abandoned', 'first', 'second']) { create(id); store.select(id, 'ABC'); }
    expect(finish('first').outcome.kind).toBe('registered');
    expect(finish('second').outcome.kind).toBe('code-taken');
    expect(store.owner('abc')?.sessionId).toBe('first');
    expect(store.isConfirmed('second')).toBe(false);
    db.close();
  });

  test('simultaneous resumes both find the confirmed owner; receipts survive source deletion and restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-receipt-'));
    try {
      const path = join(dir, 'db');
      let env = setup(path);
      env.create('owner'); env.store.select('owner', 'abc'); env.finish('owner');
      for (const id of ['a', 'b']) { env.create(id); env.store.select(id, 'abc'); }
      for (const id of ['a', 'b']) {
        expect(env.finish(id).outcome).toEqual({ kind: 'resumed', targetId: 'owner' });
        expect(env.db.query('SELECT * FROM sessions WHERE id=?').get(id)).toBeNull();
      }
      env.db.close();
      env = setup(path);
      expect(env.store.finish('a', 1, '0000', () => { throw new Error('must replay'); }).replayed).toBe(true);
      expect(env.store.receipt('b')?.outcome).toEqual({ kind: 'resumed', targetId: 'owner' });
      env.db.query('DELETE FROM sessions WHERE id=?').run('owner');
      expect(env.store.receipt('a')).toBeNull();
      env.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('wrong PIN can retry but never resumes a matching unconfirmed draft', () => {
    const { db, store, create, finish } = setup();
    create('owner'); store.select('owner', 'abc'); finish('owner');
    create('draft'); store.select('draft', 'abc');
    expect(finish('draft', '2222').outcome.kind).toBe('wrong-pin');
    create('resume'); store.select('resume', 'abc');
    expect(finish('resume', '2222').outcome.kind).toBe('wrong-pin');
    expect(finish('resume').outcome).toEqual({ kind: 'resumed', targetId: 'owner' });
    expect(finish('draft').outcome).toEqual({ kind: 'resumed', targetId: 'owner' });
    db.close();
  });

  test('intent and owner id are bound at code submission, including after code reuse', () => {
    const { db, store, create, finish } = setup();
    create('owner'); store.select('owner', 'abc'); finish('owner');
    create('resume'); store.select('resume', 'abc');
    db.query('DELETE FROM sessions WHERE id=?').run('owner');
    create('replacement'); store.select('replacement', 'abc'); finish('replacement');
    expect(finish('resume').outcome.kind).toBe('target-gone');
    db.close();
  });

  test('stale input cannot acquire a different code, reset cannot replay a prior collision', () => {
    const { db, store, create, finish } = setup();
    create('a'); store.select('a', 'abc', 0);
    expect(() => store.select('a', 'def', 0)).toThrow('stale-input');
    store.reset('a');
    expect(store.revision('a')).toBe(2);
    store.select('a', 'def', 2);
    expect(() => store.finish('a', 1, '1234', () => null)).toThrow('stale-input');
    expect(store.owner('def')).toBeNull();
    finish('a');
    expect(() => store.reset('a')).toThrow('confirmed-session');
    expect(() => store.select('a', 'xyz')).toThrow('confirmed-session');
    db.close();
  });

  test('ownership, progress and receipt roll back together when commit fails', () => {
    const { db, store, create, finish } = setup();
    create('a'); store.select('a', 'abc');
    expect(() => store.finish('a', 1, '1234', () => {
      db.query("UPDATE sessions SET progress='bad' WHERE id='a'").run();
      throw new Error('crash');
    })).toThrow('crash');
    expect(store.owner('abc')).toBeNull();
    expect(store.receipt('a')).toBeNull();
    expect(db.query("SELECT progress FROM sessions WHERE id='a'").get()).toEqual({ progress: null });
    expect(finish('a').outcome.kind).toBe('registered');
    db.close();
  });

  test('handoff deletion rolls back if response construction fails', () => {
    const { db, store, create, finish } = setup();
    create('owner'); store.select('owner', 'abc'); finish('owner');
    create('draft'); store.select('draft', 'abc');
    expect(() => store.finish('draft', 1, '1234', () => {
      db.query("DELETE FROM sessions WHERE id='draft'").run();
      throw new Error('crash');
    })).toThrow('crash');
    expect(store.attempt('draft')?.targetId).toBe('owner');
    expect(store.receipt('draft')).toBeNull();
    expect(finish('draft').outcome).toEqual({ kind: 'resumed', targetId: 'owner' });
    db.close();
  });

  test('choosing another code after a collision invalidates the old receipt', () => {
    const { db, store, create, finish } = setup();
    for (const id of ['winner', 'loser']) { create(id); store.select(id, 'abc'); }
    finish('winner'); finish('loser');
    expect(store.receipt('loser')?.outcome.kind).toBe('code-taken');
    store.reset('loser');
    expect(store.receipt('loser', 1)).toBeNull();
    store.select('loser', 'def');
    expect(() => store.finish('loser', 1, '1234', () => null)).toThrow('stale-input');
    expect(finish('loser').outcome.kind).toBe('registered');
    db.close();
  });

  test('legacy imports validate identity and cannot replace an existing claim', () => {
    const { db, store, create } = setup();
    create('a'); create('b');
    expect(store.importConfirmed('a', 'ABC', '1234')).toBe(true);
    expect(store.importConfirmed('b', 'abc', '9999')).toBe(false);
    expect(store.importConfirmed('b', 'invalid', '1234')).toBe(false);
    expect(store.owner('abc')?.pin).toBe('1234');
    expect(store.isConfirmed('b')).toBe(false);
    db.close();
  });

  test('duplicate registration is idempotent and cannot overwrite the accepted PIN', () => {
    const { db, store, create, finish } = setup();
    create('a'); store.select('a', 'abc'); finish('a');
    expect(finish('a', '9999').replayed).toBe(true);
    expect(store.owner('abc')?.pin).toBe('1234');
    db.close();
  });

  test('finished live identities remain owned; mock reuse preserves old confirmed session', () => {
    for (const mock of [false, true]) {
      const { db, store, create, finish } = setup(':memory:', mock);
      create('old'); store.select('old', 'abc'); finish('old');
      db.query("UPDATE sessions SET finished_at=1 WHERE id='old'").run();
      create('new');
      expect(store.select('new', 'abc').intent).toBe(mock ? 'register' : 'resume');
      expect(finish('new').outcome.kind).toBe(mock ? 'registered' : 'resumed');
      expect(store.isConfirmed('old')).toBe(true);
      expect(db.query("SELECT progress FROM sessions WHERE id='old'").get()).toEqual({ progress: 'login-passed' });
      db.close();
    }
  });

  test('identity decisions and receipts stay scoped to the pack', () => {
    const { db, store, create, finish } = setup();
    create('a'); store.select('a', 'abc'); finish('a');
    const other = new IdentityStore(db, 'other');
    expect(other.owner('abc')).toBeNull();
    expect(other.receipt('a')).toBeNull();
    expect(other.isConfirmed('a')).toBe(false);
    expect(() => other.select('a', 'abc')).toThrow('missing-session');
    db.close();
  });

  test('five separate processes contend for the same identity without double registration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-contention-'));
    try {
      const path = join(dir, 'db');
      const { db, store, create } = setup(path);
      for (let i = 0; i < 5; i++) { create(String(i)); store.select(String(i), 'abc'); }
      const modulePath = new URL('../src/identity-store.ts', import.meta.url).pathname;
      const readyAt = Date.now() + 500;
      const children = Array.from({ length: 5 }, (_, i) => Bun.spawn([process.execPath, '-e', `
        import {Database} from 'bun:sqlite';
        import {IdentityStore} from ${JSON.stringify(modulePath)};
        const db = new Database(${JSON.stringify(path)});
        db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
        const store = new IdentityStore(db, 'game');
        await Bun.sleep(Math.max(0, ${readyAt} - Date.now()));
        const result = store.finish('${i}', 1, '1234', outcome => {
          if(outcome.kind==='registered')db.query("UPDATE sessions SET progress='login-passed' WHERE id=?").run('${i}');
          return outcome;
        });
        console.log(JSON.stringify(result.outcome)); db.close();
      `], { stdout: 'pipe', stderr: 'pipe' }));
      const results = await Promise.all(children.map(async child => {
        const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(error).toBe(''); expect(exit).toBe(0);
        return JSON.parse(output) as { kind: string };
      }));
      expect(results.filter(r => r.kind === 'registered')).toHaveLength(1);
      expect(results.filter(r => r.kind === 'code-taken')).toHaveLength(4);
      expect(db.query("SELECT count(*) AS n FROM sessions WHERE progress='login-passed'").get()).toEqual({ n: 1 });
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
