import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { StageRunner, type Locale } from '@ntnx-game/engine';
import { openDatabase } from '../src/db/database';
import { loadPack } from '../src/pack-loader';
import { SessionService } from '../src/session-service';

async function setup(packId: string, locale: Locale = 'fr') {
  const pack = await loadPack(resolve(import.meta.dir, '../../../packs'), packId);
  const db = openDatabase({ path: ':memory:' });
  const service = new SessionService({ db, packId, bundle: pack.bundle,
    runner: new StageRunner(pack.stages, pack.checks, { pauseAfterImages: pack.manifest.pauseAfterImages, speakers: pack.manifest.speakers }),
    nutanix: { mode: 'mock', async request() { throw Error('Briefing must not call the cluster'); } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    initialVariables: { PC: 'https://pc.example:9440', PCUser: 'initial-admin', PCPassword: 'initial-secret', DashboardUrl: 'https://nkp.example', Username: 'Agent Test' },
  });
  const session = await service.create({ locale, clusterEndpoint: '', clusterProfile: 'other', capabilities: [] });
  return { service, session, db };
}

describe('resume briefing', () => {
  test('new sessions do not get a reconnection briefing', async () => {
    for (const pack of ['ntnx-infiltration', 'nkp-bootcamp']) {
      const { service, session, db } = await setup(pack);
      expect(service.resumeBriefing(session.id)).toBeNull();
      db.close();
    }
  });
  test('NCP recalls the personal account and local-login image without a password or progress mutation', async () => {
    for (const locale of ['en', 'fr', 'de', 'es', 'it'] as const) {
      const { service, session, db } = await setup('ntnx-infiltration', locale);
      service.variables.upsert(session.id, 'Trigram', 'rsm', 'login');
      service.sessions.updateCurrentStage(session.id, 'switch-to-admin-user');
      const before = service.getSession(session.id);
      const units = service.resumeBriefing(session.id)!;
      expect(units.some(u => u.kind === 'text' && u.text.includes('rsm-adm'))).toBe(true);
      expect(units.some(u => u.kind === 'text' && u.href === 'https://pc.example:9440')).toBe(true);
      expect(units.some(u => u.kind === 'image' && u.src === 'stage-006-local-account.png')).toBe(true);
      expect(JSON.stringify(units)).not.toContain('initial-secret');
      expect(units.filter(u => u.kind === 'await-input')).toEqual([{ kind: 'await-input', variable: '$continue' }]);
      expect(service.getSession(session.id)).toEqual(before);
      db.close();
    }
  });
  test('NCP still setting up its account gets the initial access instructions', async () => {
    const { service, session, db } = await setup('ntnx-infiltration');
    service.variables.upsert(session.id, 'Trigram', 'rsm', 'login');
    service.sessions.updateCurrentStage(session.id, 'create-admin-user');
    expect(JSON.stringify(service.resumeBriefing(session.id))).toContain('initial-admin');
    db.close();
  });
  test('NKP uses its own console, user and authentication image with one continue prompt', async () => {
    const { service, session, db } = await setup('nkp-bootcamp');
    service.variables.upsert(session.id, 'UserNum', '07', 'welcome');
    service.sessions.updateCurrentStage(session.id, 'access');
    const units = service.resumeBriefing(session.id)!;
    expect(units.some(u => u.kind === 'text' && u.text.includes('user07'))).toBe(true);
    expect(units.some(u => u.kind === 'text' && u.href === 'https://nkp.example')).toBe(true);
    expect(units.some(u => u.kind === 'image' && u.src === 'dashboard-ldap-auth.e90e9704.gif')).toBe(true);
    expect(units.filter(u => u.kind === 'await-input')).toHaveLength(1);
    expect(JSON.stringify(units)).not.toContain('initial-secret');
    expect(JSON.stringify(units)).not.toContain('rsm-adm');
    db.close();
  });
});


test('every pack locale has distinct resume and recall dialogue without changing mission progress', async () => {
  for (const packId of ['ntnx-infiltration', 'nkp-bootcamp']) {
    const locales: Locale[] = packId === 'ntnx-infiltration' ? ['en', 'fr', 'de', 'es', 'it'] : ['en', 'fr'];
    for (const locale of locales) {
      const catalog = JSON.parse(readFileSync(resolve(import.meta.dir, `../../../packs/${packId}/locales/${locale}.json`), 'utf8'));
      const { service, session, db } = await setup(packId, locale);
      const ncp = packId === 'ntnx-infiltration';
      service.variables.upsert(session.id, ncp ? 'Trigram' : 'UserNum', ncp ? 'rsm' : '07', 'identity');
      service.sessions.updateCurrentStage(session.id, ncp ? 'switch-to-admin-user' : 'access');
      const before = service.getSession(session.id);
      for (const key of ncp ? ['resume.personal', 'resume.initial'] : ['resume.access']) {
        expect(typeof catalog[key]).toBe('string');
      }
      for (const context of ['resume', 'recall'] as const) {
        expect(typeof catalog[`${context}.intro`]).toBe('string');
        expect(typeof catalog[`${context}.continue`]).toBe('string');
        const units = service.resumeBriefing(session.id, context)!;
        const text = units.filter(u => u.kind === 'text').map(u => u.text).join('');
        const opening = catalog[`${context}.intro`].replace(/<[^>]+>/g, '').slice(0, 12);
        expect(text).toContain(opening);
        expect(text).not.toMatch(/\{(?:Username|Trigram|UserNum|PC|DashboardUrl)\}/);
        expect(units.filter(u => u.kind === 'await-input')).toHaveLength(1);
        expect(units.some(u => u.kind === 'image')).toBe(true);
        expect(JSON.stringify(units)).not.toContain('initial-secret');
        expect(service.getSession(session.id)).toEqual(before);
      }
      expect(catalog['recall.intro']).not.toBe(catalog['resume.intro']);
      expect(catalog['recall.continue']).not.toBe(catalog['resume.continue']);
      db.close();
    }
  }
});
