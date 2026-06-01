import type { MessageUnit } from '@ntnx-game/shared';
import { parseMessage } from './message-parser';
import { nextPlayableStage, type NextStageResult, type VarsLookup } from './capability-gate';
import { resolveKey, type ResolveOptions } from './locale-catalog';
import type {
  CheckContext,
  CheckResult,
  GameSession,
  Locale,
  LocaleBundle,
  Logger,
  StageDefinition,
  Variables,
} from './types';
import { CheckRegistry } from './check-registry';

export interface RenderedStage {
  /** Positional index of the rendered stage in the pack order. */
  stageId: number;
  /** Canonical stage name — what payloads to the frontend/DB carry. */
  stageName: string;
  units: MessageUnit[];
  actions: string[];
  /** Index of the first await-input unit, or -1 if none. */
  firstAwaitInputIdx: number;
  needsCheck: boolean;
  typingSpeedMs?: number;
}

export interface StageRunnerOptions {
  /** Logger used to warn about missing translation keys at render time. */
  logger?: Logger;
}

export class StageRunner {
  private readonly logger?: Logger;
  private stages: readonly StageDefinition[];

  constructor(
    stages: readonly StageDefinition[],
    private readonly checks: CheckRegistry,
    opts: StageRunnerOptions = {},
  ) {
    this.stages = stages;
    this.logger = opts.logger;
  }

  listStages(): readonly StageDefinition[] {
    return this.stages;
  }

  /**
   * Swap the runner's stage list — used by SessionService when an admin
   * overlay (active/adminGate overrides) shifts the effective pack at
   * runtime. The CheckRegistry is preserved; only the stage definitions
   * change, so functions referenced by `stage.check.fn` stay resolved.
   */
  replaceStages(stages: readonly StageDefinition[]): void {
    this.stages = stages;
  }

  nextStage(
    session: Pick<GameSession, 'capabilities' | 'clusterProfile' | 'currentStage'> & {
      gateUnlocks?: ReadonlySet<number>;
    },
    vars?: VarsLookup,
  ): NextStageResult | null {
    return nextPlayableStage(this.stages, session, vars);
  }

  stageById(id: number): StageDefinition | undefined {
    return this.stages.find((s) => s.id === id);
  }

  /** Canonical identity lookup — prefer this over stageById in new code. */
  stageByName(name: string): StageDefinition | undefined {
    return this.stages.find((s) => s.name === name);
  }

  render(
    stage: StageDefinition,
    vars: Variables,
    locale: Locale,
    bundle: LocaleBundle,
    globalTypingSpeedMs?: number,
  ): RenderedStage {
    const rawUnits: MessageUnit[] = [];
    const actions: string[] = [];
    const defaultColor = stage.defaultColor ?? 'default';
    const resolveOpts: ResolveOptions = {
      onMissing: (key, loc) =>
        this.logger?.warn('missing translation key', { key, locale: loc, stageId: stage.id }),
    };

    for (const key of stage.messages) {
      const template = resolveKey(key, locale, bundle, resolveOpts);
      const parsed = parseMessage(template, vars, defaultColor);
      for (const u of parsed.units) rawUnits.push(u);
      for (const a of parsed.actions) actions.push(a);
      // One newline per message so lines render individually and stages stay
      // visually separated. Skip it if the message already ended with a
      // newline — legacy content has plenty of trailing "\n"/"\n\n", so an
      // unconditional add doubles the spacing.
      const last = rawUnits[rawUnits.length - 1];
      const alreadyEndsWithNewline = last && last.kind === 'text' && last.text.endsWith('\n');
      if (!alreadyEndsWithNewline) {
        rawUnits.push({ kind: 'text', text: '\n', color: defaultColor });
      }
    }

    const units = stage.prompt ? injectSpeakerTag(rawUnits, stage.prompt) : rawUnits;
    let firstAwaitInputIdx = -1;
    for (let i = 0; i < units.length; i++) {
      if (units[i].kind === 'await-input') {
        firstAwaitInputIdx = i;
        break;
      }
    }

    return {
      stageId: stage.id,
      stageName: stage.name,
      units,
      actions,
      firstAwaitInputIdx,
      needsCheck: !!stage.check,
      typingSpeedMs: stage.typingSpeedMs ?? globalTypingSpeedMs,
    };
  }

  /**
   * Find the index of the first await-input unit at or after {@link fromIdx}.
   * Returns -1 if none.
   */
  nextAwaitInputAfter(units: readonly MessageUnit[], fromIdx: number): number {
    for (let i = fromIdx; i < units.length; i++) {
      if (units[i].kind === 'await-input') return i;
    }
    return -1;
  }

  /**
   * Find the index of the first await-input unit matching `variable`.
   * Used by the check-fail rewind path (see
   * `CheckResult.retryFromVariable`). Returns -1 when no such input exists
   * in the rendered stage.
   */
  firstAwaitInputFor(units: readonly MessageUnit[], variable: string): number {
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.kind === 'await-input' && u.variable === variable) return i;
    }
    return -1;
  }

  async runCheck(stage: StageDefinition, ctx: CheckContext): Promise<CheckResult> {
    if (!stage.check) return { pass: true };
    const fn = this.checks.get(stage.check.fn);
    return fn({ ...ctx, args: stage.check.args ?? {} });
  }

  async rehydrate(stage: StageDefinition, ctx: CheckContext): Promise<CheckResult> {
    if (!stage.check) return { pass: true };
    const fnName = stage.check.rehydrate ?? stage.check.fn;
    const fn = this.checks.get(fnName);
    return fn({ ...ctx, args: stage.check.args ?? {} });
  }
}

/**
 * Inject a `<speaker> ` label at the start of every "chat beat" in the
 * rendered unit stream. A beat starts at stage entry, after a `<clear/>`,
 * and after any `\n\n` gap inside a text unit — matching the cadence of the
 * legacy Python per-beat `<speaker> ` prefix without relying on per-line
 * emission (which would clutter list items and slow typing).
 */
function injectSpeakerTag(units: readonly MessageUnit[], speaker: string): MessageUnit[] {
  const tag: MessageUnit = { kind: 'text', text: `<${speaker}> `, color: 'dim' };
  const out: MessageUnit[] = [];
  let pendingTag = true;
  for (const u of units) {
    if (u.kind === 'clear' || u.kind === 'page-break') {
      out.push(u);
      pendingTag = true;
      continue;
    }
    if (u.kind !== 'text') {
      out.push(u);
      continue;
    }
    const segments = u.text.split(/(\n{2,})/);
    for (const seg of segments) {
      if (seg.length === 0) continue;
      const isBlankSep = /^\n{2,}$/.test(seg);
      // Preserve any href the parser attached to `u` — earlier versions
      // rebuilt the text unit from color/styles only, which silently dropped
      // `<a href='...'>` spans back to plain text by the time the frontend
      // received them.
      const { text: _t, ...rest } = u;
      if (isBlankSep) {
        out.push({ ...rest, kind: 'text', text: seg });
        pendingTag = true;
      } else {
        if (pendingTag && seg.trim().length > 0) {
          out.push({ ...tag });
          pendingTag = false;
        }
        out.push({ ...rest, kind: 'text', text: seg });
      }
    }
  }
  return out;
}
