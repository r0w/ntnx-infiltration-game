import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type {
  ActFunction,
  ActionFunction,
  CheckFunction,
  CleanupFunction,
  Locale,
  LocaleBundle,
  LocaleCatalog,
  StageDefinition,
} from '@ntnx-game/engine';
import {
  ActionRegistry,
  ActRegistry,
  CheckRegistry,
  CleanupRegistry,
} from '@ntnx-game/engine';

/**
 * One row in a pack's reading menu. `stage` names a stage in `stages`;
 * `title` is a locale key, resolved per session. Rows nest one level, which
 * is as deep as the NKP bootcamp's own sidebar goes.
 */
export interface PackNavItem {
  stage: string;
  title: string;
  items?: PackNavItem[];
}

export interface PackNavChapter {
  id: string;
  title: string;
  /** A chapter the run reaches but nobody has to finish (the trailing labs). */
  optional?: boolean;
  items: PackNavItem[];
}

export interface PackManifest {
  id: string;
  name: string;
  /**
   * What players see in the browser tab, the header, and the login card.
   * Distinct from `name`, which is the operator-facing label in `/admin`.
   * A second pack is a different game and must not wear the first one's
   * name; falls back to the infiltration game's title when absent so the
   * original pack renders exactly as it always has.
   */
  title?: string;
  version: string;
  description?: string;
  /**
   * Whether this pack's stages read Nutanix cluster facts.
   *
   * When true (the default), boot runs two Prism interrogations: the capability
   * probe, which decides what a cluster can play (NCM present? spare node?
   * Intelligent Operations on?), and the cluster-config snapshot, which caches
   * slow answers like rackable-unit serials and the LCM update count. Both
   * exist to answer questions only the infiltration game's stages ask.
   *
   * Set `false` and boot skips both. That is not merely an optimisation: these
   * queries have no deadline, so one slow answer holds the server short of
   * listening, and a pack that never reads the answers would wait for nothing.
   */
  clusterFacts?: boolean;
  /**
   * Park on a "press Enter" after every screenshot. See
   * {@link StageRunnerOptions.pauseAfterImages}. Off by default.
   */
  pauseAfterImages?: boolean;
  /**
   * Print each screenshot's description under it in the stream.
   *
   * The description already exists as the image's alt text; this decides
   * whether it is only read by assistive tech and the lightbox, or shown to
   * everyone. A pack that teaches through screenshots wants the caption
   * visible; one that uses them as atmosphere does not. Off by default.
   */
  imageCaptions?: boolean;
  /**
   * A reading menu down the side of the terminal: chapters, the stages under
   * them, and the order they were taught in. Present only for packs whose
   * source material had a table of contents worth keeping — the infiltration
   * game is a story you play forward, and has none.
   *
   * The menu is a map, not a controller. It never unlocks anything: lock state
   * is read from where the player has actually got to, and the order here must
   * match `stages` for that reading to hold.
   */
  nav?: PackNavChapter[];
  checks: string;
  actions?: string;
  /**
   * Path (relative to pack root) to the module exporting `acts` — a map
   * from stage name to {@link ActFunction}. Optional: stages without an
   * act keep requiring manual player action (auto-play skips them).
   */
  acts?: string;
  /**
   * Path (relative to pack root) to the module exporting `cleanups` — a map
   * from stage name to {@link CleanupFunction}. Optional: stages without a
   * cleanup aren't undone by the bulk-cleanup admin endpoint.
   */
  cleanups?: string;
  /** Directory (relative to pack root) that holds `<name>.json` stage files. */
  stagesDir: string;
  /**
   * Canonical stage ordering — names match `stagesDir/<name>.json`. The pack-loader
   * assigns each stage a numeric `index` equal to its position here; reordering is a
   * swap in this array, insertion is a new entry + file, deletion is a removal. No
   * renumbering cascades through stage files or locale keys.
   */
  stages: string[];
  locales?: string;
  defaultLocale: Locale;
  supportedLocales: Locale[];
  /**
   * Locales flagged as work-in-progress: strings can be missing, so the runtime
   * falls back to `defaultLocale`. Hidden from end users in `live` mode unless
   * the operator explicitly enables them from `/admin`; always shown in
   * `mock` / `test` for translators + QA. Non-WIP locales ignore this list
   * and are always visible. Empty/missing = no WIP locales.
   */
  wipLocales?: Locale[];
}

export interface LoadedPack {
  manifest: PackManifest;
  dir: string;
  stages: StageDefinition[];
  checks: CheckRegistry;
  actions: ActionRegistry;
  acts: ActRegistry;
  cleanups: CleanupRegistry;
  bundle: LocaleBundle;
}

export async function loadPack(packsDir: string, packId: string): Promise<LoadedPack> {
  const dir = resolve(packsDir, packId);
  const manifestRaw = await readFile(join(dir, 'pack.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw) as PackManifest;
  const stages = await loadStages(resolve(dir, manifest.stagesDir), manifest.stages);
  const checks = await loadChecks(resolve(dir, manifest.checks));
  const actions = manifest.actions
    ? await loadActions(resolve(dir, manifest.actions))
    : new ActionRegistry();
  const acts = manifest.acts
    ? await loadActs(resolve(dir, manifest.acts))
    : new ActRegistry();
  const cleanups = manifest.cleanups
    ? await loadCleanups(resolve(dir, manifest.cleanups))
    : new CleanupRegistry();
  const bundle = manifest.locales
    ? await loadLocaleBundle(resolve(dir, manifest.locales), manifest)
    : emptyBundleFromManifest(manifest);
  return { manifest, dir, stages, checks, actions, acts, cleanups, bundle };
}

async function loadStages(dir: string, order: string[]): Promise<StageDefinition[]> {
  const stages: StageDefinition[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < order.length; i++) {
    const name = order[i]!;
    const raw = await readFile(join(dir, `${name}.json`), 'utf8');
    const parsed = JSON.parse(raw) as Omit<StageDefinition, 'index'> & { index?: number };
    if (parsed.name !== name) {
      throw new Error(
        `pack.json lists stage "${name}" at index ${i} but ${name}.json declares name="${parsed.name}"`,
      );
    }
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
      throw new Error(`stage "${name}" is missing its durable string "id"`);
    }
    if (seenIds.has(parsed.id)) {
      throw new Error(`duplicate stage id "${parsed.id}" (stage "${name}")`);
    }
    seenIds.add(parsed.id);
    parsed.index = i;
    stages.push(parsed as StageDefinition);
  }
  return stages;
}

async function loadLocaleBundle(dir: string, manifest: PackManifest): Promise<LocaleBundle> {
  const catalogs: Record<Locale, LocaleCatalog> = {};
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return emptyBundleFromManifest(manifest);
  }
  for (const locale of manifest.supportedLocales) {
    const file = `${locale}.json`;
    if (!entries.includes(file)) {
      catalogs[locale] = {};
      continue;
    }
    const raw = await readFile(join(dir, file), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isFlatStringMap(parsed)) {
      throw new Error(`locale file ${file} must be a flat {string: string} map`);
    }
    catalogs[locale] = parsed;
  }
  return {
    defaultLocale: manifest.defaultLocale,
    supported: manifest.supportedLocales,
    catalogs,
  };
}

function emptyBundleFromManifest(manifest: PackManifest): LocaleBundle {
  const catalogs: Record<Locale, LocaleCatalog> = {};
  for (const locale of manifest.supportedLocales) catalogs[locale] = {};
  return {
    defaultLocale: manifest.defaultLocale,
    supported: manifest.supportedLocales,
    catalogs,
  };
}

function isFlatStringMap(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return false;
  }
  return true;
}

async function loadChecks(modulePath: string): Promise<CheckRegistry> {
  const registry = new CheckRegistry();
  try {
    const mod = (await import(modulePath)) as Record<string, unknown>;
    const exported = (mod.checks ?? mod.default ?? mod) as Record<string, unknown>;
    for (const [name, fn] of Object.entries(exported)) {
      if (typeof fn === 'function') {
        registry.register(name, fn as CheckFunction);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('Cannot find module')) throw err;
  }
  return registry;
}

async function loadActions(modulePath: string): Promise<ActionRegistry> {
  const registry = new ActionRegistry();
  try {
    const mod = (await import(modulePath)) as Record<string, unknown>;
    const exported = (mod.actions ?? mod.default ?? mod) as Record<string, unknown>;
    for (const [name, fn] of Object.entries(exported)) {
      if (typeof fn === 'function') {
        registry.register(name, fn as ActionFunction);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('Cannot find module')) throw err;
  }
  return registry;
}

async function loadActs(modulePath: string): Promise<ActRegistry> {
  const registry = new ActRegistry();
  try {
    const mod = (await import(modulePath)) as Record<string, unknown>;
    const exported = (mod.acts ?? mod.default ?? mod) as Record<string, unknown>;
    for (const [stageName, fn] of Object.entries(exported)) {
      if (typeof fn === 'function') {
        registry.register(stageName, fn as ActFunction);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('Cannot find module')) throw err;
  }
  return registry;
}

async function loadCleanups(modulePath: string): Promise<CleanupRegistry> {
  const registry = new CleanupRegistry();
  try {
    const mod = (await import(modulePath)) as Record<string, unknown>;
    const exported = (mod.cleanups ?? mod.default ?? mod) as Record<string, unknown>;
    for (const [stageName, fn] of Object.entries(exported)) {
      if (typeof fn === 'function') {
        registry.register(stageName, fn as CleanupFunction);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('Cannot find module')) throw err;
  }
  return registry;
}
