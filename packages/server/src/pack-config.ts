/**
 * Portable stage configuration: the operator's pack overlay (which stages
 * are on/off, which are gated) squeezed into one string they can copy out
 * of one instance and paste into another.
 *
 * Payload, before compression:
 *   {
 *     v: 1,
 *     p: "<pack id>",
 *     s: ["<every stage the source pack had, in order>"],
 *     o: { "<stage>": { active?, adminGate? } }
 *   }
 *
 * Only overridden fields are carried. The full stage roster rides along
 * because packs gain and lose stages between versions: without it, import
 * can spot a stage that vanished (it shows up in `o`) but not one that was
 * added, so the operator would never be told a new stage sits at its
 * default. The roster is most of the bytes, hence the deflate pass, which
 * roughly halves the string. Encoding is deterministic (stages sorted,
 * fields in a fixed order), so the same setup always produces the same
 * string and two operators can compare configs by eye.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { PackOverlayRow } from './db/queries';

/** Marks the payload as ours and pins the format version. */
export const PACK_CONFIG_PREFIX = 'NIG1.';

/** Rejected beyond this many characters: a paste that big is not a config. */
const MAX_CONFIG_CHARS = 64 * 1024;

/** Guards the decoder against a small string that inflates to a huge one. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

export interface PackConfigOverride {
  active?: boolean;
  adminGate?: boolean;
}

export interface DecodedPackConfig {
  packId: string;
  /** Stage roster of the pack this config was exported from. `null` when
   *  the string omits it (hand-written configs are allowed to), in which
   *  case import can't report the stages added since. */
  stages: string[] | null;
  overrides: Record<string, PackConfigOverride>;
}

/** Thrown for anything an operator could plausibly paste and get wrong. */
export class PackConfigError extends Error {}

function pack(json: string): string {
  return deflateRawSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url');
}

function unpack(body: string): string {
  return inflateRawSync(Buffer.from(body, 'base64url'), {
    maxOutputLength: MAX_PAYLOAD_BYTES,
  }).toString('utf8');
}

/**
 * Overlay rows that still match a stage in the pack. The overlay table has
 * no foreign key to the pack (packs live on disk), so rows for stages a
 * later pack version renamed or dropped linger in the DB. Exporting those
 * would ship dead weight and make every import report a phantom missing
 * stage, so both the export and its count go through here.
 */
export function liveOverlayRows(
  rows: readonly PackOverlayRow[],
  packStageNames: readonly string[],
): PackOverlayRow[] {
  const known = new Set(packStageNames);
  return rows.filter((r) => known.has(r.stageName) && !(r.active === null && r.adminGate === null));
}

/**
 * Encode the sparse overlay rows into the portable string. Rows with no
 * override at all, or pointing at a stage this pack no longer has, are
 * dropped.
 */
export function encodePackConfig(
  packId: string,
  packStageNames: readonly string[],
  rows: readonly PackOverlayRow[],
): string {
  const overrides: Record<string, PackConfigOverride> = {};
  const live = liveOverlayRows(rows, packStageNames);
  for (const r of [...live].sort((a, b) => a.stageName.localeCompare(b.stageName))) {
    const o: PackConfigOverride = {};
    if (r.active !== null) o.active = r.active;
    if (r.adminGate !== null) o.adminGate = r.adminGate;
    if (Object.keys(o).length > 0) overrides[r.stageName] = o;
  }
  return (
    PACK_CONFIG_PREFIX +
    pack(JSON.stringify({ v: 1, p: packId, s: packStageNames, o: overrides }))
  );
}

/**
 * Parse a pasted string back into a config. Tolerates the whitespace and
 * line breaks a chat client or email adds to a long token, since that's how
 * these strings travel between operators.
 */
export function decodePackConfig(input: string): DecodedPackConfig {
  if (typeof input !== 'string') throw new PackConfigError('config must be a string');
  if (input.length > MAX_CONFIG_CHARS) throw new PackConfigError('config string is too long');
  const compact = input.replace(/\s+/g, '');
  if (compact === '') throw new PackConfigError('config string is empty');
  if (!compact.startsWith(PACK_CONFIG_PREFIX)) {
    throw new PackConfigError(`config string must start with ${PACK_CONFIG_PREFIX}`);
  }
  const body = compact.slice(PACK_CONFIG_PREFIX.length);
  if (body === '') throw new PackConfigError('config string carries no payload');

  let parsed: unknown;
  try {
    parsed = JSON.parse(unpack(body));
  } catch {
    throw new PackConfigError('config string is corrupt (not a valid encoded config)');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PackConfigError('config payload must be an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) throw new PackConfigError(`unsupported config version: ${String(obj.v)}`);
  if (typeof obj.p !== 'string' || obj.p === '') {
    throw new PackConfigError('config payload has no pack id');
  }
  let stages: string[] | null = null;
  if (obj.s !== undefined && obj.s !== null) {
    if (!Array.isArray(obj.s) || obj.s.some((s) => typeof s !== 'string')) {
      throw new PackConfigError('config payload stage roster must be an array of stage names');
    }
    stages = obj.s as string[];
  }
  const rawOverrides = obj.o;
  if (typeof rawOverrides !== 'object' || rawOverrides === null || Array.isArray(rawOverrides)) {
    throw new PackConfigError('config payload has no overrides object');
  }

  const overrides: Record<string, PackConfigOverride> = {};
  for (const [stageName, raw] of Object.entries(rawOverrides as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new PackConfigError(`override for '${stageName}' must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    const o: PackConfigOverride = {};
    for (const field of ['active', 'adminGate'] as const) {
      const v = entry[field];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'boolean') {
        throw new PackConfigError(`override '${stageName}.${field}' must be a boolean`);
      }
      o[field] = v;
    }
    if (Object.keys(o).length > 0) overrides[stageName] = o;
  }
  return { packId: obj.p, stages, overrides };
}

export interface PackConfigPlan {
  /** Overrides that map onto a stage this pack actually has. */
  applied: Array<{ stageName: string; active: boolean | null; adminGate: boolean | null }>;
  /** Overridden names the local pack no longer has: stages deleted since
   *  the config was exported. Their override is dropped. */
  missingStages: string[];
  /** Stages the local pack has that the config's pack didn't: added since
   *  the export. They keep their JSON default, so the operator has to decide
   *  what to do with them, so the UI says so out loud. */
  newStages: string[];
}

/**
 * Resolve a decoded config against the pack that's actually loaded.
 *
 * Packs gain and lose stages between versions, so stage drift is reported,
 * never fatal: an operator importing a config exported before a stage was
 * added or removed still gets every stage the two packs share. A pack-id
 * mismatch IS fatal: two different packs share no stage vocabulary, so the
 * import would silently wipe the operator's setup and apply nothing.
 */
export function planPackConfigImport(
  config: DecodedPackConfig,
  packId: string,
  packStageNames: readonly string[],
): PackConfigPlan {
  if (config.packId !== packId) {
    throw new PackConfigError(
      `config is for pack '${config.packId}', this server runs '${packId}'`,
    );
  }
  const known = new Set(packStageNames);
  const applied: PackConfigPlan['applied'] = [];
  const missingStages: string[] = [];
  for (const [stageName, o] of Object.entries(config.overrides)) {
    if (!known.has(stageName)) {
      missingStages.push(stageName);
      continue;
    }
    applied.push({ stageName, active: o.active ?? null, adminGate: o.adminGate ?? null });
  }
  applied.sort((a, b) => a.stageName.localeCompare(b.stageName));
  // Without a roster we can't tell a new stage from one the source pack
  // simply left at its default, so report nothing rather than everything.
  const sourceStages = config.stages === null ? null : new Set(config.stages);
  const newStages =
    sourceStages === null ? [] : packStageNames.filter((n) => !sourceStages.has(n));
  return { applied, missingStages: missingStages.sort(), newStages: [...newStages].sort() };
}
