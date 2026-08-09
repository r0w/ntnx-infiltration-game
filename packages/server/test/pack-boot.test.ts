/**
 * What a game knows at boot belongs to the game.
 *
 * Before this seam the server carried it: a kubeconfig env var named after one
 * pack, a console URL seeded into every session including the game that has no
 * console, and a regex naming `UserNum` inside an operator route. Each was
 * invisible to the pack that owned it and free to rot; the map of pure-input
 * stages beside them still listed `switch-to-admin-user`, a stage whose check
 * had been gone for months.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createKubeClient } from '@ntnx-game/kube-transport';
import { loadPack } from '../src/pack-loader';

const PACKS = resolve(import.meta.dir, '../../../packs');
const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('pack boot module', () => {
  test('the infiltration game seeds its own world, and asks for no extra transport', async () => {
    const pack = await loadPack(PACKS, 'ntnx-infiltration');
    expect(pack.manifest.transports ?? []).toEqual([]);
    const vars = await pack.boot.variables!({
      mode: 'mock',
      env: { GAME_IMAGE_URL: 'http://example/img.qcow2', GAME_PROD_USERNAME: 'bad' },
      logger: silent,
      transports: {},
    });
    expect(vars.ImageURL).toBe('http://example/img.qcow2');
    expect(vars.ProdUsername).toBe('bad');
    // A game with no console must not be handed one.
    expect(vars.DashboardUrl).toBeUndefined();
  });

  test('an unset setting falls back rather than rendering a hole in the prompt', async () => {
    const pack = await loadPack(PACKS, 'ntnx-infiltration');
    const vars = await pack.boot.variables!({
      mode: 'mock',
      env: {},
      logger: silent,
      transports: {},
    });
    expect(String(vars.ImageURL)).toContain('jammy');
    expect(vars.ProdUsername).toBe('');
  });

  test('the bootcamp asks for a kube transport and reads its addresses off it', async () => {
    const pack = await loadPack(PACKS, 'nkp-bootcamp');
    expect(pack.manifest.transports).toEqual(['kube']);
    const kube = createKubeClient({
      mode: 'mock',
      fixtures: resolve(PACKS, 'nkp-bootcamp/fixtures.json'),
    });
    const vars = await pack.boot.variables!({
      mode: 'mock',
      env: {},
      logger: silent,
      transports: { kube },
    });
    expect(vars.MgmtIngressIP).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(vars.Workload1IngressIP).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(vars.DashboardUrl).toBe(`https://${vars.MgmtIngressIP}/dkp/kommander/dashboard`);
  });

  test('with no fleet to ask, the bootcamp keeps its published wording', async () => {
    const pack = await loadPack(PACKS, 'nkp-bootcamp');
    const vars = await pack.boot.variables!({
      mode: 'live',
      env: {},
      logger: silent,
      transports: {},
    });
    expect(vars.DashboardUrl).toBe('https://your-nkp-console/dkp/kommander/dashboard');
  });

  test('an operator-pinned console URL always wins', async () => {
    const pack = await loadPack(PACKS, 'nkp-bootcamp');
    const kube = createKubeClient({
      mode: 'mock',
      fixtures: resolve(PACKS, 'nkp-bootcamp/fixtures.json'),
    });
    const vars = await pack.boot.variables!({
      mode: 'mock',
      env: { NKP_DASHBOARD_URL: 'https://nkp.example/dash' },
      logger: silent,
      transports: { kube },
    });
    expect(vars.DashboardUrl).toBe('https://nkp.example/dash');
  });
});

describe('who the operator endpoints act for', () => {
  test('the bootcamp accepts every spelling of a learner number', async () => {
    const pack = await loadPack(PACKS, 'nkp-bootcamp');
    for (const seg of ['user01', '01', '1', 'USER1']) {
      expect(`${seg} → ${JSON.stringify(pack.boot.identityFromPath!(seg))}`).toBe(
        `${seg} → {"UserNum":"01"}`,
      );
    }
    expect(pack.boot.identityFromPath!('user42')).toEqual({ UserNum: '42' });
  });

  test('a segment that is not a learner number seeds nothing', async () => {
    const pack = await loadPack(PACKS, 'nkp-bootcamp');
    // On this pack that is an operator typo, and acting on `user0` or on some
    // half-parsed namespace is worse than doing nothing.
    for (const seg of ['xy9', '', 'user', '0', '100']) {
      expect(`${seg} → ${JSON.stringify(pack.boot.identityFromPath!(seg))}`).toBe(`${seg} → {}`);
    }
  });

  test('the infiltration game names nobody else — the trigram is the identity', async () => {
    const pack = await loadPack(PACKS, 'ntnx-infiltration');
    expect(pack.boot.identityFromPath).toBeUndefined();
  });
});
