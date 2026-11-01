#!/usr/bin/env bun
/**
 * Stage dependency audit. Builds a producer/consumer graph of session
 * variables across a pack's stages and flags:
 *   - orphans: variables consumed by a stage's prose but never produced
 *     upstream (not by `<input/>`, not by a check capture, not seeded from
 *     env via initialVariables).
 *   - unrehydratable producers: stages whose captures come from user input
 *     rather than API queries — cutting them silently breaks downstream.
 *   - broken prerequisites: a `dependsOn` naming a stage the pack does not
 *     ship, or one played later — both make the /admin cascade silently wrong.
 *
 * Works on any pack: what it cannot read off the stage JSON (which variables a
 * check captures or consumes, which names to ignore) is declared per pack in
 * `packs/<id>/audit.json`, so a second game needs no edit here.
 *
 * Run from the repo root:
 *   bun tooling/audit-stage-deps.ts                      # every pack, human report
 *   bun tooling/audit-stage-deps.ts <pack>               # one pack
 *   bun tooling/audit-stage-deps.ts <pack> --json        # full graph as JSON
 *   bun tooling/audit-stage-deps.ts <pack> --apply       # write derived `needs`
 *                                                        # and `captures` fields
 *                                                        # into each stage JSON
 *   bun tooling/audit-stage-deps.ts --check              # every pack, non-zero on drift
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const PACKS_ROOT = resolve('packs');

type StageJson = {
  name?: string;
  messages: string[];
  captures?: string[];
  dependsOn?: string[];
  check?: { fn: string; rehydrate?: string };
};

/**
 * Per-pack knowledge the audit cannot derive from JSON, declared in
 * `packs/<id>/audit.json`. Every field is optional; a pack without the file
 * gets the prose-only graph, which is still worth running.
 */
interface AuditConfig {
  /** Variables present before the first stage (server config + boot module). */
  envSeeded?: string[];
  /** check fn → variables its `captured` return emits. */
  checkCaptures?: Record<string, string[]>;
  /** check fn → variables it reads via `ctx.vars.get()`, invisible in prose. */
  checkConsumes?: Record<string, string[]>;
  /** Substituted names that are not session variables and never will be. */
  ignoreVars?: string[];
  /**
   * Variables every stage after their producer consumes, whether or not the
   * prose substitutes them. The bootcamp's learner number scopes the entire
   * run, so each step gates on it — writing that once here beats repeating a
   * per-stage exception for every narrative page.
   */
  alwaysNeeds?: string[];
}

/** Everything the audit needs about one pack, resolved from disk. */
interface Pack {
  id: string;
  dir: string;
  stagesDir: string;
  localesDir: string;
  order: string[];
  cfg: AuditConfig;
  envSeeded: Set<string>;
  ignoreVars: Set<string>;
}

function loadPackContext(id: string): Pack {
  const dir = join(PACKS_ROOT, id);
  const manifest = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')) as {
    stages?: string[];
    stagesDir?: string;
    locales?: string;
    defaultLocale?: string;
  };
  let cfg: AuditConfig = {};
  try {
    cfg = JSON.parse(readFileSync(join(dir, 'audit.json'), 'utf8')) as AuditConfig;
  } catch {
    cfg = {};
  }
  return {
    id,
    dir,
    stagesDir: resolve(dir, manifest.stagesDir ?? './stages'),
    localesDir: resolve(dir, manifest.locales ?? './locales'),
    order: manifest.stages ?? [],
    cfg,
    envSeeded: new Set(cfg.envSeeded ?? []),
    ignoreVars: new Set(cfg.ignoreVars ?? []),
  };
}

function allPackIds(): string[] {
  return readdirSync(PACKS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      try {
        readFileSync(join(PACKS_ROOT, name, 'pack.json'), 'utf8');
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

interface Stage {
  id: number;
  name?: string;
  file: string;
  json: StageJson;
  consumes: string[];
  produces: string[];
  rehydratable: boolean;
}

function scanVarRefs(template: string): string[] {
  const out = new Set<string>();
  // `{Name}` tokens — the JSX-like message parser's variable substitution.
  for (const m of template.matchAll(/\{(\w+)\}/g)) out.add(m[1]);
  return [...out];
}

function scanInputVars(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/<input\s+var=['"](\w+)['"]\s*\/>/g)) out.push(m[1]);
  return out;
}

function loadCatalog(pack: Pack, locale: string): Record<string, string> {
  const path = join(pack.localesDir, `${locale}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

function loadStages(pack: Pack): Stage[] {
  const catalog = loadCatalog(pack, 'en');
  const checkCaptures = pack.cfg.checkCaptures ?? {};
  const checkConsumes = pack.cfg.checkConsumes ?? {};
  // Stage order lives in pack.json's `stages[]` (the JSON files' `id` is a
  // durable identity string, not a position). Derive each stage's numeric
  // position from the array — producer/consumer ordering and orphan
  // detection depend on it.
  const order = new Map<string, number>();
  pack.order.forEach((name, i) => order.set(name, i));
  const files = readdirSync(pack.stagesDir).filter((f) => f.endsWith('.json')).sort();
  const stages: Stage[] = [];
  for (const file of files) {
    const path = join(pack.stagesDir, file);
    const json = JSON.parse(readFileSync(path, 'utf8')) as StageJson;
    const id = order.get(json.name ?? file.replace(/\.json$/, ''));
    if (id === undefined) {
      console.warn(`warning: ${file} not listed in pack.json stages[] — skipped`);
      continue;
    }
    const consumes = new Set<string>();
    const produces = new Set<string>();
    for (const v of pack.cfg.alwaysNeeds ?? []) consumes.add(v);
    for (const key of json.messages) {
      const template = catalog[key];
      if (!template) continue;
      for (const v of scanVarRefs(template)) consumes.add(v);
      for (const v of scanInputVars(template)) produces.add(v);
    }
    // Produces derive from prose `<input/>` + the pack's declared check
    // captures only — seeding from the file's own `captures` made stale
    // captures self-perpetuating.
    if (json.check?.fn) {
      for (const v of checkCaptures[json.check.fn] ?? []) produces.add(v);
      for (const v of checkConsumes[json.check.fn] ?? []) consumes.add(v);
    }
    // "Rehydratable" means the stage can re-populate its produced vars
    // without user interaction — the engine runs check.fn (or check.rehydrate
    // if set) and the function re-queries the cluster to recover captures.
    // That only works when the check actually emits `captured` (tracked
    // via the pack's `checkCaptures`); stages that produce purely via `<input/>`
    // or whose check is input-validation only (CheckTrigram) aren't
    // rehydratable — replaying them needs the player's keystrokes.
    const fn = json.check?.fn;
    const rehydratable = !!fn && (checkCaptures[fn]?.length ?? 0) > 0;
    stages.push({
      id,
      name: json.name,
      file,
      json,
      consumes: [...consumes],
      produces: [...produces],
      rehydratable,
    });
  }
  // Pack order, not filename order — "first producer wins" and the
  // producer/consumer direction both depend on it.
  stages.sort((a, b) => a.id - b.id);
  return stages;
}

interface Report {
  stages: Stage[];
  /** producer-stage-id → var → stages that consume it. */
  graph: Record<string, { stageId: number; var: string; consumers: number[] }[]>;
  orphans: Array<{ var: string; consumedBy: number[] }>;
  producersWithoutRehydrate: Array<{ stageId: number; name?: string; produces: string[] }>;
  /** `dependsOn` entries that name a stage the pack cannot satisfy. */
  brokenPrereqs: Array<{ stage: string; dependsOn: string; reason: 'unknown' | 'later' }>;
}

function analyze(pack: Pack, stages: Stage[]): Report {
  // Build a consumed → producer map. First producer in stage order wins
  // (earliest stage that captures the var is the canonical source).
  const firstProducer = new Map<string, number>();
  for (const s of stages) {
    for (const v of s.produces) {
      if (!firstProducer.has(v)) firstProducer.set(v, s.id);
    }
  }

  const graph: Report['graph'] = {};
  const orphans: Report['orphans'] = [];
  const consumersByVar = new Map<string, number[]>();

  for (const s of stages) {
    for (const v of s.consumes) {
      if (pack.ignoreVars.has(v)) continue;
      const prev = consumersByVar.get(v) ?? [];
      prev.push(s.id);
      consumersByVar.set(v, prev);
    }
  }

  for (const [v, consumers] of consumersByVar) {
    if (pack.envSeeded.has(v)) continue;
    const producerId = firstProducer.get(v);
    if (producerId === undefined) {
      orphans.push({ var: v, consumedBy: consumers });
      continue;
    }
    const onlyDownstream = consumers.filter((c) => c > producerId);
    if (onlyDownstream.length === 0) continue;
    const key = String(producerId);
    graph[key] ??= [];
    graph[key].push({ stageId: producerId, var: v, consumers: onlyDownstream });
  }

  // Producers that carry downstream consumers but lack a rehydrate path.
  const producersWithoutRehydrate: Report['producersWithoutRehydrate'] = [];
  for (const s of stages) {
    if (s.rehydratable) continue;
    const downstreamVars = (graph[String(s.id)] ?? []).map((e) => e.var);
    if (downstreamVars.length === 0) continue;
    producersWithoutRehydrate.push({ stageId: s.id, name: s.name, produces: downstreamVars });
  }

  // `dependsOn` is what the /admin cascade walks, so a name it cannot resolve
  // is not a harmless typo: the analysis skips the entry and the operator is
  // told the stage is fine while the cluster state it needs is gone. A
  // prerequisite played *after* its dependant is the same lie, later.
  const brokenPrereqs: Report['brokenPrereqs'] = [];
  const byName = new Map(stages.map((s) => [s.name ?? '', s.id]));
  for (const s of stages) {
    for (const dep of s.json.dependsOn ?? []) {
      const depId = byName.get(dep);
      if (depId === undefined) {
        brokenPrereqs.push({ stage: s.name ?? s.file, dependsOn: dep, reason: 'unknown' });
      } else if (depId >= s.id) {
        brokenPrereqs.push({ stage: s.name ?? s.file, dependsOn: dep, reason: 'later' });
      }
    }
  }

  return { stages, graph, orphans, producersWithoutRehydrate, brokenPrereqs };
}

function printReport(pack: Pack, r: Report): void {
  console.log(`${pack.id} dependency audit — ${r.stages.length} stages`);
  console.log('');
  console.log(`producers with downstream consumers: ${Object.keys(r.graph).length}`);
  for (const [stageId, entries] of Object.entries(r.graph)) {
    const s = r.stages.find((x) => x.id === Number.parseInt(stageId, 10));
    const label = s ? `${stageId} (${s.name ?? '?'})` : stageId;
    for (const e of entries) {
      console.log(`  ${label} → ${e.var} → consumed by stages ${e.consumers.join(', ')}`);
    }
  }
  console.log('');

  console.log(`orphan variables (consumed but never produced): ${r.orphans.length}`);
  for (const o of r.orphans) {
    console.log(`  ${o.var} — consumed by stages ${o.consumedBy.join(', ')}`);
  }
  console.log('');

  console.log(`producers WITHOUT check.rehydrate (risk if skipped): ${r.producersWithoutRehydrate.length}`);
  for (const p of r.producersWithoutRehydrate) {
    console.log(`  stage ${p.stageId} (${p.name ?? '?'}) → produces ${p.produces.join(', ')}`);
  }
  console.log('');

  console.log(`unsatisfiable dependsOn: ${r.brokenPrereqs.length}`);
  for (const b of r.brokenPrereqs) {
    const why = b.reason === 'unknown' ? 'no such stage' : 'played later';
    console.log(`  ${b.stage} → dependsOn '${b.dependsOn}' — ${why}`);
  }
}

/**
 * Write `needs` and `captures` back into each stage JSON based on the
 * derived graph. `needs` = vars the stage consumes that aren't produced by
 * itself, aren't seeded from env, and aren't in the ignore list. `captures`
 * = vars the stage produces (from `<input/>` + check captures). Empty
 * arrays are omitted to keep the JSON terse.
 * `write=false` = dry-run (--check): report drift without touching files.
 */
function applyMode(pack: Pack, stages: Stage[], write: boolean): number {
  const allProducers = new Set<string>();
  const firstProducer = new Map<string, number>();
  for (const s of stages) {
    for (const v of s.produces) {
      allProducers.add(v);
      if (!firstProducer.has(v)) firstProducer.set(v, s.id);
    }
  }

  let updated = 0;
  for (const s of stages) {
    const selfProduced = new Set(s.produces);
    const needs = s.consumes
      // A re-capturer (live-migrate-vm reads then rewrites HostUUID) still
      // needs the origin stage; only the origin drops the var from needs.
      .filter((v) => !(selfProduced.has(v) && firstProducer.get(v) === s.id))
      .filter((v) => !pack.envSeeded.has(v))
      .filter((v) => !pack.ignoreVars.has(v))
      // Only declare needs for vars we actually know are produced somewhere
      // — avoids cluttering with placeholders whose producer doesn't exist.
      .filter((v) => allProducers.has(v))
      .sort();
    const captures = [...s.produces].sort();

    const file = join(pack.stagesDir, s.file);
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    let changed = false;
    if (needs.length > 0) {
      const current = Array.isArray(json.needs) ? json.needs : [];
      if (JSON.stringify(current) !== JSON.stringify(needs)) {
        json.needs = needs;
        changed = true;
      }
    } else if (json.needs !== undefined) {
      delete json.needs;
      changed = true;
    }
    if (captures.length > 0) {
      const current = Array.isArray(json.captures) ? json.captures : [];
      if (JSON.stringify(current) !== JSON.stringify(captures)) {
        json.captures = captures;
        changed = true;
      }
    } else if (json.captures !== undefined) {
      delete json.captures;
      changed = true;
    }
    if (changed) {
      if (write) writeFileSync(file, JSON.stringify(reorderStage(json), null, 2) + '\n', 'utf8');
      updated++;
      console.log(
        `${s.file}: needs=[${needs.join(',')}] captures=[${captures.join(',')}]`,
      );
    }
  }
  console.log(`\n${write ? 'updated' : 'would update'} ${updated} stage file(s).`);
  return updated;
}

/**
 * Stable field order matching the existing stage JSON convention so diffs
 * stay small and reviewable. Unknown fields are appended at the end.
 */
function reorderStage(s: Record<string, unknown>): Record<string, unknown> {
  const ORDER = [
    'id',
    'name',
    'active',
    'requires',
    'impact',
    'prompt',
    'defaultColor',
    'messages',
    'requiresOnOther',
    'typingSpeedMs',
    'silentOnSuccess',
    'waitForInputValue',
    'check',
    'captures',
    'needs',
    'dependsOn',
  ];
  const out: Record<string, unknown> = {};
  for (const k of ORDER) if (s[k] !== undefined) out[k] = s[k];
  for (const k of Object.keys(s)) if (!(k in out)) out[k] = s[k];
  return out;
}

function auditPack(id: string, mode: 'report' | 'json' | 'apply' | 'check'): number {
  const pack = loadPackContext(id);
  const stages = loadStages(pack);
  const report = analyze(pack, stages);

  if (mode === 'apply') return applyMode(pack, stages, true);
  if (mode === 'json') {
    console.log(JSON.stringify({ pack: id, ...report }, null, 2));
    return 0;
  }
  if (mode === 'check') {
    const drift = applyMode(pack, stages, false);
    for (const b of report.brokenPrereqs) {
      const why = b.reason === 'unknown' ? 'no such stage' : 'played later';
      console.error(`${id}: ${b.stage} → dependsOn '${b.dependsOn}' — ${why}`);
    }
    return drift + report.brokenPrereqs.length;
  }
  printReport(pack, report);
  return report.brokenPrereqs.length;
}

function main(): void {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const named = argv.filter((a) => !a.startsWith('--'));
  const mode = flags.has('--apply')
    ? 'apply'
    : flags.has('--check')
      ? 'check'
      : flags.has('--json')
        ? 'json'
        : 'report';

  // `--apply` rewrites files, so it must name the pack it rewrites. Everything
  // else defaults to every pack in the repo: an audit you have to remember to
  // re-run per pack is one that stops covering the pack added after it.
  const ids = named.length > 0 ? named : allPackIds();
  if (mode === 'apply' && ids.length !== 1) {
    console.error('--apply needs exactly one pack id, e.g. `--apply ntnx-infiltration`');
    process.exit(2);
  }

  let problems = 0;
  for (const id of ids) {
    if (ids.length > 1 && mode === 'report') console.log('');
    problems += auditPack(id, mode);
  }
  if (mode === 'check' && problems > 0) {
    console.error(`${problems} problem(s) — run --apply for stage-field drift`);
    process.exit(1);
  }
}

main();
