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

export interface PackManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
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
    wip: manifest.wipLocales ?? [],
    catalogs,
  };
}

function emptyBundleFromManifest(manifest: PackManifest): LocaleBundle {
  const catalogs: Record<Locale, LocaleCatalog> = {};
  for (const locale of manifest.supportedLocales) catalogs[locale] = {};
  return {
    defaultLocale: manifest.defaultLocale,
    supported: manifest.supportedLocales,
    wip: manifest.wipLocales ?? [],
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
