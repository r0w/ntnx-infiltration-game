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
}

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
