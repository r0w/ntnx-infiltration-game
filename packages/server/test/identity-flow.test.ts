import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack } from '../src/pack-loader';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import { Telemetry } from '../src/telemetry';
import type { NutanixClient } from '@ntnx-game/engine';

const pack = await loadPack(new URL('../../../packs', import.meta.url).pathname, 'ntnx-infiltration');
type Mode = 'live' | 'test' | 'mock';
function boot(db = openDatabase({ path: ':memory:' }), mode: Mode = 'live') {
  const client = {
    mode: mode === 'mock' ? 'mock' : 'live',
    request: async () => { throw new Error('Unexpected network request in identity test'); },
    rest: { request: async (_method: string, path: string) => {
      if (path.startsWith('/api/networking/v4.0/config/subnets')) return { data: [] };
      throw new Error(`Unexpected network request: ${path}`);
    } },
  } as unknown as NutanixClient;
  const telemetry = new Telemetry({ db, logger: { debug() {}, info() {}, warn() {}, error() {} },
    url: 'https://unused.invalid', deploymentIp: '127.0.0.1',
    packId: pack.manifest.id, packVersion: 'test', serverMode: mode, clusterProfile: 'other' });
  const { app, service } = buildApp({ db, pack, nutanix: client, telemetry,
    clusterEndpoint: 'https://unused.invalid', clusterProfile: 'other', capabilities: [],
    adminPassword: 'identity-test', serverMode: mode });
  async function post(path: string, body = {}) {
    const response = await app.request(path, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json() as Promise<any>;
  }
  async function revision(id: string) {
    const response = await app.request(`/api/session/${id}`);
    if (!response.ok) throw new Error(`Snapshot ${response.status}: ${await response.text()}`);
    return (await response.json()).identityRevision as number | undefined;
  }
  async function advance(id: string) {
    return post(`/api/session/${id}/advance`, { identityRevision: await revision(id) });
  }
  async function start() {
    const { sessionId: id } = await post('/api/session', { locale: 'fr' });
    for (let i = 0; i < 5; i++) {
      const result = await advance(id);
      if (result.awaitingVariable === 'Trigram') return id as string;
    }
    throw new Error('No trigram prompt');
  }
  async function input(id: string, variable: string, value: string) {
    return post(`/api/session/${id}/input`, { variable, value, identityRevision: await revision(id) });
  }
  async function check(id: string) {
    return post(`/api/session/${id}/resolve-check`, { identityRevision: await revision(id) });
  }
  async function login(code: string, pin: string) {
    const id = await start();
    await input(id, 'Trigram', code);
    await input(id, 'PIN', pin);
    return { id, result: await check(id) };
  }
  const exists = (id: string) => Boolean(db.query('SELECT id FROM sessions WHERE id=?').get(id));
  const passed = () => (db.query("SELECT COUNT(*) AS n FROM stage_history WHERE stage_name='login' AND status='passed'").get() as { n: number }).n;
  return { db, app, service, post, revision, advance, start, input, check, login, exists, passed };
}

function snapshot(db: Database, id: string) {
  const tables = ['session_variables', 'stage_history', 'check_attempts', 'help_usage', 'session_waits', 'cluster_cache', 'session_mock_overlay'];
  return {
    session: db.query('SELECT * FROM sessions WHERE id=?').get(id),
    ...Object.fromEntries(tables.map((table) => [table, db.query(`SELECT * FROM ${table} WHERE session_id=? ORDER BY rowid`).all(id)])),
  };
}

function seedProgress(b: ReturnType<typeof boot>, id: string) {
  b.db.query("UPDATE sessions SET current_stage='create-project' WHERE id=?").run(id);
  b.service.variables.upsert(id, 'Username', 'Identity Test Agent', 'get-username');
  b.service.variables.upsert(id, 'ProjectUUID', 'existing-project', 'create-project');
  b.db.query("INSERT INTO help_usage VALUES (?, 'create-project', 60, 1000)").run(id);
  b.db.query("INSERT INTO session_waits (session_id, reason, stage_name, blocked_at, released_at) VALUES (?, 'gate', 'create-project', 1000, 2000)").run(id);
  b.db.query("INSERT INTO cluster_cache VALUES (?, 'project', 'existing', 'project-uuid', '{}')").run(id);
}

test.each(['live', 'test', 'mock'] as const)('%s: normal registration and case-insensitive resume preserve the complete owner', async (mode) => {
  const b = boot(undefined, mode);
  try {
    const owner = await b.login('AbC', '1111');
    expect(owner.result.kind).not.toBe('switch-session');
    expect(b.passed()).toBe(1);
    seedProgress(b, owner.id);
    const before = snapshot(b.db, owner.id);
    const returning = await b.login('ABC', '1111');
    expect(returning.result.switchSessionId).toBe(owner.id);
    expect(b.exists(returning.id)).toBe(false);
    expect(snapshot(b.db, owner.id)).toEqual(before);
  } finally { b.db.close(); }
});

test('wrong PIN followed by the correct PIN resumes without modifying owner state', async () => {
  const b = boot();
  try {
    const owner = await b.login('abc', '1111');
    seedProgress(b, owner.id);
    const before = snapshot(b.db, owner.id);
    const returning = await b.login('abc', '9999');
    expect(returning.result.awaitingVariable).toBe('PIN');
    expect(snapshot(b.db, owner.id)).toEqual(before);
    await b.input(returning.id, 'PIN', '1111');
    expect((await b.check(returning.id)).switchSessionId).toBe(owner.id);
    expect(snapshot(b.db, owner.id)).toEqual(before);
  } finally { b.db.close(); }
});

test.each(['live', 'test'] as const)('%s: a finished owner keeps the code and remains resumable', async (mode) => {
  const b = boot(undefined, mode);
  try {
    const owner = await b.login('abc', '1111');
    b.db.query('UPDATE sessions SET finished_at=? WHERE id=?').run(Date.now(), owner.id);
    const before = snapshot(b.db, owner.id);
    const wrong = await b.login('abc', '9999');
    expect(wrong.result.awaitingVariable).toBe('PIN');
    const right = await b.login('abc', '1111');
    expect(right.result.switchSessionId).toBe(owner.id);
    expect(snapshot(b.db, owner.id)).toEqual(before);
  } finally { b.db.close(); }
});

test('mock: a finished session allows a fresh registration with the same code', async () => {
  const b = boot(undefined, 'mock');
  try {
    const owner = await b.login('abc', '1111');
    b.db.query('UPDATE sessions SET finished_at=? WHERE id=?').run(Date.now(), owner.id);
    const before = snapshot(b.db, owner.id);
    const next = await b.login('abc', '2222');
    expect(next.result.kind).not.toBe('switch-session');
    expect(b.passed()).toBe(2);
    expect(snapshot(b.db, owner.id)).toEqual(before);
  } finally { b.db.close(); }
});

test('an abandoned trigram without a PIN does not reserve the code', async () => {
  const b = boot();
  try {
    const draft = await b.start();
    await b.input(draft, 'Trigram', 'abc');
    const owner = await b.login('abc', '2222');
    expect(owner.result.kind).not.toBe('switch-session');
    expect(b.passed()).toBe(1);
    await b.input(draft, 'PIN', '2222');
    const loser = await b.check(draft);
    expect(loser.awaitingVariable).toBe('Trigram');
    expect(loser.check.hint).toBe('Un autre joueur vient de prendre ce code. Choisis-en un autre.');
    expect(loser.kind).not.toBe('switch-session');
    expect(b.exists(owner.id)).toBe(true);
  } finally { b.db.close(); }
});

test.each(['1111', '2222'])('overlapping signups have one winner when the second PIN is %s', async (secondPin) => {
  const b = boot();
  try {
    const ids = await Promise.all([b.start(), b.start()]);
    await Promise.all(ids.map((id, i) => b.input(id, 'Trigram', i ? 'ABC' : 'abc')));
    await Promise.all(ids.map((id, i) => b.input(id, 'PIN', i ? secondPin : '1111')));
    const results = await Promise.all(ids.map((id) => b.check(id)));
    expect(b.passed()).toBe(1);
    expect(results.filter((result) => result.awaitingVariable === 'Trigram')).toHaveLength(1);
    expect(results.some((result) => result.kind === 'switch-session')).toBe(false);
    expect(ids.every(b.exists)).toBe(true);
    const loser = ids[results.findIndex((result) => result.awaitingVariable === 'Trigram')]!;
    await b.input(loser, 'Trigram', 'xyz');
    await b.input(loser, 'PIN', '3333');
    expect((await b.check(loser)).kind).not.toBe('switch-session');
    expect(b.passed()).toBe(2);
  } finally { b.db.close(); }
});

test('a failed resume draft can never become the target of a later resume', async () => {
  const b = boot();
  try {
    const owner = await b.login('abc', '1111');
    seedProgress(b, owner.id);
    const before = snapshot(b.db, owner.id);
    const draft = await b.login('abc', '2222');
    expect(draft.result.awaitingVariable).toBe('PIN');
    const recovery = await b.login('abc', '2222');
    expect(recovery.result.kind).not.toBe('switch-session');
    expect(recovery.result.awaitingVariable).toBe('PIN');
    expect(snapshot(b.db, owner.id)).toEqual(before);
    expect(b.passed()).toBe(1);
  } finally { b.db.close(); }
});

test('two simultaneous resumptions both target the confirmed owner', async () => {
  const b = boot();
  try {
    const owner = await b.login('abc', '1111');
    seedProgress(b, owner.id);
    const before = snapshot(b.db, owner.id);
    const ids = await Promise.all([b.start(), b.start()]);
    for (let i = 0; i < ids.length; i++) b.db.query('UPDATE sessions SET started_at=started_at+? WHERE id=?').run(100 * (i + 1), ids[i]!);
    await Promise.all(ids.map((id) => b.input(id, 'Trigram', 'abc')));
    await Promise.all(ids.map((id) => b.input(id, 'PIN', '1111')));
    const results = await Promise.all(ids.map((id) => b.check(id)));
    expect(results.map((result) => result.switchSessionId)).toEqual([owner.id, owner.id]);
    expect(ids.some(b.exists)).toBe(false);
    expect(snapshot(b.db, owner.id)).toEqual(before);
  } finally { b.db.close(); }
});

test('SQLite reopen preserves register intent so a late identical PIN cannot resume the winner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nig-identity-flow-'));
  const path = join(dir, 'test.sqlite');
  let b = boot(openDatabase({ path }));
  try {
    const draft = await b.start();
    await b.input(draft, 'Trigram', 'abc');
    const owner = await b.login('abc', '1111');
    seedProgress(b, owner.id);
    const before = snapshot(b.db, owner.id);
    b.db.close();
    b = boot(openDatabase({ path }));
    await b.input(draft, 'PIN', '1111');
    const result = await b.check(draft);
    expect(result.awaitingVariable).toBe('Trigram');
    expect(result.kind).not.toBe('switch-session');
    const returning = await b.login('abc', '1111');
    expect(returning.result.switchSessionId).toBe(owner.id);
    expect(snapshot(b.db, owner.id)).toEqual(before);
  } finally { b.db.close(); rmSync(dir, { recursive: true }); }
});

async function rawPost(b: ReturnType<typeof boot>, id: string, action: string, body: unknown) {
  return b.app.request(`/api/session/${id}/${action}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('old PIN and resolve requests cannot claim a newly selected code', async () => {
  const b = boot();
  try {
    const id = await b.start();
    await b.input(id, 'Trigram', 'abc');
    const oldRevision = await b.revision(id);
    await b.post(`/api/session/${id}/switch-identity`, { identityRevision: oldRevision });
    await b.advance(id);
    await b.input(id, 'Trigram', 'xyz');
    const before = snapshot(b.db, id);
    expect(await b.revision(id)).not.toBe(oldRevision);
    const stale = await rawPost(b, id, 'input', { variable: 'PIN', value: '1111', identityRevision: oldRevision });
    expect(stale.status).toBe(409);
    expect(snapshot(b.db, id)).toEqual(before);
    const staleResolve = await rawPost(b, id, 'resolve-check', { identityRevision: oldRevision });
    expect(staleResolve.status).toBe(409);
    expect(snapshot(b.db, id)).toEqual(before);
    await b.input(id, 'PIN', '2222');
    await b.check(id);
    expect(b.passed()).toBe(1);
    expect((await b.login('xyz', '2222')).result.switchSessionId).toBe(id);
  } finally { b.db.close(); }
});

test('a PIN submission without a prompt revision cannot mutate identity state', async () => {
  const b = boot();
  try {
    const id = await b.start();
    await b.input(id, 'Trigram', 'abc');
    const before = snapshot(b.db, id);
    const response = await rawPost(b, id, 'input', { variable: 'PIN', value: '1111' });
    expect(response.status).toBe(409);
    expect(snapshot(b.db, id)).toEqual(before);
  } finally { b.db.close(); }
});

test('duplicate PIN and resolve requests register once without overwriting the original PIN', async () => {
  const b = boot();
  try {
    const id = await b.start();
    await b.input(id, 'Trigram', 'abc');
    const identityRevision = await b.revision(id);
    const body = { variable: 'PIN', value: '1111', identityRevision };
    const pending = await Promise.all([rawPost(b, id, 'input', body), rawPost(b, id, 'input', body)]);
    expect(pending.map((response) => response.status)).toEqual([200, 200]);
    const results = await Promise.all([b.check(id), b.check(id)]);
    expect(results[0]).toEqual(results[1]);
    const before = snapshot(b.db, id);
    const latePin = await rawPost(b, id, 'input', { ...body, value: '9999' });
    expect(latePin.status).toBe(200);
    expect(snapshot(b.db, id)).toEqual(before);
    expect(b.passed()).toBe(1);
    expect((await b.login('abc', '1111')).result.switchSessionId).toBe(id);
    expect((await b.login('abc', '9999')).result.awaitingVariable).toBe('PIN');
  } finally { b.db.close(); }
});

test('a lost resume response can be recovered after restart and emits deletion only once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nig-identity-receipt-'));
  const path = join(dir, 'test.sqlite');
  let b = boot(openDatabase({ path }));
  try {
    const owner = await b.login('abc', '1111');
    seedProgress(b, owner.id);
    const before = snapshot(b.db, owner.id);
    const id = await b.start();
    await b.input(id, 'Trigram', 'abc');
    await b.input(id, 'PIN', '1111');
    const identityRevision = await b.revision(id);
    const first = await b.check(id);
    expect(first.switchSessionId).toBe(owner.id);
    expect(b.exists(id)).toBe(false);
    b.db.close();
    b = boot(openDatabase({ path }));
    const snapshotResponse = await b.app.request(`/api/session/${id}`);
    expect(snapshotResponse.status).toBe(200);
    expect((await snapshotResponse.json()).switchSessionId).toBe(owner.id);
    // The UI retries a lost phase-two response through advance before reloading.
    const advanceReplay = await b.post(`/api/session/${id}/advance`);
    expect(advanceReplay.switchSessionId).toBe(owner.id);
    const replay = await b.post(`/api/session/${id}/resolve-check`, { identityRevision });
    expect(replay).toEqual(first);
    const pinReplay = await b.post(`/api/session/${id}/input`, { variable: 'PIN', value: '1111', identityRevision });
    expect(pinReplay).toEqual(first);
    expect(snapshot(b.db, owner.id)).toEqual(before);
    const events = b.db.query('SELECT event_json FROM telemetry_outbox').all() as Array<{ event_json: string }>;
    const deletions = events.map((row) => JSON.parse(row.event_json)).filter((event) => event.type === 'session_deleted');
    expect(deletions.map((event) => event.sessionId)).toEqual([id]);
  } finally { b.db.close(); rmSync(dir, { recursive: true }); }
});

test('deleting an owner and reusing the code never redirects an old resume attempt to the replacement', async () => {
  const b = boot();
  try {
    const original = await b.login('abc', '1111');
    const waiting = await b.start();
    await b.input(waiting, 'Trigram', 'abc');
    const deleted = await b.app.request(`/api/admin/users/${original.id}`, {
      method: 'DELETE', headers: { 'X-Admin-Password': 'identity-test' },
    });
    expect(deleted.status).toBe(200);
    const replacement = await b.login('abc', '1111');
    seedProgress(b, replacement.id);
    const before = snapshot(b.db, replacement.id);
    await b.input(waiting, 'PIN', '1111');
    const result = await b.check(waiting);
    expect(result.awaitingVariable).toBe('Trigram');
    expect(result.kind).not.toBe('switch-session');
    expect(snapshot(b.db, replacement.id)).toEqual(before);
  } finally { b.db.close(); }
});

test('changing agent from a confirmed session starts a separate draft and preserves the owner', async () => {
  const b = boot();
  try {
    const owner = await b.login('abc', '1111');
    seedProgress(b, owner.id);
    const before = snapshot(b.db, owner.id);
    const result = await b.post(`/api/session/${owner.id}/switch-identity`, { identityRevision: await b.revision(owner.id) });
    expect(typeof result.switchSessionId).toBe('string');
    expect(result.switchSessionId).not.toBe(owner.id);
    expect(b.exists(result.switchSessionId)).toBe(true);
    expect(snapshot(b.db, owner.id)).toEqual(before);
    expect((await b.login('abc', '1111')).result.switchSessionId).toBe(owner.id);
  } finally { b.db.close(); }
});
