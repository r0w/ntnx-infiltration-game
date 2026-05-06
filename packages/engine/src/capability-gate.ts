import type { CapabilityFlag, GameSession, StageDefinition } from './types';

export type GateVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'inactive'
        | 'already-passed'
        | 'missing-capability'
        | 'destructive-on-other'
        | 'missing-upstream'
        | 'gated';
      /** Missing capabilities when reason === 'missing-capability'. */
      missing?: CapabilityFlag[];
      /** Missing upstream variables when reason === 'missing-upstream'. */
      missingVars?: string[];
    };

export type SessionGateInput = Pick<
  GameSession,
  'capabilities' | 'clusterProfile' | 'currentStage'
> & {
  /**
   * Stage IDs explicitly unlocked by an admin. A stage with `adminGate: true`
   * stays gated unless its id is in this set. Optional so call sites that
   * predate adminGate keep type-checking with no behavior change.
   */
  gateUnlocks?: ReadonlySet<number>;
};

/**
 * Signature for the vars lookup the gate needs when a stage declares `needs`.
 * Kept minimal (no full Variables interface) so capability-gate stays pure
 * and testable without a DB-backed vars store.
 */
export type VarsLookup = {
  has(name: string): boolean;
};

export function gateStage(
  stage: StageDefinition,
  session: SessionGateInput,
  vars?: VarsLookup,
): GateVerdict {
  if (!stage.active) return { allowed: false, reason: 'inactive' };
  if (stage.id <= session.currentStage) return { allowed: false, reason: 'already-passed' };
  const missing = (stage.requires ?? []).filter((c) => !session.capabilities.has(c));
  if (missing.length > 0) return { allowed: false, reason: 'missing-capability', missing };
  if (stage.impact === 'destructive' && session.clusterProfile === 'other') {
    return { allowed: false, reason: 'destructive-on-other' };
  }
  if (vars && stage.needs && stage.needs.length > 0) {
    const missingVars = stage.needs.filter((name) => !vars.has(name));
    if (missingVars.length > 0) {
      return { allowed: false, reason: 'missing-upstream', missingVars };
    }
  }
  // Admin gate is the LAST verdict so capability/data problems still surface
  // first — no point opening a gate just to immediately fail the stage.
  if (stage.adminGate && !(session.gateUnlocks?.has(stage.id) ?? false)) {
    return { allowed: false, reason: 'gated' };
  }
  return { allowed: true };
}

/**
 * Subset of GateVerdict the runner surfaces to callers when it decides to
 * skip a stage. `inactive`, `already-passed`, and `gated` are not in here:
 * `inactive`/`already-passed` are internal bookkeeping reasons that shouldn't
 * propagate, and `gated` is a wait-state surfaced separately on the result
 * (callers must NOT skip past a gated stage).
 */
export type SkippedVerdict =
  | { reason: 'missing-capability'; missing: CapabilityFlag[] }
  | { reason: 'destructive-on-other' }
  | { reason: 'missing-upstream'; missingVars: string[] };

export interface SkippedStage {
  stage: StageDefinition;
  verdict: SkippedVerdict;
}

/**
 * Discriminated outcome of `nextPlayableStage`. `playable` = stage can be
 * rendered. `gated` = the next stage exists but is admin-gated; callers
 * should park the session and surface the wait. `null` (returned in the
 * outer Result type) = no more stages → session finished.
 */
export type NextStageResult =
  | { kind: 'playable'; next: StageDefinition; skippedDisabled: SkippedStage[] }
  | { kind: 'gated'; stage: StageDefinition; skippedDisabled: SkippedStage[] };

export function nextPlayableStage(
  stages: readonly StageDefinition[],
  session: SessionGateInput,
  vars?: VarsLookup,
): NextStageResult | null {
  const sorted = [...stages].sort((a, b) => a.id - b.id);
  const skippedDisabled: SkippedStage[] = [];
  for (const stage of sorted) {
    if (stage.id <= session.currentStage) continue;
    const verdict = gateStage(stage, session, vars);
    if (verdict.allowed) return { kind: 'playable', next: stage, skippedDisabled };
    if (verdict.reason === 'gated') {
      // Hard stop — the player waits at the gate, downstream stages stay
      // untouched (we don't peek past it). Skipped-disabled accumulated up to
      // here is still useful for the UI to display reasons.
      return { kind: 'gated', stage, skippedDisabled };
    }
    if (verdict.reason === 'missing-capability') {
      skippedDisabled.push({
        stage,
        verdict: { reason: 'missing-capability', missing: verdict.missing ?? [] },
      });
      continue;
    }
    if (verdict.reason === 'destructive-on-other') {
      skippedDisabled.push({ stage, verdict: { reason: 'destructive-on-other' } });
      continue;
    }
    if (verdict.reason === 'missing-upstream') {
      skippedDisabled.push({
        stage,
        verdict: { reason: 'missing-upstream', missingVars: verdict.missingVars ?? [] },
      });
      continue;
    }
    if (verdict.reason === 'inactive') {
      continue;
    }
  }
  return null;
}
