import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NutanixClient } from '@ntnx-game/engine';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import { loadPack } from '../src/pack-loader';

const pack = await loadPack(new URL('../../../packs', import.meta.url).pathname, 'ntnx-infiltration');
function boot(path = ':memory:') {
  const db = openDatabase({ path });
  const nutanix = { mode: 'live', rest: { request: async (_method: string, path: string) => {
    if (path.startsWith('/api/networking/v4.0/config/subnets')) return { data: [] };
    throw new Error(`Unexpected network: ${path}`);
  } } } as unknown as NutanixClient;
  const { app, service } = buildApp({ db, pack, nutanix, clusterEndpoint: 'https://unused.invalid',
    clusterProfile: 'other', capabilities: ['PlannerCluster'], adminPassword: 'regression-test', serverMode: 'live' });
  async function post(id: string, action: string, body = {}) {
    const response = await app.request(`/api/session/${id}/${action}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityRevision: service.identityRevision(id), ...body }) });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  }
  async function start() {
    const response = await app.request('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const { sessionId } = await response.json();
    for (let i = 0; i < 5; i++) if ((await post(sessionId, 'advance')).awaitingVariable === 'Trigram') return sessionId as string;
    throw new Error('No login prompt');
  }
  const input = (id: string, variable: string, value: string) => post(id, 'input', { variable, value });
  async function login() {
    const id = await start();
    await input(id, 'Trigram', 'abc'); await input(id, 'PIN', '1234'); await post(id, 'resolve-check');
    return id;
  }
  return { db, app, service, post, start, input, login };
}

test('a confirmed owner cannot rewind to or before login; later-stage checks ignore the login receipt', async () => {
  const b = boot();
  try {
    const id = await b.login();
    const before = b.db.query('SELECT * FROM sessions WHERE id=?').get(id);
    const history = b.db.query('SELECT * FROM stage_history WHERE session_id=?').all(id);
    for (const stage of ['login', 'lore']) {
      const response = await b.app.request(`/api/session/${id}/goto/${stage}`, { method: 'POST' });
      expect(response.status).toBe(409);
      expect(b.db.query('SELECT * FROM sessions WHERE id=?').get(id)).toEqual(before);
      expect(b.db.query('SELECT * FROM stage_history WHERE session_id=?').all(id)).toEqual(history);
    }
    await b.post(id, 'goto/capacity-runway');
    let prompt = await b.post(id, 'advance');
    for (let i = 0; i < 5 && prompt.awaitingVariable === '$continue'; i++) {
      prompt = await b.input(id, '$continue', '');
    }
    expect(prompt.awaitingVariable).toBe('Runway');
    await b.input(id, 'Runway', '365');
    const pending = b.db.query('SELECT * FROM sessions WHERE id=?').get(id);
    const attempts = b.db.query('SELECT * FROM check_attempts WHERE session_id=?').all(id);
    const replay = await b.post(id, 'resolve-check', { stageName: 'login' });
    expect(replay.stageName).toBe('login');
    expect(b.db.query('SELECT * FROM sessions WHERE id=?').get(id)).toEqual(pending);
    expect(b.db.query('SELECT * FROM check_attempts WHERE session_id=?').all(id)).toEqual(attempts);
    const verdict = await b.post(id, 'resolve-check', { stageName: 'capacity-runway' });
    expect(verdict.stageName).toBe('capacity-runway');
    expect(verdict.check.pass).toBe(true);
    expect(b.service.getSession(id).currentStage).toBe('capacity-runway');
    expect(b.service.identities.owner('abc')?.sessionId).toBe(id);
  } finally { b.db.close(); }
});

test('reload after accepting the PIN recovers the pending login and commits it once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'identity-pending-'));
  const path = join(dir, 'db');
  let b = boot(path);
  try {
    const id = await b.start();
    await b.input(id, 'Trigram', 'abc');
    await b.input(id, 'PIN', '1234');
    expect(b.service.identities.owner('abc')).toBeNull();
    const revision = b.service.identityRevision(id);
    b.db.close();
    b = boot(path);
    const snapshot = await (await b.app.request(`/api/session/${id}`)).json();
    expect(snapshot.pendingCheck.stageName).toBe('login');
    expect(snapshot.identityRevision).toBe(revision);
    await b.post(id, 'resolve-check');
    expect(b.service.identities.owner('abc')?.sessionId).toBe(id);
    await b.post(id, 'resolve-check');
    expect(b.db.query("SELECT count(*) AS n FROM check_attempts WHERE session_id=? AND stage_name='login'").get(id)).toEqual({ n: 1 });
  } finally { b.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
