export type MessageUnit =
  | { kind: 'text'; text: string; color?: string; styles?: string[]; href?: string }
  | { kind: 'pause'; ms: number }
  | { kind: 'await-input'; variable: string }
  | { kind: 'clear' }
  | { kind: 'page-break' }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'image'; src: string; alt?: string };

export type StageStreamEvent =
  | { type: 'stage-start'; stageName: string; typingSpeedMs?: number }
  | { type: 'units'; stageName: string; units: MessageUnit[] }
  | { type: 'stage-end'; stageName: string; pass: boolean; detail?: string }
  | { type: 'session-finished'; finalStage: string | null }
  | { type: 'error'; error: string };

export interface CreateSessionRequest {
  locale?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  /** `null` = pre-game, before the first stage runs. */
  currentStage: string | null;
  clusterProfile: 'hpoc' | 'other';
  capabilities: string[];
  help?: HelpSnapshot;
}

/** Longest step-by-step help penalty an operator can set, in seconds (1 hour). */
export const HELP_PENALTY_MAX_SEC = 3600;

/** Step-by-step help state of a session, carried on the session snapshot. */
export interface HelpSnapshot {
  /** Effective flag: the player's override if set, else the global flag. */
  enabled: boolean;
  /** Stages whose help was already displayed (free to show again). */
  usedStages: string[];
}

/**
 * Answer to `POST /api/session/:id/help`. `confirm-required`: the first
 * display of this stage's help costs `penaltySec` and the player has not
 * confirmed yet (nothing was recorded). `ok`: the rendered help units;
 * `charged` is true when this call recorded the first display.
 */
export type HelpResponse =
  | { status: 'confirm-required'; stageName: string; penaltySec: number }
  | { status: 'ok'; stageName: string; units: MessageUnit[]; penaltySec: number; charged: boolean };

export interface SubmitInputRequest {
  variable: string;
  value: string;
}

/**
 * A stage the runner skipped when picking the next playable stage. The three
 * reasons map 1:1 to the GateVerdict values that `capability-gate` treats as
 * "skip, record, move on" (inactive stages and already-passed stages are not
 * surfaced to the client). `name` is the canonical stage identity
 * (`pack.json.stages[i]`).
 */
export type DisabledStage =
  | { name: string; reason: 'missing-capability'; missing: string[] }
  | { name: string; reason: 'destructive-on-other' }
  | { name: string; reason: 'missing-upstream'; missingVars: string[] };
