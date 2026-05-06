import type { Database } from 'bun:sqlite';
import type {
  ActionContext,
  CapabilityFlag,
  ActContext,
  ActFunction,
  CheckContext,
  ClusterProfile,
  Locale,
  LocaleBundle,
  Logger,
  NutanixClient,
  SessionDirectory,
  StageDefinition,
} from '@ntnx-game/engine';
import { ActionRegistry, StageRunner, resolveKey } from '@ntnx-game/engine';
import { withMockOverlay, withVariableInterpolation } from '@ntnx-game/nutanix';
import type { DisabledStage, MessageUnit } from '@ntnx-game/shared';
import {
  ClusterCacheQueries,
  ClusterConfigQueries,
  GateUnlockQueries,
  HistoryQueries,
  MockOverlayQueries,
  PackOverlayQueries,
  PackPauseQueries,
  SessionQueries,
  VariableQueries,
  type SessionRecord,
} from './db/queries';
import { applyOverlay } from './pack-overlay';
import {
  clusterCacheForSession,
  mockOverlayForSession,
  variablesForSession,
} from './runtime';

export interface SessionServiceDeps {
  db: Database;
  runner: StageRunner;
  nutanix: NutanixClient;
  actions?: ActionRegistry;
  logger: Logger;
  packId: string;
  bundle: LocaleBundle;
  globalTypingSpeedMs?: number;
  initialVariables?: Record<string, unknown>;
}

export interface AdvanceResult {
  kind: 'units' | 'finished' | 'awaiting-input' | 'switch-session' | 'gated';
  /** Canonical stage name; present on unit/awaiting/gated(stage) results. */
  stageName?: string;
  units: MessageUnit[];
  awaitingVariable?: string;
  /**
   * Discriminator on `kind === 'gated'`: 'stage' = a per-stage adminGate
   * blocked the next stage; 'global' = pack-wide pause (lunch lock, etc.)
   * fired by the operator and unrelated to which stage is next. The
   * frontend swaps the banner copy/icon based on this value.
   */
  gatedReason?: 'stage' | 'global';
  /**
   * Set when `kind === 'switch-session'` — the sessionId the client should
   * swap its localStorage pointer to. Triggered by `CheckResult.switchTo`
   * (returning-agent re-auth path in `CheckTrigram`). The current session
   * has already been deleted server-side by the time this response fires.
   */
  switchSessionId?: string;
  actions: string[];
  check?: {
    pass: boolean;
    detail?: string;
    /** Player-facing one-liner for fail cases (anti-spoiler category hint). */
    hint?: string;
    cheer?: string;
    /**
     * Mirrors `CheckResult.retryFromVariable`. Server-internal control signal
     * used by `submitInput` to rewind awaiting state on fail. Harmless leak
     * to the client — the frontend schema doesn't consume it.
     */
    retryFromVariable?: string;
  };
  disabledStages: DisabledStage[];
  typingSpeedMs?: number;
  /**
   * Set when a stage declares `waitForInputValue` and the player typed
   * something else. The server keeps the session in the same awaiting state;
   * the frontend renders a dim hint and re-prompts. `message` is a warm,
   * locale-aware sentence (drawn from `sentences.retry-*` with `{expected}`
   * interpolated) when the pack ships the bucket — else `undefined` and the
   * frontend falls back to the raw `[expected "X" — try again]` debug hint.
   */
  rejected?: { expected: string; got: string; message?: string };
}

export interface CreateSessionInput {
  locale?: Locale;
  clusterEndpoint: string;
  clusterProfile: ClusterProfile;
  capabilities: CapabilityFlag[];
}

export class SessionService {
  readonly sessions: SessionQueries;
  readonly variables: VariableQueries;
  readonly history: HistoryQueries;
  readonly clusterCache: ClusterCacheQueries;
  readonly clusterConfig: ClusterConfigQueries;
  readonly mockOverlay: MockOverlayQueries;
  readonly gateUnlocks: GateUnlockQueries;
  readonly packOverlay: PackOverlayQueries;
  readonly packPauses: PackPauseQueries;
  private readonly runner: StageRunner;
  /**
   * The pristine, JSON-loaded stage list as the runner was first built. We
   * hold this immutably so applyEffectiveStages() can recompute the
   * runner's effective list from `baseStages + overlay` on every change,
   * never letting prior overlays leak into the next computation.
   */
  private readonly baseStages: readonly StageDefinition[];
  private readonly nutanix: NutanixClient;
  readonly actions: ActionRegistry;
  private readonly logger: Logger;
  readonly packId: string;
  private readonly bundle: LocaleBundle;
  private readonly globalTypingSpeedMs?: number;
  private readonly initialVariables: Record<string, unknown>;
  private readonly sessionDirectory: SessionDirectory;
  /**
   * In-memory mirror of the gate_unlocks table for the current pack. Read at
   * boot, mutated by `setGateUnlock`. Passed to the runner on every advance
   * so a stage with `adminGate: true` lets through iff its id is in the set.
   * Stores numeric indices (stage.id) to match the engine's gating signature;
   * name ↔ index conversion happens at the DB boundary.
   */
  private unlockedGateIds: Set<number>;
  /**
   * Mirror of the pack_pauses row, ms-since-epoch when the pause was set.
   * `null` = the pack is running normally. Refreshed at boot + after every
   * setGlobalPause call. Checked at the top of advance() before any other
   * gating so a single DB row gates the entire room.
   */
  private globallyPausedAt: number | null;

  constructor(deps: SessionServiceDeps) {
    this.sessions = new SessionQueries(deps.db);
    this.variables = new VariableQueries(deps.db);
    this.history = new HistoryQueries(deps.db);
    this.clusterCache = new ClusterCacheQueries(deps.db);
    this.clusterConfig = new ClusterConfigQueries(deps.db);
    this.mockOverlay = new MockOverlayQueries(deps.db);
    this.gateUnlocks = new GateUnlockQueries(deps.db);
    this.packOverlay = new PackOverlayQueries(deps.db);
    this.packPauses = new PackPauseQueries(deps.db);
    this.sessionDirectory = makeSessionDirectory(deps.db, deps.packId);
    this.runner = deps.runner;
    this.baseStages = [...deps.runner.listStages()];
    this.nutanix = deps.nutanix;
    this.actions = deps.actions ?? new ActionRegistry();
    this.logger = deps.logger;
    this.packId = deps.packId;
    this.bundle = deps.bundle;
    this.globalTypingSpeedMs = deps.globalTypingSpeedMs;
    this.initialVariables = deps.initialVariables ?? {};
    this.unlockedGateIds = this.rebuildUnlockedSet();
    this.globallyPausedAt = this.packPauses.get(this.packId)?.pausedAt ?? null;
    // Apply any persisted overlay at boot so a server restart preserves
    // operator tweaks. Cheap: one DB read + an in-memory map+rebuild.
    this.applyEffectiveStages();
  }

  // ---------------- name ↔ index helpers ----------------

  private stageNames(): string[] {
    return this.runner.listStages().map((s) => s.name);
  }

  /** Index of `name` in the current effective pack order, or -1 if absent. */
  private stageIndex(name: string | null | undefined): number {
    if (!name) return -1;
    const stages = this.runner.listStages();
    for (let i = 0; i < stages.length; i++) if (stages[i]!.name === name) return i;
    return -1;
  }

  /** Inverse of `stageIndex`: look up stage name by positional index. */
  private stageNameByIndex(idx: number): string | null {
    const stages = this.runner.listStages();
    return idx >= 0 && idx < stages.length ? (stages[idx]!.name ?? null) : null;
  }

  private rebuildUnlockedSet(): Set<number> {
    return new Set(
      this.gateUnlocks
        .list(this.packId)
        .map((r) => this.stageIndex(r.stageName))
        .filter((i) => i >= 0),
    );
  }

  // ---------------- pack-level state ----------------

  /** True iff a pack-wide pause is active (lunch lock, etc.). */
  isGloballyPaused(): boolean {
    return this.globallyPausedAt !== null;
  }

  /** Pause metadata, or `null` if the pack is running. */
  globalPauseInfo(): { pausedAt: number } | null {
    return this.globallyPausedAt === null ? null : { pausedAt: this.globallyPausedAt };
  }

  /** Engage / lift the pack-wide pause. Persists + mirrors to memory. */
  setGlobalPause(paused: boolean, reason = 'lunch'): void {
    if (paused) {
      const now = Date.now();
      this.packPauses.set(this.packId, reason, now);
      this.globallyPausedAt = now;
    } else {
      this.packPauses.clear(this.packId);
      this.globallyPausedAt = null;
    }
  }

  /** Pristine stages (no overlay applied) — used by route handlers to
   *  show the operator the JSON defaults alongside the live overrides. */
  listBaseStages(): readonly StageDefinition[] {
    return this.baseStages;
  }

  /** Effective stages = base + overlay, what the runner is currently using. */
  listEffectiveStages(): readonly StageDefinition[] {
    return this.runner.listStages();
  }

  /**
   * Reload the overlay rows and rebuild the runner's stage list. Call this
   * after every PackOverlayQueries.setField mutation so live sessions pick
   * up the change on their next advance(). No session state is touched —
   * the change only affects future gate verdicts. Also refreshes the
   * unlockedGate index cache since stage indices may have shifted.
   */
  applyEffectiveStages(): void {
    const overlay = this.packOverlay.list(this.packId);
    const effective = applyOverlay(this.baseStages, overlay);
    this.runner.replaceStages(effective);
    this.unlockedGateIds = this.rebuildUnlockedSet();
  }

  /** Stage names currently unlocked by an admin (read-only snapshot). */
  listUnlockedGates(): string[] {
    const stages = this.runner.listStages();
    const out: string[] = [];
    for (const idx of this.unlockedGateIds) {
      const s = stages[idx];
      if (s) out.push(s.name);
    }
    return out.sort();
  }

  /** Flip a gate; persists to DB and updates the in-memory set atomically. */
  setGateUnlock(stageName: string, unlocked: boolean): void {
    const idx = this.stageIndex(stageName);
    if (idx < 0) throw new HttpError(404, `Stage '${stageName}' not in pack`);
    if (unlocked) {
      this.gateUnlocks.unlock(this.packId, stageName);
      this.unlockedGateIds.add(idx);
    } else {
      this.gateUnlocks.lock(this.packId, stageName);
      this.unlockedGateIds.delete(idx);
    }
  }

  /**
   * Create a fresh anonymous session. Trigram and PIN are no longer part of
   * session creation — the player enters them in-game (via `#>I:Trigram#` /
   * `#>I:PIN#`) and they live as regular session variables, not as DB keys.
   * The `trigram` / `pin_hash` columns carry placeholders derived from the
   * session id so the legacy NOT NULL + unique constraints stay satisfied.
   * Resume is now strictly sessionId-based (localStorage on the client side).
   */
  create(input: CreateSessionInput): SessionRecord {
    const id = crypto.randomUUID();
    const record = this.sessions.create({
      id,
      trigram: id,
      pinHash: '',
      username: null,
      packId: this.packId,
      locale: input.locale ?? 'en',
      clusterEndpoint: input.clusterEndpoint,
      clusterProfile: input.clusterProfile,
      capabilities: input.capabilities,
    });
    // Per-session randomized Vlanid — mirrors the original Python game's
    // `main.py` (`Vlanid: str(random.randrange(250))`). Without this two
    // concurrent players collide on the same VLAN ID and AHV refuses the
    // second `{trigram}-subnet`. Operator can pin a fixed VLAN by setting
    // `GAME_VLAN_ID` in env (the global initial overrides this only when
    // empty / unset).
    const envVlanId = this.initialVariables.Vlanid;
    if (envVlanId === undefined || envVlanId === '' || envVlanId === null) {
      const randVlan = String(Math.floor(Math.random() * 250));
      this.variables.upsert(id, 'Vlanid', randVlan, 'session-init');
    }
    return record;
  }

  getSession(id: string): SessionRecord {
    const session = this.sessions.byId(id);
    if (!session) throw new HttpError(404, 'Session not found');
    return session;
  }

  /**
   * Fire the registered **act** handler for the stage the session is currently
   * awaiting on, reusing the session's live `vars` + cluster cache + nutanix
   * client. Used by the auto-play UI in `test` mode: the operator's "Ok"
   * shortcut needs the cluster-side resource to exist before the check runs,
   * so we run the equivalent of the player's GUI step automatically.
   *
   * Captured vars (UUIDs, names) write through `variablesForSession` to the
   * DB, so subsequent stages that `needs` them see them. Idempotency is the
   * act handler's responsibility (existing handlers use an `ensure()`
   * pattern: list → match-by-name → early return).
   *
   * Throws 409 when not awaiting, 404 when no act is registered for the
   * awaiting stage. Mode gating (live vs mock/test) is the route's job —
   * this method has no opinion on which modes should expose it.
   */
  async runActForAwaitingStage(
    sessionId: string,
    actFn: ActFunction,
  ): Promise<{ stageName: string; durationMs: number }> {
    const session = this.getSession(sessionId);
    if (!session.awaiting) {
      throw new HttpError(409, 'session is not awaiting input');
    }
    const stageName = session.awaiting.stageName;
    const ctx = this.buildCheckContext(session);
    const actCtx: ActContext = {
      nutanix: ctx.nutanix,
      vars: ctx.vars,
      cache: ctx.cache,
      session: ctx.session,
      logger: ctx.logger,
    };
    const startedAt = Date.now();
    await actFn(actCtx);
    return { stageName, durationMs: Date.now() - startedAt };
  }

  /**
   * Run an arbitrary read-only query against the session's live context.
   * Used by the auto-fill endpoint to look up cluster values for named-var
   * prompts (NodeSerial, NumberUpdates, Runway) so auto-play can submit
   * the right value instead of skipping the prompt. The fn gets the same
   * `nutanix`/`vars` surface the checks use.
   */
  async queryWithSessionContext<T>(
    sessionId: string,
    fn: (ctx: CheckContext) => Promise<T>,
  ): Promise<T> {
    const session = this.getSession(sessionId);
    const ctx = this.buildCheckContext(session);
    return fn(ctx);
  }

  /**
   * Re-render the awaited stage up to its first await-input unit, so a client
   * resuming a session sees the same prompt text instead of a bare marker.
   * Returns null when the session is not awaiting anything.
   */
  replayAwaiting(session: SessionRecord): MessageUnit[] | null {
    if (!session.awaiting) return null;
    const stage = this.runner.stageByName(session.awaiting.stageName);
    if (!stage) return null;
    const vars = variablesForSession(session.id, this.variables, this.initialVariables);
    const rendered = this.runner.render(
      stage,
      vars,
      session.locale,
      this.bundle,
      this.globalTypingSpeedMs,
    );
    return rendered.units.slice(0, session.awaiting.renderOffset);
  }

  /**
   * Walk upcoming stages' `needs` and, for each missing variable whose
   * producer stage should have already run (producer appears before
   * currentStage in pack order), replay the producer's check silently to
   * repopulate it. Producers later in the pack are skipped — they'll
   * capture naturally when the player reaches them. Failures are logged
   * and swallowed: partial fill is better than bailing out mid-session.
   */
  private async fillMissingDeps(session: SessionRecord, ctx: CheckContext): Promise<void> {
    const stages = this.runner.listStages();
    const currentIdx = this.stageIndex(session.currentStage);
    // Build var→producer map from declared captures. First producer wins
    // (earliest stage that claims the capture is the canonical source).
    const byCapture = new Map<string, StageDefinition>();
    for (const s of stages) {
      for (const v of s.captures ?? []) {
        if (!byCapture.has(v) && s.check?.fn) byCapture.set(v, s);
      }
    }
    const needed = new Set<string>();
    for (const s of stages) {
      if (s.id <= currentIdx) continue;
      for (const n of s.needs ?? []) {
        if (!ctx.vars.has(n)) needed.add(n);
      }
    }
    for (const v of needed) {
      const producer = byCapture.get(v);
      if (!producer) continue;
      if (producer.id > currentIdx) continue;
      if (ctx.vars.has(v)) continue;
      try {
        const result = await this.runner.rehydrate(producer, ctx);
        if (result.captured) {
          for (const [name, value] of Object.entries(result.captured)) {
            ctx.vars.set(name, value, producer.name);
          }
          this.logger.info('auto-rehydrate populated vars', {
            producer: producer.name,
            missing: v,
            captured: Object.keys(result.captured),
          });
        }
      } catch (err) {
        this.logger.warn('auto-rehydrate failed', {
          producer: producer.name,
          missing: v,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private buildCheckContext(session: SessionRecord): CheckContext {
    const vars = variablesForSession(session.id, this.variables, this.initialVariables);
    const cache = clusterCacheForSession(session.id, this.clusterCache);
    const overlay = mockOverlayForSession(session.id, this.mockOverlay);
    // In mock mode, template `{Trigram}` (and other var references) into
    // fixture responses so static fixtures can simulate per-player entities
    // like `{Trigram}-adm` without hard-coding a trigram. Then apply the
    // per-session mock overlay so stage-fired actions (deleteVM, etc.) shadow
    // the fixture for subsequent queries. Real adapters are passthrough.
    const interpolated = withVariableInterpolation(this.nutanix, () => vars.snapshot());
    const nutanix = withMockOverlay(interpolated, () => overlay.list());
    // Snapshot the cluster_config table once per check call. Two rows
    // max (rackable_unit_serials, lcm_available_updates), so two cheap
    // SQLite reads — fine to do per check, no need for an in-memory
    // cache that would have to invalidate on /admin edits.
    const rackable = this.clusterConfig.get<unknown>('rackable_unit_serials');
    const lcm = this.clusterConfig.get<unknown>('lcm_available_updates');
    return {
      nutanix,
      vars,
      cache,
      args: {},
      session: {
        id: session.id,
        trigram: session.trigram,
        locale: session.locale,
        clusterProfile: session.clusterProfile,
      },
      logger: this.logger,
      sessionDirectory: this.sessionDirectory,
      clusterConfig: {
        rackableUnitSerials: Array.isArray(rackable)
          ? (rackable.filter((s) => typeof s === 'string') as string[])
          : undefined,
        lcmAvailableUpdates: typeof lcm === 'number' ? lcm : undefined,
      },
    };
  }

  private buildActionContext(session: SessionRecord, ctx: CheckContext): ActionContext {
    const overlay = mockOverlayForSession(session.id, this.mockOverlay);
    return {
      nutanix: ctx.nutanix,
      vars: ctx.vars,
      cache: ctx.cache,
      session: ctx.session,
      logger: this.logger,
      mockOverlay: overlay,
    };
  }

  /**
   * Fire every action a stage's rendered text collected (from `<action
   * name='foo'/>` tags), in order. Unknown action names are logged and
   * skipped — a typo in a pack shouldn't crash the advance flow. Failures
   * from a known handler bubble up so the caller can decide whether to
   * abort the stage.
   */
  private async dispatchActions(
    names: readonly string[],
    actionCtx: ActionContext,
  ): Promise<void> {
    for (const name of names) {
      const handler = this.actions.get(name);
      if (!handler) {
        this.logger.warn('action handler not registered, skipping', { name });
        continue;
      }
      await handler(actionCtx);
    }
  }

  /**
   * Dev/test hook: fire a named action out-of-band of the stage flow. Used
   * during mock validation to simulate the player's real-cluster side-effect
   * (e.g. restoring a VM from a recovery point) that otherwise has no mock
   * equivalent. Throws 404 when the action isn't registered.
   */
  async fireAction(sessionId: string, name: string): Promise<void> {
    const session = this.getSession(sessionId);
    const handler = this.actions.get(name);
    if (!handler) throw new HttpError(404, `Action '${name}' not registered`);
    const ctx = this.buildCheckContext(session);
    const actionCtx = this.buildActionContext(session, ctx);
    await handler(actionCtx);
  }

  /** List action names the current pack registered. For DevPanel UX. */
  listActionNames(): string[] {
    return this.actions.names();
  }

  async advance(sessionId: string): Promise<AdvanceResult> {
    const session = this.getSession(sessionId);
    if (session.finishedAt) {
      return {
        kind: 'finished',
        units: [],
        actions: [],
        disabledStages: [],
      };
    }
    if (session.awaiting) {
      throw new HttpError(409, 'Session awaiting input; submit input before advancing');
    }
    // Pack-wide pause (lunch lock, etc.) — checked BEFORE the runner so a
    // single DB row gates the whole room without rebuilding the runner.
    // submitInput intentionally bypasses this check: a player who's typing
    // their PIN/answer can FINISH the current stage, the lock kicks in at
    // the next transition. That matches the operator's mental model
    // ("everyone wraps up what they're doing, then we pause").
    if (this.isGloballyPaused()) {
      return {
        kind: 'gated',
        gatedReason: 'global',
        units: [],
        actions: [],
        disabledStages: [],
      };
    }
    const ctx = this.buildCheckContext(session);
    // Before gating, make sure every upcoming stage's `needs` can be
    // satisfied by a value we already hold. When a variable is missing and
    // a rehydratable producer exists at-or-before currentStage (i.e. was
    // supposed to run already), replay its check silently to repopulate the
    // value. This is what unblocks `/goto/N` jumps: the producer's capture
    // was never captured because its stage was skipped by the goto, and
    // now a downstream need would gate the jump out.
    await this.fillMissingDeps(session, ctx);
    const currentIdx = this.stageIndex(session.currentStage);
    const next = this.runner.nextStage(
      {
        capabilities: new Set(session.capabilities),
        clusterProfile: session.clusterProfile,
        currentStage: currentIdx,
        gateUnlocks: this.unlockedGateIds,
      },
      ctx.vars,
    );
    if (!next) {
      this.sessions.markFinished(session.id);
      return {
        kind: 'finished',
        units: [],
        actions: [],
        disabledStages: [],
      };
    }

    const disabled: DisabledStage[] = [];
    for (const { stage, verdict } of next.skippedDisabled) {
      const detail = formatDisableReason(verdict);
      this.history.record(session.id, stage.name, 'disabled', null, detail);
      if (verdict.reason === 'missing-capability') {
        disabled.push({ name: stage.name, reason: 'missing-capability', missing: verdict.missing });
      } else if (verdict.reason === 'destructive-on-other') {
        disabled.push({ name: stage.name, reason: 'destructive-on-other' });
      } else {
        disabled.push({
          name: stage.name,
          reason: 'missing-upstream',
          missingVars: verdict.missingVars,
        });
      }
    }

    if (next.kind === 'gated') {
      // Park the session at the gate. No DB mutation: currentStage stays at
      // the last completed stage, and the client polls advance() on a 3 s
      // cadence until the admin unlocks. No `<action/>` dispatch yet either —
      // those belong to the gated stage's own render, fired only once we let
      // the player in.
      return {
        kind: 'gated',
        gatedReason: 'stage',
        stageName: next.stage.name,
        units: [],
        actions: [],
        disabledStages: disabled,
      };
    }

    const rendered = this.runner.render(
      next.next,
      ctx.vars,
      session.locale,
      this.bundle,
      this.globalTypingSpeedMs,
    );

    // Fire stage-declared actions before the check so narrative side-effects
    // (deleteVM, etc.) are reflected in cluster state by the time the stage's
    // check — or the next stage's check — runs. Actions on awaiting-input
    // stages fire here too; if the player never submits, the actions already
    // fired once on the first advance, and the stage won't re-render on
    // retry, so we don't double-dispatch.
    if (rendered.actions.length > 0) {
      const actionCtx = this.buildActionContext(session, ctx);
      await this.dispatchActions(rendered.actions, actionCtx);
    }

    if (rendered.firstAwaitInputIdx >= 0) {
      const upto = rendered.firstAwaitInputIdx + 1;
      const awaitUnit = rendered.units[rendered.firstAwaitInputIdx];
      if (awaitUnit.kind !== 'await-input') {
        throw new Error('internal: await-input index mismatch');
      }
      this.sessions.setAwaiting(session.id, {
        variable: awaitUnit.variable,
        stageName: next.next.name,
        renderOffset: upto,
      });
      return {
        kind: 'awaiting-input',
        stageName: next.next.name,
        units: rendered.units.slice(0, upto),
        awaitingVariable: awaitUnit.variable,
        actions: rendered.actions,
        disabledStages: disabled,
        typingSpeedMs: rendered.typingSpeedMs,
      };
    }

    return await this.finalizeStage(session, next.next, ctx, rendered.units, rendered.actions, disabled, rendered.typingSpeedMs);
  }

  async submitInput(sessionId: string, variable: string, value: string): Promise<AdvanceResult> {
    const session = this.getSession(sessionId);
    if (!session.awaiting) {
      throw new HttpError(409, 'Session not awaiting input');
    }
    if (session.awaiting.variable !== variable) {
      throw new HttpError(400, `Expected input for '${session.awaiting.variable}', got '${variable}'`);
    }
    const stage = this.runner.stageByName(session.awaiting.stageName);
    if (!stage) throw new HttpError(500, 'Awaited stage disappeared from pack');

    const ctx = this.buildCheckContext(session);
    ctx.vars.set(variable, value, stage.name);

    // Resolve the stage's `computeGreeting` branch (if declared) BEFORE
    // re-rendering, so the next slice — typically the PIN prompt — already
    // has `{Greeting}` substituted. Returning = at least one unfinished
    // sibling session in the same pack captured the same `inputVar` value.
    if (stage.computeGreeting && variable === stage.computeGreeting.inputVar) {
      const others = this.sessionDirectory
        .findOtherSessionsWithVariable(session.id, variable, value)
        .filter((s) => s.finishedAt === null);
      const key = others.length > 0
        ? stage.computeGreeting.returningKey
        : stage.computeGreeting.newKey;
      const greeting = resolveKey(key, session.locale, this.bundle, {
        onMissing: (k, loc) =>
          this.logger.warn('computeGreeting key missing', { key: k, locale: loc, stageName: stage.name }),
      });
      ctx.vars.set(stage.computeGreeting.outputVar, greeting, stage.name);
    }

    const rendered = this.runner.render(
      stage,
      ctx.vars,
      session.locale,
      this.bundle,
      this.globalTypingSpeedMs,
    );
    const fromIdx = session.awaiting.renderOffset;
    const nextInputIdx = this.runner.nextAwaitInputAfter(rendered.units, fromIdx);

    if (nextInputIdx >= 0) {
      const upto = nextInputIdx + 1;
      const awaitUnit = rendered.units[nextInputIdx];
      if (awaitUnit.kind !== 'await-input') {
        throw new Error('internal: await-input index mismatch');
      }
      this.sessions.setAwaiting(session.id, {
        variable: awaitUnit.variable,
        stageName: stage.name,
        renderOffset: upto,
      });
      return {
        kind: 'awaiting-input',
        stageName: stage.name,
        units: rendered.units.slice(fromIdx, upto),
        awaitingVariable: awaitUnit.variable,
        actions: [],
        disabledStages: [],
        typingSpeedMs: rendered.typingSpeedMs,
      };
    }

    // This was the stage's final input — enforce `waitForInputValue` before
    // finalizing. On mismatch, restore the awaiting state so the player can
    // try again without replaying the whole prompt.
    if (
      stage.waitForInputValue !== undefined &&
      value.trim().toLowerCase() !== stage.waitForInputValue.trim().toLowerCase()
    ) {
      this.sessions.setAwaiting(session.id, {
        variable,
        stageName: stage.name,
        renderOffset: session.awaiting.renderOffset,
      });
      const retryTemplate = pickSentence(this.bundle, session.locale, 'sentences.retry-');
      const message = retryTemplate?.replaceAll('{expected}', stage.waitForInputValue);
      return {
        kind: 'awaiting-input',
        stageName: stage.name,
        units: [],
        awaitingVariable: variable,
        actions: [],
        disabledStages: [],
        typingSpeedMs: rendered.typingSpeedMs,
        rejected: { expected: stage.waitForInputValue, got: value, message },
      };
    }

    const prevAwaiting = session.awaiting;
    this.sessions.setAwaiting(session.id, null);
    const result = await this.finalizeStage(
      session,
      stage,
      ctx,
      rendered.units.slice(fromIdx),
      rendered.actions,
      [],
      rendered.typingSpeedMs,
    );
    // On check-fail, put the player back at the same input so they can retry
    // without the whole stage re-rendering. Otherwise awaiting stays null,
    // auto-advance fires, and the gate re-picks this stage (currentStage
    // didn't move) — the full prompt prints again on top of the failure line.
    if (prevAwaiting && result.check && !result.check.pass) {
      // Rewind path: the check named an earlier `<input/>` as the root
      // cause (e.g. CheckTrigram fails on PIN submission but the collision
      // is on Trigram). Move awaiting back to that input and clear every
      // captured variable at or after it so the player re-enters them.
      const retryFrom = result.check.retryFromVariable;
      if (retryFrom) {
        const rewindIdx = this.runner.firstAwaitInputFor(rendered.units, retryFrom);
        if (rewindIdx >= 0 && rewindIdx + 1 < prevAwaiting.renderOffset) {
          for (let i = rewindIdx; i < rendered.units.length; i++) {
            const u = rendered.units[i];
            if (u.kind === 'await-input') ctx.vars.delete(u.variable);
          }
          this.sessions.setAwaiting(session.id, {
            variable: retryFrom,
            stageName: stage.name,
            renderOffset: rewindIdx + 1,
          });
          return {
            ...result,
            kind: 'awaiting-input',
            awaitingVariable: retryFrom,
            // Empty units: the failure chip (result.check.detail) carries
            // the retry instruction; re-emitting the prompt text would
            // duplicate noise the player already sees above.
            units: [],
          };
        }
      }
      this.sessions.setAwaiting(session.id, prevAwaiting);
      return {
        ...result,
        kind: 'awaiting-input',
        awaitingVariable: prevAwaiting.variable,
      };
    }
    return result;
  }

  /**
   * Reset the session's identity capture without starting from scratch:
   * rewind to before the login prompts (so they replay), drop the
   * Trigram / PIN / Username variables, keep everything else (locale,
   * sessionId). Wired to the "switch agent" frontend affordance (↓ during
   * login, header link) — cheaper than a full reset (which also forces the
   * language picker), and avoids inventing a second sessionId.
   */
  switchIdentity(sessionId: string): { currentStage: string | null } {
    const session = this.getSession(sessionId);
    const firstStage = this.runner.listStages()[0];
    const loreName = firstStage?.name ?? null;
    // Delete every history row from the second stage onward (the lore stage
    // stays passed so the runner jumps straight to the login prompt).
    const names = this.stageNames();
    if (names.length >= 2) {
      this.history.deleteFrom(session.id, names[1]!, names);
    }
    this.sessions.setAwaiting(session.id, null);
    this.sessions.clearFinished(session.id);
    this.sessions.updateCurrentStage(session.id, loreName);
    for (const name of ['Trigram', 'PIN', 'Username']) {
      this.variables.delete(session.id, name);
    }
    return { currentStage: loreName };
  }

  /**
   * Dev/test tool: jump the session to a given stage without running checks.
   * Works both forward (will replay that stage on next advance) and backward
   * (history entries at-or-after the target are dropped; awaiting state is
   * cleared; variables and cluster_cache are preserved so captured UUIDs
   * survive). `currentStage` lands on the stage just BEFORE the target so
   * the next advance() picks the target up.
   */
  gotoStage(sessionId: string, stageName: string): { currentStage: string | null } {
    const session = this.getSession(sessionId);
    const targetIdx = this.stageIndex(stageName);
    if (targetIdx < 0) throw new HttpError(404, `Stage '${stageName}' not in pack`);
    if (targetIdx < 1) throw new HttpError(400, `Stage '${stageName}' is not a valid goto target`);
    const names = this.stageNames();
    this.history.deleteFrom(session.id, stageName, names);
    this.sessions.setAwaiting(session.id, null);
    this.sessions.clearFinished(session.id);
    const prevName = names[targetIdx - 1]!;
    this.sessions.updateCurrentStage(session.id, prevName);
    return { currentStage: prevName };
  }

  async skipTo(
    sessionId: string,
    stageName: string,
  ): Promise<{ skipped: string[]; finalStage: string | null }> {
    const session = this.getSession(sessionId);
    const targetIdx = this.stageIndex(stageName);
    if (targetIdx < 0) throw new HttpError(404, `Stage '${stageName}' not in pack`);
    const currentIdx = this.stageIndex(session.currentStage);
    if (targetIdx <= currentIdx) {
      return { skipped: [], finalStage: session.currentStage };
    }
    const ctx = this.buildCheckContext(session);
    const skipped: string[] = [];
    for (const stage of this.runner.listStages()) {
      if (stage.id <= currentIdx) continue;
      if (stage.id > targetIdx) break;
      const start = Date.now();
      const result = await this.runner.rehydrate(stage, ctx);
      this.history.record(
        session.id,
        stage.name,
        result.pass ? 'skipped' : 'failed',
        Date.now() - start,
        result.detail ?? null,
      );
      if (result.captured) {
        for (const [name, value] of Object.entries(result.captured)) {
          ctx.vars.set(name, value, stage.name);
        }
      }
      skipped.push(stage.name);
    }
    this.sessions.setAwaiting(session.id, null);
    this.sessions.updateCurrentStage(session.id, stageName);
    return { skipped, finalStage: stageName };
  }

  private async finalizeStage(
    session: SessionRecord,
    stage: StageDefinition,
    ctx: CheckContext,
    units: MessageUnit[],
    actions: string[],
    disabledStages: DisabledStage[],
    typingSpeedMs: number | undefined,
  ): Promise<AdvanceResult> {
    const start = Date.now();
    let checkResult: AdvanceResult['check'] | undefined;
    if (stage.check) {
      const r = await this.runner.runCheck(stage, ctx);
      // `switchTo` short-circuits the whole finalize path. The check said
      // "don't keep going, hand off to this other sessionId" — we drop the
      // current session (cascades child rows), skip history + captures +
      // currentStage, and return a switch-session response so the client
      // swaps localStorage.
      if (r.switchTo) {
        this.sessions.deleteById(session.id);
        return {
          kind: 'switch-session',
          switchSessionId: r.switchTo,
          units: [],
          actions: [],
          disabledStages: [],
        };
      }
      // Stages marked silentOnSuccess omit the check row from the UI on pass —
      // narrative beats already say their piece in-prose, no need for a
      // synthetic `[✓] Stage validated.` cap. Failures still surface so the
      // player knows why they're stuck.
      if (!(r.pass && stage.silentOnSuccess)) {
        const cheer = pickSentence(
          this.bundle,
          session.locale,
          r.pass ? 'sentences.ok-' : 'sentences.ko-',
        );
        checkResult = {
          pass: r.pass,
          detail: r.detail,
          hint: r.hint,
          cheer,
          retryFromVariable: r.retryFromVariable,
        };
      }
      if (r.captured) {
        for (const [name, value] of Object.entries(r.captured)) {
          ctx.vars.set(name, value, stage.name);
        }
      }
      // Invalidations run AFTER captures so a stage that both captures and
      // invalidates the same name (edge case) lands in a well-defined state.
      // Only fire on pass — a failing check hasn't actually destroyed anything.
      if (r.pass && stage.invalidates) {
        for (const name of stage.invalidates) ctx.vars.delete(name);
      }
      this.history.record(
        session.id,
        stage.name,
        r.pass ? 'passed' : 'failed',
        Date.now() - start,
        r.detail ?? null,
      );
      // Progress on pass regardless of saveScore. saveScore is a checkpoint
      // marker (for leaderboards / UI), not a gate on advancement — otherwise
      // narrative stages with SaveScore:false would loop forever.
      if (r.pass) this.sessions.updateCurrentStage(session.id, stage.name);
    } else {
      // Narrative stage (no check) — advancement is the commit point, so
      // invalidations fire here unconditionally.
      if (stage.invalidates) {
        for (const name of stage.invalidates) ctx.vars.delete(name);
      }
      this.history.record(session.id, stage.name, 'passed', Date.now() - start, null);
      this.sessions.updateCurrentStage(session.id, stage.name);
    }

    return {
      kind: 'units',
      stageName: stage.name,
      units,
      actions,
      check: checkResult,
      disabledStages,
      typingSpeedMs,
    };
  }
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Pick a random sentence from a keyed bucket in the locale catalog (e.g.
 * `sentences.ok-` for pass-case cheers, `sentences.ko-` for fail-case
 * commiseration). Resolves for the session's locale, falling back to the
 * bundle's default locale if the player's locale has no entries. Returns
 * `undefined` when the pack ships no such keys, so the caller can gracefully
 * fall back to the bare check detail.
 */
function pickSentence(
  bundle: LocaleBundle,
  locale: Locale,
  keyPrefix: string,
): string | undefined {
  const catalog = bundle.catalogs[locale] ?? bundle.catalogs[bundle.defaultLocale];
  if (!catalog) return undefined;
  const keys = Object.keys(catalog).filter((k) => k.startsWith(keyPrefix));
  if (keys.length === 0) return undefined;
  const key = keys[Math.floor(Math.random() * keys.length)];
  const value = catalog[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function formatDisableReason(
  verdict:
    | { reason: 'missing-capability'; missing: string[] }
    | { reason: 'destructive-on-other' }
    | { reason: 'missing-upstream'; missingVars: string[] },
): string {
  switch (verdict.reason) {
    case 'missing-capability':
      return `missing capability: ${verdict.missing.join(', ') || '(unspecified)'}`;
    case 'destructive-on-other':
      return 'destructive on shared cluster';
    case 'missing-upstream':
      return `missing upstream vars: ${verdict.missingVars.join(', ') || '(unspecified)'}`;
  }
}

function makeSessionDirectory(db: Database, packId: string): SessionDirectory {
  // `session_variables.value` is stored JSON-encoded (see VariableQueries.upsert),
  // so string values live on disk as `"abc"`, not `abc`. JSON.stringify the
  // probe value once here so the query stays a cheap equality match on the
  // (session_id, name) primary key + inline pack/finish filters.
  const stmt = db.prepare(
    `SELECT s.id AS session_id, s.current_stage AS current_stage, s.finished_at AS finished_at, s.started_at AS started_at
     FROM sessions s
     JOIN session_variables v ON v.session_id = s.id
     WHERE s.pack_id = $packId
       AND s.id != $currentId
       AND v.name = $varName
       AND v.value = $varValue
     ORDER BY s.started_at DESC`,
  );
  const getVarStmt = db.prepare(
    `SELECT v.value AS value
     FROM session_variables v
     JOIN sessions s ON s.id = v.session_id
     WHERE s.pack_id = $packId AND v.session_id = $sid AND v.name = $name`,
  );
  return {
    findOtherSessionsWithVariable(currentSessionId, variableName, value) {
      const rows = stmt.all({
        $packId: packId,
        $currentId: currentSessionId,
        $varName: variableName,
        $varValue: JSON.stringify(value),
      }) as Array<{
        session_id: string;
        current_stage: string | null;
        finished_at: number | null;
        started_at: number;
      }>;
      return rows.map((r) => ({
        sessionId: r.session_id,
        currentStage: r.current_stage,
        finishedAt: r.finished_at,
      }));
    },
    getVariable(sessionId, variableName) {
      const row = getVarStmt.get({
        $packId: packId,
        $sid: sessionId,
        $name: variableName,
      }) as { value: string } | null;
      if (!row) return undefined;
      try {
        return JSON.parse(row.value);
      } catch {
        return row.value;
      }
    },
  };
}
