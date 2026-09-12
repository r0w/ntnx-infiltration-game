import type { StageDefinition } from '@ntnx-game/engine';

/**
 * Variables seeded from env via SessionService.initialVariables. They count
 * as always-available producers — disabling a stage that depends only on
 * env-seeded values doesn't break anything downstream.
 */
const ENV_SEEDED = new Set(['PC', 'PCUser', 'PCPassword', 'Vlanid', 'ImageURL', 'SecondaryNetwork']);

export interface DepAnalysisInput {
  /** All stages in the pack (effective overlay applied — `active`/`adminGate`
   *  reflect the current state). */
  stages: readonly StageDefinition[];
  /**
   * Stage names the operator wants to consider DISABLED on top of whatever the
   * effective stages already say. Lets the UI ask "if I were to also turn
   * off stage X, what else would break?" without first having to mutate the
   * overlay. The function unions this with stages where `active === false`.
   */
  disabledNames?: ReadonlySet<string>;
  /**
   * Stage names that are unreachable for non-disabled reasons — typically the
   * capability-disabled set computed elsewhere (e.g. a cluster lacking NCM
   * → CheckUpdates, CheckRunway, CheckPlaybook... can't run, so anything
   * needing the vars they capture should be flagged broken).
   */
  unreachableNames?: ReadonlySet<string>;
}

export interface BrokenStage {
  stageName: string;
  /** Variables the stage `needs` that no remaining producer can supply. */
  missingVars: string[];
  /** Required resource-producing stages that are unavailable. */
  missingStages?: string[];
}

export interface DepAnalysisResult {
  /** Producers (stage_name → vars they capture) actually live in the analysis. */
  producers: Map<string, string[]>;
  /** Stages that became unsatisfiable after applying disabledNames + unreachableNames. */
  broken: BrokenStage[];
  /** Set of stage names that are effectively off — disabled OR unreachable. */
  off: Set<string>;
}

function stageProduces(stage: StageDefinition): string[] {
  // The `captures` field on StageDefinition was populated by the 9f audit
  // and is the canonical producer list (covers both <input/> capture and
  // check-fn captured returns). No need to re-parse messages or inspect
  // checks here — trust the field.
  return stage.captures ?? [];
}

/**
 * Compute the broken-downstream picture for a hypothetical or actual change
 * to the effective stage list. Variables consumed by a stage's `needs` field
 * are matched against available producers (and ENV_SEEDED). Explicit
 * dependsOn links also propagate unavailable resources through the graph.
 *
 * "Off" combines `active === false` (operator-disabled), the explicit
 * `disabledNames` argument (preview a hypothetical disable), and
 * `unreachableNames` (capability/profile-locked stages whose captures are
 * never going to materialize on this cluster).
 */
export function analyzeDeps(input: DepAnalysisInput): DepAnalysisResult {
  const off = new Set<string>();
  for (const s of input.stages) if (!s.active) off.add(s.name);
  for (const n of input.disabledNames ?? []) off.add(n);
  for (const n of input.unreachableNames ?? []) off.add(n);

  // Keep declared producers available for dependency diagnostics.
  const producers = new Map<string, string[]>();
  for (const s of input.stages) {
    const captures = stageProduces(s);
    if (captures.length > 0) producers.set(s.name, captures);
  }

  const broken: BrokenStage[] = [];
  const unavailable = new Set(off);
  const names = new Set(input.stages.map((s) => s.name));
  // Broken stages cannot supply resources or variables to later stages.
  let changed = true;
  while (changed) {
    changed = false;
    const availableVars = new Set<string>();
    for (const s of input.stages) {
      if (!unavailable.has(s.name)) {
        for (const v of stageProduces(s)) availableVars.add(v);
      }
    }
    for (const s of input.stages) {
      if (unavailable.has(s.name)) continue;
      const missingVars = (s.needs ?? []).filter(
        (v) => !ENV_SEEDED.has(v) && !availableVars.has(v),
      );
      const missingStages = (s.dependsOn ?? []).filter(
        (name) => !names.has(name) || unavailable.has(name),
      );
      if (missingVars.length === 0 && missingStages.length === 0) continue;
      broken.push({ stageName: s.name, missingVars, ...(missingStages.length ? { missingStages } : {}) });
      unavailable.add(s.name);
      changed = true;
    }
  }
  const order = new Map(input.stages.map((s, i) => [s.name, i]));
  broken.sort((a, b) => order.get(a.stageName)! - order.get(b.stageName)!);

  return { producers, broken, off };
}

/**
 * Compute the cascade closure of disabling a set of stages: which OTHER
 * stages would become broken (no surviving producer for one of their
 * `needs`) if these stages were turned off. Iterates to a fixed point —
 * disabling stage A may break B, and B's captures may break C, etc.
 *
 * Returns:
 *  - `disabled`: the full set after closure (initial + collateral).
 *  - `cascade`: the collateral broken stages, in the order they were first
 *    flagged. Each appears with the missing-vars list at the moment of
 *    its inclusion (i.e. WHY it became broken). Excludes `initialDisabled`
 *    — those are the operator's choice, not collateral.
 */
export function cascadeDisable(
  stages: readonly StageDefinition[],
  initialDisabled: ReadonlySet<string>,
  unreachableNames?: ReadonlySet<string>,
): { disabled: Set<string>; cascade: BrokenStage[] } {
  const disabled = new Set(initialDisabled);
  const cascade: BrokenStage[] = [];
  const cascadeSeen = new Set<string>();
  let prevSize = -1;
  while (disabled.size !== prevSize) {
    prevSize = disabled.size;
    const r = analyzeDeps({ stages, disabledNames: disabled, unreachableNames });
    for (const b of r.broken) {
      disabled.add(b.stageName);
      if (!cascadeSeen.has(b.stageName) && !initialDisabled.has(b.stageName)) {
        cascadeSeen.add(b.stageName);
        cascade.push(b);
      }
    }
  }
  return { disabled, cascade };
}
