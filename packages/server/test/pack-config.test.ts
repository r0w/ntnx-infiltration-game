import { describe, expect, test } from 'bun:test';
import {
  decodePackConfig,
  encodePackConfig,
  planPackConfigImport,
  PackConfigError,
  PACK_CONFIG_PREFIX,
} from '../src/pack-config';
import type { PackOverlayRow } from '../src/db/queries';

const PACK = 'test-pack';
const STAGES = ['login', 'intro', 'outro'];

function row(
  stageName: string,
  active: boolean | null,
  adminGate: boolean | null,
): PackOverlayRow {
  return { stageName, active, adminGate };
}

/** Hand-build a config string so tests can forge payloads the encoder
 *  would never produce (wrong pack, unknown stages, bad types). */
function forge(payload: unknown): string {
  return PACK_CONFIG_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('encodePackConfig / decodePackConfig', () => {
  test('round-trips overrides and the stage roster', () => {
    const s = encodePackConfig(PACK, STAGES, [
      row('intro', false, null),
      row('outro', null, true),
    ]);
    const decoded = decodePackConfig(s);
    expect(decoded.packId).toBe(PACK);
    expect(decoded.stages).toEqual(STAGES);
    expect(decoded.overrides).toEqual({
      intro: { active: false },
      outro: { adminGate: true },
    });
  });

  test('carries both fields when both are overridden', () => {
    const s = encodePackConfig(PACK, STAGES, [row('intro', false, true)]);
    expect(decodePackConfig(s).overrides).toEqual({ intro: { active: false, adminGate: true } });
  });

  test('an untouched pack encodes to an empty override set', () => {
    const decoded = decodePackConfig(encodePackConfig(PACK, STAGES, []));
    expect(decoded.overrides).toEqual({});
    expect(decoded.stages).toEqual(STAGES);
  });

  test('rows with no override at all are dropped', () => {
    const decoded = decodePackConfig(encodePackConfig(PACK, STAGES, [row('intro', null, null)]));
    expect(decoded.overrides).toEqual({});
  });

  // The overlay table outlives the pack version that wrote it, so a stage
  // dropped from the pack leaves a row behind. Exporting it would make
  // every import elsewhere report a phantom missing stage.
  test('rows for stages the pack no longer has are dropped', () => {
    const decoded = decodePackConfig(
      encodePackConfig(PACK, STAGES, [row('intro', false, null), row('long-gone', false, null)]),
    );
    expect(decoded.overrides).toEqual({ intro: { active: false } });
  });

  test('export then import then re-export is stable despite a stale row', () => {
    const rows = [row('intro', false, null), row('long-gone', true, null)];
    const first = encodePackConfig(PACK, STAGES, rows);
    const plan = planPackConfigImport(decodePackConfig(first), PACK, STAGES);
    expect(encodePackConfig(PACK, STAGES, plan.applied)).toBe(first);
  });

  test('encoding is deterministic and order-independent', () => {
    const a = encodePackConfig(PACK, STAGES, [row('outro', null, true), row('intro', false, null)]);
    const b = encodePackConfig(PACK, STAGES, [row('intro', false, null), row('outro', null, true)]);
    expect(a).toBe(b);
  });

  test('tolerates the whitespace a chat client wraps into a long token', () => {
    const s = encodePackConfig(PACK, STAGES, [row('intro', false, null)]);
    const mangled = `  ${s.slice(0, 12)}\n${s.slice(12, 30)} ${s.slice(30)}\t`;
    expect(decodePackConfig(mangled).overrides).toEqual({ intro: { active: false } });
  });

  test('rejects an empty string, a missing prefix, and a prefix with no payload', () => {
    expect(() => decodePackConfig('   ')).toThrow(PackConfigError);
    expect(() => decodePackConfig('hello')).toThrow(/must start with/);
    expect(() => decodePackConfig(PACK_CONFIG_PREFIX)).toThrow(/no payload/);
  });

  test('rejects a corrupt payload', () => {
    expect(() => decodePackConfig(`${PACK_CONFIG_PREFIX}not-base64-json!!`)).toThrow(/corrupt/);
  });

  test('rejects a future format version', () => {
    expect(() => decodePackConfig(forge({ v: 2, pack: PACK, overrides: {} }))).toThrow(
      /unsupported config version/,
    );
  });

  test('rejects a payload with no pack id or no overrides object', () => {
    expect(() => decodePackConfig(forge({ v: 1, overrides: {} }))).toThrow(/no pack id/);
    expect(() => decodePackConfig(forge({ v: 1, pack: PACK }))).toThrow(/no overrides object/);
    expect(() => decodePackConfig(forge({ v: 1, pack: PACK, overrides: [] }))).toThrow(
      /no overrides object/,
    );
  });

  test('rejects non-boolean override values', () => {
    expect(() =>
      decodePackConfig(forge({ v: 1, pack: PACK, overrides: { intro: { active: 'yes' } } })),
    ).toThrow(/must be a boolean/);
    expect(() =>
      decodePackConfig(forge({ v: 1, pack: PACK, overrides: { intro: 'off' } })),
    ).toThrow(/must be an object/);
  });

  test('accepts a hand-written config with no stage roster', () => {
    const decoded = decodePackConfig(
      forge({ v: 1, pack: PACK, overrides: { intro: { active: false } } }),
    );
    expect(decoded.stages).toBeNull();
    expect(decoded.overrides).toEqual({ intro: { active: false } });
  });

  test('rejects a stage roster that is not an array of names', () => {
    expect(() =>
      decodePackConfig(forge({ v: 1, pack: PACK, stages: [1, 2], overrides: {} })),
    ).toThrow(/array of stage names/);
  });
});

describe('planPackConfigImport', () => {
  test('maps overrides onto the pack, filling the untouched field with null', () => {
    const cfg = decodePackConfig(
      encodePackConfig(PACK, STAGES, [row('intro', false, null), row('outro', null, true)]),
    );
    const plan = planPackConfigImport(cfg, PACK, STAGES);
    expect(plan.applied).toEqual([
      { stageName: 'intro', active: false, adminGate: null },
      { stageName: 'outro', active: null, adminGate: true },
    ]);
    expect(plan.missingStages).toEqual([]);
    expect(plan.newStages).toEqual([]);
  });

  test('a pack-id mismatch is fatal', () => {
    const cfg = decodePackConfig(encodePackConfig('other-pack', STAGES, []));
    expect(() => planPackConfigImport(cfg, PACK, STAGES)).toThrow(
      /config is for pack 'other-pack', this server runs 'test-pack'/,
    );
  });

  // The pack evolves between versions — an import from either side of a
  // stage add/remove has to land the stages the two packs still share.
  test('a stage deleted since the export is reported, not fatal', () => {
    const cfg = decodePackConfig(
      encodePackConfig(PACK, [...STAGES, 'retired'], [
        row('intro', false, null),
        row('retired', false, null),
      ]),
    );
    const plan = planPackConfigImport(cfg, PACK, STAGES);
    expect(plan.applied.map((a) => a.stageName)).toEqual(['intro']);
    expect(plan.missingStages).toEqual(['retired']);
  });

  test('a stage added since the export is reported and left at its default', () => {
    const cfg = decodePackConfig(encodePackConfig(PACK, STAGES, [row('intro', false, null)]));
    const plan = planPackConfigImport(cfg, PACK, [...STAGES, 'brand-new']);
    expect(plan.applied.map((a) => a.stageName)).toEqual(['intro']);
    expect(plan.newStages).toEqual(['brand-new']);
    // Left out of `applied` entirely — a replace-all write drops any local
    // override on it, which IS the pack default.
    expect(plan.applied.some((a) => a.stageName === 'brand-new')).toBe(false);
  });

  test('reports both directions of drift at once', () => {
    const cfg = decodePackConfig(
      encodePackConfig(PACK, ['login', 'intro', 'retired'], [row('retired', false, null)]),
    );
    const plan = planPackConfigImport(cfg, PACK, ['login', 'intro', 'brand-new']);
    expect(plan.missingStages).toEqual(['retired']);
    expect(plan.newStages).toEqual(['brand-new']);
    expect(plan.applied).toEqual([]);
  });

  test('without a roster, no stage is claimed to be new', () => {
    const cfg = decodePackConfig(
      forge({ v: 1, pack: PACK, overrides: { intro: { active: false } } }),
    );
    const plan = planPackConfigImport(cfg, PACK, [...STAGES, 'brand-new']);
    expect(plan.newStages).toEqual([]);
    expect(plan.applied.map((a) => a.stageName)).toEqual(['intro']);
  });
});
