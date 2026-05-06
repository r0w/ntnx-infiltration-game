import { describe, expect, test } from 'bun:test';
import { StageRunner } from '../src/stage-runner';
import { CheckRegistry } from '../src/check-registry';
import { VariableStore } from '../src/variables';
import { makeBundle } from '../src/locale-catalog';
import type { StageDefinition, CheckContext, NutanixClient, ClusterCache, Logger } from '../src/types';

const stages: StageDefinition[] = [
  { id: 1, active: true, messages: ['s1.prompt'], saveScore: true },
  {
    id: 2,
    active: true,
    messages: ['s2.greet'],
    saveScore: true,
    check: { fn: 'noop' },
  },
  {
    id: 3,
    active: true,
    impact: 'destructive',
    messages: ['s3.destructive'],
    saveScore: true,
  },
];

const bundle = makeBundle('en', {
  en: {
    's1.prompt': "Enter trigram: <input var='Trigram'/>",
    's2.greet': 'Hello {Trigram}',
    's3.destructive': 'destructive stage',
  },
});

const makeContext = (vars: VariableStore): CheckContext => {
  const nutanix: NutanixClient = { mode: 'mock', request: async () => ({}) };
  const cache: ClusterCache = {
    get: () => undefined,
    set: () => {},
    all: () => [],
  };
  const logger: Logger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  };
  return {
    nutanix,
    vars,
    cache,
    args: {},
    session: { id: 's1', trigram: 'ABC', locale: 'en', clusterProfile: 'hpoc' },
    logger,
  };
};

describe('StageRunner', () => {
  test('nextStage picks by gating, skipping destructive on shared', () => {
    const registry = new CheckRegistry();
    registry.register('noop', async () => ({ pass: true }));
    const runner = new StageRunner(stages, registry);
    const r = runner.nextStage({ capabilities: new Set(), clusterProfile: 'other', currentStage: 2 });
    expect(r).toBeNull();
  });

  test('nextStage returns destructive on dedicated', () => {
    const registry = new CheckRegistry();
    registry.register('noop', async () => ({ pass: true }));
    const runner = new StageRunner(stages, registry);
    const r = runner.nextStage({ capabilities: new Set(), clusterProfile: 'hpoc', currentStage: 2 });
    if (r?.kind !== 'playable') throw new Error('expected playable');
    expect(r.next.id).toBe(3);
  });

  test('render reports first await-input index', () => {
    const runner = new StageRunner(stages, new CheckRegistry());
    const rendered = runner.render(stages[0], new VariableStore(), 'en', bundle);
    expect(rendered.firstAwaitInputIdx).toBeGreaterThanOrEqual(0);
    expect(rendered.units[rendered.firstAwaitInputIdx]).toEqual({ kind: 'await-input', variable: 'Trigram' });
  });

  test('render substitutes variables', () => {
    const runner = new StageRunner(stages, new CheckRegistry());
    const vars = new VariableStore({ Trigram: 'ZZZ' });
    const rendered = runner.render(stages[1], vars, 'en', bundle);
    expect(rendered.units).toEqual([
      { kind: 'text', text: 'Hello ZZZ', color: 'default' },
      { kind: 'text', text: '\n', color: 'default' },
    ]);
  });

  test('render does not double-newline when source already ends in \\n', () => {
    const runner = new StageRunner(
      [{ id: 1, active: true, messages: ['preformatted'], saveScore: true }],
      new CheckRegistry(),
    );
    const local = makeBundle('en', { en: { preformatted: 'a line\n' } });
    const rendered = runner.render(runner.listStages()[0], new VariableStore(), 'en', local);
    // One message, one trailing newline — not two.
    expect(rendered.units).toEqual([
      { kind: 'text', text: 'a line\n', color: 'default' },
    ]);
  });

  test('render falls back to default locale when key missing in requested locale', () => {
    const runner = new StageRunner(stages, new CheckRegistry());
    const bilingual = makeBundle('en', {
      en: { 's2.greet': 'Hello {Trigram}' },
      fr: {},
    });
    const vars = new VariableStore({ Trigram: 'XYZ' });
    const rendered = runner.render(stages[1], vars, 'fr', bilingual);
    expect(rendered.units[0]).toEqual({ kind: 'text', text: 'Hello XYZ', color: 'default' });
  });

  test('render preserves <a href> on text units through speaker-tag injection', () => {
    // Regression guard: injectSpeakerTag used to rebuild text units from
    // (color, styles) only, silently dropping `href` so `<a>` links rendered
    // as plain spans on the frontend. Any future edit that rewrites text
    // units in the speaker-injection pass needs to keep href (and every
    // other text-unit prop) flowing through.
    const runner = new StageRunner(
      [
        { id: 1, active: true, prompt: 'ego', messages: ['s1.m'], saveScore: true },
      ],
      new CheckRegistry(),
    );
    const local = makeBundle('en', {
      en: { 's1.m': "open the <a href='/ssh'>SSH console</a> now.\n" },
    });
    const rendered = runner.render(runner.listStages()[0], new VariableStore(), 'en', local);
    const linkUnits = rendered.units.filter(
      (u) => u.kind === 'text' && u.href === '/ssh',
    );
    expect(linkUnits.length).toBe(1);
    expect(linkUnits[0]).toMatchObject({ kind: 'text', text: 'SSH console', href: '/ssh' });
  });

  test('render preserves <a href> when the link spans a \\n\\n split', () => {
    // Same concern but for the segment-split branch of injectSpeakerTag —
    // if the href text includes a double newline we have to preserve href
    // on each side of the split.
    const runner = new StageRunner(
      [
        { id: 1, active: true, prompt: 'ego', messages: ['s1.m'], saveScore: true },
      ],
      new CheckRegistry(),
    );
    const local = makeBundle('en', {
      en: { 's1.m': "<a href='/ssh'>line one\n\nline two</a>\n" },
    });
    const rendered = runner.render(runner.listStages()[0], new VariableStore(), 'en', local);
    const linked = rendered.units.filter(
      (u) => u.kind === 'text' && u.href === '/ssh' && u.text.trim().length > 0,
    );
    // 'line one' and 'line two' both carry href; the \n\n separator does not
    // need to (it's whitespace), but it shouldn't crash the injector either.
    expect(linked.map((u) => u.kind === 'text' ? u.text : '')).toEqual(['line one', 'line two']);
  });

  test('render injects <speaker> tag at stage start and after \\n\\n splits', () => {
    const runner = new StageRunner(
      [
        {
          id: 1,
          active: true,
          prompt: 'ego',
          messages: ['s1.m1', 's1.m2'],
          saveScore: true,
        },
      ],
      new CheckRegistry(),
    );
    const local = makeBundle('en', {
      en: {
        's1.m1': 'intercepted message\ntwo lines\n\n',
        's1.m2': 'act quickly\n\n',
      },
    });
    const rendered = runner.render(runner.listStages()[0], new VariableStore(), 'en', local);
    const tags = rendered.units.filter(
      (u) => u.kind === 'text' && u.text === '<ego> ' && u.color === 'dim',
    );
    // One tag at stage start, one after the \n\n between m1 and m2.
    expect(tags.length).toBe(2);
    expect(rendered.units[0]).toEqual({ kind: 'text', text: '<ego> ', color: 'dim' });
  });

  test('render skips speaker injection when stage.prompt is empty', () => {
    const runner = new StageRunner(
      [{ id: 1, active: true, messages: ['s1.m'], saveScore: true }],
      new CheckRegistry(),
    );
    const local = makeBundle('en', { en: { 's1.m': 'plain\n\ntext' } });
    const rendered = runner.render(runner.listStages()[0], new VariableStore(), 'en', local);
    const hasTag = rendered.units.some(
      (u) => u.kind === 'text' && /^<\w+>\s/.test(u.text),
    );
    expect(hasTag).toBe(false);
  });

  test('render emits the key itself when missing everywhere (translator marker)', () => {
    const runner = new StageRunner(stages, new CheckRegistry());
    const emptyBundle = makeBundle('en', { en: {} });
    const rendered = runner.render(stages[1], new VariableStore(), 'en', emptyBundle);
    expect(rendered.units[0]).toEqual({ kind: 'text', text: 's2.greet', color: 'default' });
  });

  test('runCheck dispatches through registry', async () => {
    const registry = new CheckRegistry();
    registry.register('noop', async () => ({ pass: true, detail: 'ok' }));
    const runner = new StageRunner(stages, registry);
    const r = await runner.runCheck(stages[1], makeContext(new VariableStore()));
    expect(r).toEqual({ pass: true, detail: 'ok' });
  });

  test('runCheck on stage without check returns pass', async () => {
    const runner = new StageRunner(stages, new CheckRegistry());
    const r = await runner.runCheck(stages[0], makeContext(new VariableStore()));
    expect(r.pass).toBe(true);
  });

  test('rehydrate uses rehydrate fn when specified', async () => {
    const registry = new CheckRegistry();
    registry.register('mainCheck', async () => ({ pass: true, detail: 'main' }));
    registry.register('rehydrateCheck', async () => ({ pass: true, detail: 'rehydrated' }));
    const runner = new StageRunner(
      [
        {
          id: 1,
          active: true,
          messages: [],
          saveScore: true,
          check: { fn: 'mainCheck', rehydrate: 'rehydrateCheck' },
        },
      ],
      registry,
    );
    const r = await runner.rehydrate(runner.listStages()[0], makeContext(new VariableStore()));
    expect(r.detail).toBe('rehydrated');
  });
});
