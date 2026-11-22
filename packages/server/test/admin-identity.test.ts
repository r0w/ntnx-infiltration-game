import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../src/db/database';
import { SessionQueries } from '../src/db/queries';

/**
 * A pack decides what identifies a player. Before this the admin Users tab
 * read `Trigram` only, so every bootcamp session (which captures `UserNum`)
 * listed as nameless and was hidden by the "identified sessions" filter.
 */

function seed() {
  const db = openDatabase({ path: ':memory:' });
  const q = new SessionQueries(db);
  const id = 'sess-1';
  q.create({
    id,
    trigram: id,
    pinHash: 'x',
    packId: 'nkp-bootcamp',
    locale: 'en',
    clusterEndpoint: '',
    clusterProfile: 'hpoc',
    capabilities: [],
  });
  db.prepare(
    `INSERT INTO session_variables (session_id, name, value, captured_at_stage)
     VALUES ($sid, $n, $v, 'welcome')`,
  ).run({ $sid: id, $n: 'UserNum', $v: JSON.stringify('42') });
  return { db, q };
}

describe('admin identity variable', () => {
  test('defaults to Trigram, which a bootcamp session does not have', () => {
    const { q } = seed();
    expect(q.listAdmin('nkp-bootcamp')[0]!.trigram).toBeNull();
  });

  test('reads the variable the pack names, so the learner shows up', () => {
    const { q } = seed();
    expect(q.listAdmin('nkp-bootcamp', 'UserNum')[0]!.trigram).toBe('42');
  });

  test('the scoreboard follows the same variable', () => {
    const { q } = seed();
    expect(q.listScoreboard('nkp-bootcamp', 'UserNum')[0]!.trigram).toBe('42');
  });
});
