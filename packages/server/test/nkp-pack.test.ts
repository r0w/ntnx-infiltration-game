import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VariableStore, type CheckContext, type NutanixClient } from '@ntnx-game/engine';
import { createKubeClient, withVariableInterpolation } from '@ntnx-game/kube-transport';
import { checks } from '../../../packs/nkp-bootcamp/checks';

// Two things rot silently in a pack and only show up when someone plays it:
// a check that no longer matches the shape of its fixture (mock auto-play
// stalls), and a message key or image that a stage names but the pack does not
// ship (the terminal renders a raw key). Both are locked here.

const ROOT = resolve(import.meta.dir, '../../..');
const PACK = join(ROOT, 'packs/nkp-bootcamp');
const FIXTURES = join(PACK, 'fixtures.json');

type Manifest = { stages: string[]; supportedLocales: string[] };
const manifest = JSON.parse(readFileSync(join(PACK, 'pack.json'), 'utf8')) as Manifest;

type Stage = {
  id: string;
  name: string;
  messages: string[];
  check?: { fn: string };
  captures?: string[];
  needs?: string[];
};
const stages: Stage[] = manifest.stages.map(
  (n) => JSON.parse(readFileSync(join(PACK, 'stages', `${n}.json`), 'utf8')) as Stage,
);

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const noopNutanix: NutanixClient = {
  mode: 'mock',
  async request() {
    throw new Error('the NKP pack never touches Prism');
  },
};

/** A check context wired to the pack's own fixtures, as the server does in mock. */
function makeCtx(userNum = '07'): CheckContext {
  const vars = new VariableStore();
  vars.set('UserNum', userNum);
  const kube = withVariableInterpolation(createKubeClient({ mode: 'mock', fixtures: FIXTURES }), () => ({
    UserNum: vars.get('UserNum'),
  }));
  return {
    nutanix: noopNutanix,
    kube,
    vars,
    cache: { get: () => undefined, set: () => {}, all: () => [] },
    args: {},
    session: { id: 'sess-1', trigram: 'sess-1', locale: 'en', clusterProfile: 'other' },
    logger: silentLogger,
  };
}

describe('nkp pack structure', () => {
  test('play order matches the live bootcamp, fundamentals before the optional labs', () => {
    const order = manifest.stages;
    const at = (n: string) => order.indexOf(n);
    // The bootcamp moved deploy-and-expose into Optional Labs; the pack must
    // follow, or a learner meets kubectl before they own a namespace.
    expect(at('create-project')).toBeLessThan(at('block-storage'));
    expect(at('block-storage')).toBeLessThan(at('file-storage'));
    expect(at('conclusion')).toBeLessThan(at('deploy-app'));
    // Workspaces (the wider scope) is introduced before Projects, and the
    // LoadBalancer lab precedes the Ingress one, as the nav has them.
    expect(at('workspaces')).toBeLessThan(at('create-project'));
    expect(at('loadbalancer')).toBeLessThan(at('ingress'));
  });

  test('stage ids are unique and follow play order', () => {
    const ids = stages.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  test('every check a stage names exists in the registry', () => {
    const registry = new Set(Object.keys(checks));
    for (const stage of stages) {
      if (!stage.check) continue;
      expect(`${stage.name}: ${stage.check.fn}`).toBe(
        `${stage.name}: ${registry.has(stage.check.fn) ? stage.check.fn : 'MISSING'}`,
      );
    }
  });

  test('every check in the registry is reachable from a stage', () => {
    const used = new Set(stages.flatMap((s) => (s.check ? [s.check.fn] : [])));
    expect([...Object.keys(checks)].filter((c) => !used.has(c))).toEqual([]);
  });

  test('every message key resolves in every supported locale', () => {
    const keys = stages.flatMap((s) => s.messages);
    for (const locale of manifest.supportedLocales) {
      const bundle = JSON.parse(readFileSync(join(PACK, 'locales', `${locale}.json`), 'utf8')) as Record<string, string>;
      expect(`${locale}: ${keys.filter((k) => !(k in bundle)).join(', ')}`).toBe(`${locale}: `);
    }
  });

  test('locales carry no keys no stage asks for', () => {
    const keys = new Set(stages.flatMap((s) => s.messages));
    const en = JSON.parse(readFileSync(join(PACK, 'locales/en.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(en).filter((k) => !keys.has(k))).toEqual([]);
  });

  test('every image a message references ships in the pack', () => {
    const en = readFileSync(join(PACK, 'locales/en.json'), 'utf8');
    const missing: string[] = [];
    for (const m of en.matchAll(/<image src='([^']+)'/g)) {
      if (!existsSync(join(PACK, 'assets', m[1]))) missing.push(m[1]);
    }
    expect(missing).toEqual([]);
  });

  test('a stage that captures a value asks for it in its own text', () => {
    const en = JSON.parse(readFileSync(join(PACK, 'locales/en.json'), 'utf8')) as Record<string, string>;
    for (const stage of stages) {
      for (const captured of stage.captures ?? []) {
        const asked = stage.messages.some((k) => en[k]?.includes(`<input var='${captured}'/>`));
        expect(`${stage.name} asks for ${captured}: ${asked}`).toBe(`${stage.name} asks for ${captured}: true`);
      }
    }
  });
});

describe('nkp checks against the pack fixtures', () => {
  // The whole point of the fixtures is that a run in mock reaches the end.
  // If a check tightens and its fixture is not co-edited, this fails loudly
  // instead of stalling auto-play halfway through the bootcamp.
  test('the run is actually validated, not just narrated', () => {
    expect(stages.filter((s) => s.check).length).toBeGreaterThanOrEqual(10);
  });

  test.each(
    stages.filter((s) => s.check).map((s) => [s.name, s.check!.fn] as const),
  )('%s (%s) passes on the fixtures', async (stageName, fnName) => {
    const ctx = makeCtx();
    // CheckUserNum reads the raw input rather than cluster state.
    if (fnName === 'CheckUserNum') ctx.vars.set('UserNum', '7');
    const result = await checks[fnName as keyof typeof checks](ctx);
    expect(`${stageName}: ${result.pass} ${result.pass ? '' : (result.hint ?? '')}`).toBe(`${stageName}: true `);
  });

  // Per-learner isolation is a live property: in mock the fixture namespace is
  // the learner's own token, so it resolves for whatever number they entered.
  // The transport test covers the namespace filter itself.
  test('the checks read the learner namespace, whatever number they were given', async () => {
    for (const num of ['07', '42']) {
      const result = await checks.CheckBlockStorage(makeCtx(num));
      expect(`user${num}: ${result.pass}`).toBe(`user${num}: true`);
      expect(result.detail).toContain(`user${num}`);
    }
  });

  test('a missing user number fails neutral, so it costs no attempt', async () => {
    const ctx = makeCtx();
    ctx.vars.set('UserNum', '');
    const result = await checks.CheckProject(ctx);
    expect(result.pass).toBe(false);
    expect(result.neutral).toBe(true);
  });

  test('an absent kube transport fails neutral rather than throwing', async () => {
    const ctx = makeCtx();
    const result = await checks.CheckGitOpsSource({ ...ctx, kube: undefined });
    expect(result.pass).toBe(false);
    expect(result.neutral).toBe(true);
  });
});
