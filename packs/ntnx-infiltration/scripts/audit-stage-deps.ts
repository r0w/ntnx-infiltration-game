#!/usr/bin/env bun
/**
 * Stage dependency audit. Builds a producer/consumer graph of session
 * variables across the ntnx-infiltration stages and flags:
 *   - orphans: variables consumed by a stage's prose but never produced
 *     upstream (not by `<input/>`, not by a check capture, not seeded from
 *     env via initialVariables).
 *   - unrehydratable producers: stages whose captures come from user input
 *     rather than API queries — cutting them silently breaks downstream.
 *
 * Run from the repo root:
 *   bun packs/ntnx-infiltration/scripts/audit-stage-deps.ts             # human report
 *   bun packs/ntnx-infiltration/scripts/audit-stage-deps.ts --json      # full graph as JSON
 *   bun packs/ntnx-infiltration/scripts/audit-stage-deps.ts --apply     # write derived `needs`
 *                                                                        # and `captures` fields
 *                                                                        # into each stage JSON
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const PACK_DIR = resolve('packs/ntnx-infiltration');
const STAGES_DIR = join(PACK_DIR, 'stages');
const LOCALES_DIR = join(PACK_DIR, 'locales');

type StageJson = {
  name?: string;
  messages: string[];
  captures?: string[];
  check?: { fn: string; rehydrate?: string };
};

// Variables seeded from env via SessionService.initialVariables (see
// packages/server/src/index.ts). Treated as always-available producers.
const ENV_SEEDED = new Set(['PC', 'PCUser', 'PCPassword', 'Vlanid', 'ImageURL']);

// Known check → captured variable names. Derived from reading
// packs/ntnx-infiltration/checks/index.ts — each check's `captured` return.
// Kept as explicit mapping so the audit doesn't parse TypeScript.
// Since issue #31 checks resolve entities by name; only historical state
// is captured (HostUUID: previous host, VMUUID: recovery point + incident).
const CHECK_CAPTURES: Record<string, string[]> = {
  CheckVM: ['VMUUID', 'HostUUID'],
  CheckLiveMigration: ['HostUUID'],
  CheckRestoreVM: ['VMUUID'],
};

// Known check → consumed variable names. These are dependencies the check
// code reads via `ctx.vars.get(...)` and aren't visible in the message
// templates. Without this mapping the audit would miss silent couplings
// (e.g. CheckLiveMigration fails unless CheckVM populated HostUUID first).
const CHECK_CONSUMES: Record<string, string[]> = {
  // Stage-1 trigram is consumed implicitly by every name-based check via
  // getTrigram(ctx) — covered by the `{Trigram}` tokens in prose already.
  CheckLiveMigration: ['HostUUID'],
  CheckUpdateBP: ['Vlanid'],
  CheckNewNode: ['NodeSerial'],
  CheckUpdates: ['NumberUpdates'],
  CheckRunway: ['Runway'],
};

// Variables that aren't referenced in prose but still useful to allow-list
// (e.g. set indirectly or read by frontend only).
const IGNORE_VARS = new Set([
  // Computed at runtime by login's `computeGreeting` block, not a capture.
  'Greeting',
  // Legacy / game-content placeholders not actually bound to anything yet.
  'EmailReport',
  'OldPC',
  'OldPCUsername',
  'OldPCPassword',
  'ProdUsername',
  'ProdPassword',
  'frontendHost',
  'frontendPort',
  'SupportedLanguages',
  // Engine internal — $continue is the press-enter-to-continue sentinel,
  // never substituted.
  '$continue',
]);

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

function loadCatalog(locale: string): Record<string, string> {
  const path = join(LOCALES_DIR, `${locale}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

function loadStages(): Stage[] {
  const catalog = loadCatalog('en');
  // Stage order lives in pack.json's `stages[]` (the JSON files carry no id).
  // Derive each stage's id from its position there — producer/consumer
  // ordering and orphan detection depend on it.
  const pack = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as {
    stages?: string[];
  };
  const order = new Map<string, number>();
  (pack.stages ?? []).forEach((name, i) => order.set(name, i));
  const files = readdirSync(STAGES_DIR).filter((f) => f.endsWith('.json')).sort();
  const stages: Stage[] = [];
  for (const file of files) {
    const path = join(STAGES_DIR, file);
    const json = JSON.parse(readFileSync(path, 'utf8')) as StageJson;
    const id = order.get(json.name ?? file.replace(/\.json$/, ''));
    if (id === undefined) {
      console.warn(`warning: ${file} not listed in pack.json stages[] — skipped`);
      continue;
    }
    const consumes = new Set<string>();
    const produces = new Set<string>();
    for (const key of json.messages) {
      const template = catalog[key];
      if (!template) continue;
      for (const v of scanVarRefs(template)) consumes.add(v);
      for (const v of scanInputVars(template)) produces.add(v);
    }
    // Produces derive from prose `<input/>` + CHECK_CAPTURES only — seeding
    // from the file's own `captures` made stale captures self-perpetuating.
    if (json.check?.fn) {
      for (const v of CHECK_CAPTURES[json.check.fn] ?? []) produces.add(v);
      for (const v of CHECK_CONSUMES[json.check.fn] ?? []) consumes.add(v);
    }
    // "Rehydratable" means the stage can re-populate its produced vars
    // without user interaction — the engine runs check.fn (or check.rehydrate
    // if set) and the function re-queries the cluster to recover captures.
    // That only works when the check actually emits `captured` (tracked
    // via CHECK_CAPTURES above); stages that produce purely via `<input/>`
    // or whose check is input-validation only (CheckTrigram) aren't
    // rehydratable — replaying them needs the player's keystrokes.
    const fn = json.check?.fn;
    const rehydratable = !!fn && (CHECK_CAPTURES[fn]?.length ?? 0) > 0;
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
}

function analyze(stages: Stage[]): Report {
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
      if (IGNORE_VARS.has(v)) continue;
      const prev = consumersByVar.get(v) ?? [];
      prev.push(s.id);
      consumersByVar.set(v, prev);
    }
  }

  for (const [v, consumers] of consumersByVar) {
    if (ENV_SEEDED.has(v)) continue;
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

  return { stages, graph, orphans, producersWithoutRehydrate };
}

function printReport(r: Report): void {
  console.log(`ntnx-infiltration dependency audit — ${r.stages.length} stages`);
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
}

/**
 * Write `needs` and `captures` back into each stage JSON based on the
 * derived graph. `needs` = vars the stage consumes that aren't produced by
 * itself, aren't seeded from env, and aren't in the ignore list. `captures`
 * = vars the stage produces (from `<input/>` + check captures). Empty
 * arrays are omitted to keep the JSON terse.
 */
function applyMode(stages: Stage[]): void {
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
      .filter((v) => !ENV_SEEDED.has(v))
      .filter((v) => !IGNORE_VARS.has(v))
      // Only declare needs for vars we actually know are produced somewhere
      // — avoids cluttering with placeholders whose producer doesn't exist.
      .filter((v) => allProducers.has(v))
      .sort();
    const captures = [...s.produces].sort();

    const file = join(STAGES_DIR, s.file);
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
      writeFileSync(file, JSON.stringify(reorderStage(json), null, 2) + '\n', 'utf8');
      updated++;
      console.log(
        `${s.file}: needs=[${needs.join(',')}] captures=[${captures.join(',')}]`,
      );
    }
  }
  console.log(`\nupdated ${updated} stage file(s).`);
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
    'saveScore',
    'requiresOnOther',
    'typingSpeedMs',
    'silentOnSuccess',
    'waitForInputValue',
    'check',
    'captures',
    'needs',
  ];
  const out: Record<string, unknown> = {};
  for (const k of ORDER) if (s[k] !== undefined) out[k] = s[k];
  for (const k of Object.keys(s)) if (!(k in out)) out[k] = s[k];
  return out;
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const stages = loadStages();
  const report = analyze(stages);
  if (args.has('--apply')) {
    applyMode(stages);
    return;
  }
  if (args.has('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

main();
