import type { MessageUnit } from '@ntnx-game/shared';

/**
 * A locale code — BCP-47 style. Narrowed to a string so adding a new language
 * is a pure data change (drop `locales/<code>.json` into the pack). The pack
 * manifest declares which codes the pack supports.
 */
export type Locale = string;

/** Flat key → template map for a single locale. */
export type LocaleCatalog = Record<string, string>;

/**
 * Runtime collection of locale catalogs plus the pack's default locale,
 * consumed by {@link StageRunner} when resolving message keys.
 */
export interface LocaleBundle {
  defaultLocale: Locale;
  supported: readonly Locale[];
  catalogs: Record<Locale, LocaleCatalog>;
}

export type CapabilityFlag =
  | 'NCM'
  | 'IO'
  | 'CalmDSL'
  | 'NodeRemove'
  | 'MultiNode'
  | 'ApprovalPolicy'
  // Secondary PC ("Planner") is wired with non-empty host + user +
  // password. Config-driven (no HTTP probe) — gating stages 31
  // (capacity-runway, live runway query against the OldPC) + 32
  // (resource-optimization, narrative continuation on the same
  // Planner cluster). When unwired, both stages auto-skip via the
  // capability gate instead of leaving the player with a broken
  // prompt (empty `{OldPCPassword}` in the displayed creds).
  | 'PlannerCluster';

/**
 * Cluster profile drives `impact: 'hpoc-only'` gating.
 *
 *   `hpoc`  — recognized HPoC (DM3 / RNO / PHX IP ranges) reserved for the
 *             event. Operator has the keys; `hpoc-only` stages run.
 *   `other` — anything else. Fail-safe: `hpoc-only` stages are filtered
 *             and `requiresOnOther` capability gates apply.
 *
 * Operators force-allow `hpoc-only` on a non-HPoC dedicated cluster by
 * setting `CLUSTER_PROFILE=hpoc` in the env explicitly (the heuristic
 * defers to the explicit value).
 */
export type ClusterProfile = 'hpoc' | 'other';

// 'hpoc-only' (formerly 'destructive') gates stages the engine refuses to
// play on a shared cluster (cluster-shape-mutating: node remove, etc.).
// Named from the operator's mental model — "this stage only runs on HPoC"
// — instead of the scarier "destructive" tag.
export type StageImpact = 'safe' | 'hpoc-only';

export type StageStatus = 'passed' | 'skipped' | 'failed' | 'disabled';

/**
 * Stages carry ordered lists of catalog keys, not inline strings. The
 * translation for `messages[i]` is looked up at render time via
 * {@link LocaleBundle}. The `prompt` field is a speaker label (e.g. `system`,
 * `tank`) and is NOT translated.
 */
export interface StageDefinition {
  /**
   * Ephemeral positional index assigned by the pack-loader from `pack.json.stages[]`.
   * Not persisted and not part of identity. Drives ordering comparisons inside
   * the engine (gating, rehydrate, "already passed" checks) and is never
   * shipped to the player UI; the frontend shows `name`.
   */
  index: number;
  /**
   * Durable identity — frozen forever. `eg-NNN`, the `eg-` marking lineage
   * from the original escape-game; the number matches the stage's locale key
   * prefix (`eg-012` ↔ `stage-012.line-01`). Survives renames and pack
   * restructuring; this is what telemetry emits to NIG Central. Never reuse
   * an id for a different stage.
   */
  id: string;
  /**
   * Canonical identifier — kebab-case, must equal the stage's filename
   * (`name.json`) and its entry in `pack.json.stages[]`. Used for persistence
   * (DB stage_name columns, payload stageName field) and cross-stage references.
   */
  name: string;
  active: boolean;
  requires?: CapabilityFlag[];
  /**
   * Extra capability requirements enforced ONLY when `clusterProfile === 'other'`.
   * Lets a stage say "on HPoC we trust the install pipeline; on a shared
   * cluster, only play if X is actually detected". Example: stage 21
   * (create-approval-policy) needs the Calm policy engine — the BP install
   * activates it on HPoC, but on `other` we must probe before letting the
   * stage run. Empty/missing = no extra gate.
   */
  requiresOnOther?: CapabilityFlag[];
  impact?: StageImpact;
  prompt?: string;
  messages: string[];
  defaultColor?: string;
  typingSpeedMs?: number;
  check?: {
    fn: string;
    args?: Record<string, unknown>;
    rehydrate?: string;
  };
  captures?: string[];
  /**
   * When true and the stage's check passes, the server omits the `check` field
   * from the advance response so the frontend doesn't print the generic
   * `[✓] Stage validated.` row. Used by narrative beats that already say their
   * piece in-prose and shouldn't be capped by a synthetic confirmation line.
   */
  silentOnSuccess?: boolean;
  /**
   * If set, the submitted value for this stage's final `<input/>` must match
   * verbatim (case-sensitive) before the stage advances. Anything else is
   * rejected and the stage stays awaiting with a dim hint. Used by the 25
   * "Ok"-gated narrative stages ported from the Python game.
   */
  waitForInputValue?: string;
  /**
   * Session variables this stage requires: player inputs (Trigram,
   * Username) or historical state (HostUUID from CheckVM). Entity UUIDs
   * are resolved by name at check time instead (issue #31). If a listed
   * var is missing on advance, the gate returns `missing-upstream` and the
   * runtime may auto-rehydrate the producer (see StageRunner.rehydrate).
   */
  needs?: string[];
  /**
   * Stages that must run for this one to be playable, named directly rather
   * than through the variables they capture. `needs` models data; this models
   * *state on the cluster*. The bootcamp's block-storage lab does not consume
   * a variable from create-project, it consumes the namespace that stage
   * creates, so turning create-project off silently breaks it. Naming the
   * prerequisite lets the Pack tab cascade the disable instead.
   */
  dependsOn?: string[];
  /**
   * Session variables the stage destroys on completion. Fires AFTER the stage's
   * captures so a stage can theoretically invalidate and replace the same var
   * (not a current use case, but the ordering is deterministic). Used to model
   * destructive cross-stage flows — e.g. stage 23 "incident-freeze" invalidates
   * `VMUUID` so the cache no longer lies about a VM that got deleted, and
   * stage 26 "restore-vm-from-recovery" re-captures it after the player
   * restores.
   *
   * Only affects the variable store. Mutating real cluster state (mock fixture
   * overlay / live API) is a separate concern — see the action-dispatch
   * follow-up in issue #23.
   */
  invalidates?: string[];
  /**
   * Branches the stage's follow-up prompt text based on whether the value
   * captured in `inputVar` already exists in another active session. After
   * `inputVar` is captured, the session-service queries its directory for
   * other unfinished sessions holding the same value. Match → resolve
   * `returningKey` from the locale bundle; no match → resolve `newKey`. The
   * resolved string is stored as a session variable under `outputVar`, so
   * subsequent stage messages (e.g. a PIN prompt template `{Greeting}: …`)
   * render the right branch inline. Used by stage 1 to greet new vs.
   * returning agents without inflating the stage's message count.
   */
  computeGreeting?: {
    inputVar: string;
    newKey: string;
    returningKey: string;
    outputVar: string;
  };
  /**
   * If true, the stage cannot be entered until an operator unlocks it from
   * `/admin`. The unlock state is per-pack (one click → every blocked session
   * resumes), persisted in the `gate_unlocks` table. Used to insert manual
   * pauses for synchronizing players, theory recaps, or live Q&A. Declared
   * either statically in the stage JSON or overridden via the pack overlay
   * (admin can flip the gate on/off for any stage at runtime).
   */
  adminGate?: boolean;
}

export interface GameSession {
  id: string;
  trigram: string;
  packId: string;
  currentStage: number;
  capabilities: Set<CapabilityFlag>;
  clusterProfile: ClusterProfile;
  locale: Locale;
}

export interface Variables {
  get(name: string): unknown;
  has(name: string): boolean;
  set(name: string, value: unknown, capturedAtStage: string): void;
  /** Drop a variable from the session. No-op if the name isn't set. */
  delete(name: string): void;
  snapshot(): Record<string, unknown>;
}

export interface ClusterCacheEntry {
  kind: string;
  logicalName: string;
  uuid: string;
  extra?: Record<string, unknown>;
}

export interface ClusterCache {
  get(kind: string, logicalName: string): ClusterCacheEntry | undefined;
  set(entry: ClusterCacheEntry): void;
  all(): ClusterCacheEntry[];
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export interface NutanixClient {
  readonly mode: 'mock' | 'live';
  /**
   * Legacy REST shim — routes to `rest.request()` under the hood. Kept so
   * checks/actions that haven't been migrated keep compiling. Prefer
   * `sdk.*` (typed SDK calls, v4 domains) or `rest.request()` (explicit
   * REST, for v3 or uncovered paths) in new code.
   */
  request<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  /**
   * Domain-organized SDK surface. In live mode, backed by
   * `@nutanix-api/*-js-client` packages; in mock mode, fake objects that
   * route through `request()` to the fixture store. Typed loosely here
   * (the engine deliberately doesn't depend on SDK types); concrete
   * per-domain shape lives in `@ntnx-game/nutanix` as `NutanixSdk`.
   */
  readonly sdk: NutanixSdkSurface;
  /**
   * REST escape hatch. Used for v3 endpoints (X-Play action_rules, Calm
   * apps/blueprints/scheduler, projects) that aren't covered by any SDK,
   * and for any other path outside the SDK surface.
   *
   * `headers` adds request headers, for endpoints scoped by one rather than by
   * the path (LCM's `X-Cluster-Id`). Auth and the idempotency token stay ours.
   */
  readonly rest: {
    request<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  };
}

/**
 * Structural placeholder for the SDK domain tree. The actual typed interface
 * (`NutanixSdk`) is declared in `@ntnx-game/nutanix` alongside the SDK wiring;
 * the engine keeps this loose so it doesn't depend on `@nutanix-api/*` types.
 * Checks and seeds that want the typed surface import `NutanixSdk` directly
 * and cast `ctx.nutanix.sdk as NutanixSdk`. `unknown` rather than a record
 * shape so the concrete `NutanixSdk` (with strict domain keys) slots in
 * without an awkward index-signature workaround.
 */
export type NutanixSdkSurface = unknown;

/**
 * Read-only Kubernetes transport for pack checks that validate cluster state
 * (the NKP pack). Deliberately tiny and read-only: checks only `list` resources
 * and assert fields. Mirrors {@link NutanixClient} in shape (a `mode` + a read
 * method backed by fixtures in mock, a real API in live) so the engine stays
 * transport-agnostic — it names the interface, not any k8s client library.
 * Optional on {@link CheckContext}: the NCP pack never touches it.
 */
export interface KubeResourceRef {
  /** API group; omit/empty for the core group (`/api/v1`). e.g. `apps`, `source.toolkit.fluxcd.io`. */
  group?: string;
  /** API version, e.g. `v1`, `v1beta1`. */
  version: string;
  /** Resource plural, e.g. `deployments`, `services`, `gitrepositories`. */
  plural: string;
  /** Namespace to scope to; omit for cluster-scoped or all-namespaces. */
  namespace?: string;
  /**
   * Which cluster to read, by NKP name (`workload01`, `workload02`). Omit for
   * the management cluster. An NKP fleet is several clusters and the same
   * lab spans them: the learner's Project and GitOps source are management
   * objects, while the namespace they federate into lives on a workload
   * cluster. A check names the cluster it means; the transport routes.
   */
  cluster?: string;
  /**
   * A single object's name. Optional for `list` (which reads the collection),
   * required by the write verbs, which address one object.
   */
  name?: string;
}

export interface KubeClient {
  readonly mode: 'mock' | 'live';
  /** List resources of a kind, returning the `.items` array (empty if none). */
  list(ref: KubeResourceRef): Promise<Array<Record<string, unknown>>>;
  /**
   * Create or update one object from a full manifest (server-side apply).
   *
   * Idempotent by construction, which is what an act needs: auto-play may run
   * a stage twice, and a learner may have done half of it by hand already.
   * Absent on a read-only client — a check must never mutate a cluster, so
   * `CheckContext.kube` is narrowed to the reading half.
   */
  apply?(ref: KubeResourceRef, manifest: Record<string, unknown>): Promise<void>;
  /** Merge-patch one object, the `kubectl patch -p '{…}'` of the bootcamp. */
  patch?(ref: KubeResourceRef, patch: Record<string, unknown>): Promise<void>;
  /** Delete one object. Missing is success: cleanup is idempotent too. */
  remove?(ref: KubeResourceRef): Promise<void>;
  /** Cluster names this client can reach, management first. For diagnostics. */
  readonly clusters: readonly string[];
}

export interface CheckContext {
  nutanix: NutanixClient;
  /**
   * Read-only Kubernetes transport, present only for packs that declare they
   * need it (the NKP pack). `undefined` for the NCP pack. See {@link KubeClient}.
   */
  kube?: KubeClient;
  vars: Variables;
  cache: ClusterCache;
  args: Record<string, unknown>;
  session: Pick<GameSession, 'id' | 'trigram' | 'locale' | 'clusterProfile'>;
  logger: Logger;
  /**
   * Cross-session directory — lets a check look at *other* sessions to
   * enforce uniqueness invariants the DB can't enforce directly. The
   * canonical consumer is `CheckTrigram`: the player's captured trigram
   * scopes entity names in Nutanix (`{Trigram}-vm`, `{Trigram}-adm`…), so
   * two concurrent sessions with the same trigram would collide in-cluster.
   * Sync by design — session-service backs this with a `bun:sqlite`
   * prepared statement, and check-time blocking is short. Optional so tests
   * that don't care about cross-session state can leave it `undefined`.
   */
  sessionDirectory?: SessionDirectory;
  /**
   * Pre-cached read-only cluster snapshot — populated at boot (or via the
   * /admin refresh button) to avoid hitting slow live endpoints from
   * inside a check. Optional: when `undefined` or its fields are unset,
   * the check falls back to its live query. Operator can override values
   * via the /admin Cluster tab so manual entry / edge-case clusters work
   * without requiring a real probe.
   */
  clusterConfig?: ClusterConfig;
}

export interface ClusterConfig {
  /**
   * Serials of nodes currently DISCOVERABLE (rackmounted, not yet in the
   * cluster) — i.e. expand candidates for `expand-cluster`. Probed at boot
   * via `discoverableNodeSerials()` (POST $actions/discover-unconfigured-
   * nodes + task poll). May be empty on a single-node HPoC with no spare
   * chassis — that's a legitimate "nothing to expand" state, not a probe
   * failure.
   */
  discoverableNodeSerials?: string[];
  /**
   * The count `lcm-check-updates` validates against: probed at boot, refreshed
   * or corrected by the operator in /admin. The check never reads LCM itself —
   * a live count is noise while an inventory rebuilds the list (issue #60).
   */
  lcmAvailableUpdates?: number;
}

export interface SessionDirectory {
  /**
   * Find other sessions (in the same pack, same session-service instance)
   * that captured `variableName` with `value`, case-insensitively. Excludes
   * the current session. Returns most recent activity first, finished
   * sessions included: a finished trigram is still claimed, so consumers
   * read `finishedAt` to pick a target, not to filter the list.
   */
  findOtherSessionsWithVariable(
    currentSessionId: string,
    variableName: string,
    value: string,
  ): Array<{ sessionId: string; currentStage: string | null; finishedAt: number | null }>;
  /**
   * Read a single captured variable from another session. Used by re-auth
   * flows — e.g. `CheckTrigram` compares the submitted PIN against the PIN
   * stored on a colliding session before deciding between swap and reject.
   * Returns `undefined` when the target session or variable doesn't exist.
   */
  getVariable(sessionId: string, variableName: string): unknown;
}

export interface CheckResult {
  pass: boolean;
  /**
   * "Can't judge this right now": re-prompt the player and record nothing (no
   * failed attempt, no history, no telemetry). For when the cluster, not the
   * player, is at fault. Set with `pass: false` + a `hint`. Never use it to
   * paper over a real failure.
   */
  neutral?: boolean;
  detail?: string;
  /**
   * Player-facing one-liner shown below the fail cheer, surfacing **which
   * category** of the check failed without revealing the expected value
   * (anti-spoiler — keep "VM is missing a NIC" not "VM has 1 NIC, expected 2").
   * `detail` stays in the API/logs for debug; `hint` is the curated UX text.
   * Ignored on `pass: true`.
   */
  hint?: string;
  captured?: Record<string, unknown>;
  /**
   * On a failing result, rewind the stage's `awaiting` state to the first
   * `<input/>` whose variable matches this name, instead of looping on the
   * last input. Use case: `CheckTrigram` runs after PIN submission but the
   * failure is actually about the Trigram captured earlier — setting
   * `retryFromVariable: 'Trigram'` sends the player back to the Trigram
   * prompt (the named var + any inputs between it and the current one are
   * cleared so they're re-captured). Ignored on `pass: true`.
   */
  retryFromVariable?: string;
  /**
   * When set, session-service abandons the current session (deletes its
   * row; child rows cascade) and tells the client to switch its sessionId
   * pointer to this value. Used for "returning agent" re-auth: Trigram
   * collides with another active session AND the submitted PIN matches
   * that session's captured PIN — rather than rejecting, we hand the
   * client over to the existing progression. `pass: false` on this path
   * because the current stage's normal "passed" finalization isn't what
   * we want (history/advancement belongs to the swapped-to session).
   */
  switchTo?: string;
}

export type CheckFunction = (ctx: CheckContext) => Promise<CheckResult>;

/**
 * Server-side mock overlay writer — the surface an {@link ActionFunction}
 * uses to mutate what the mock Nutanix adapter returns for subsequent
 * requests. Live-mode actions ignore it and call the real API instead.
 *
 * Only "deleted" mutations are modeled today (enough for the delete/restore
 * VM flow). Extend the `op` discriminator when more mock mutations land.
 */
export interface MockOverlay {
  mark(kind: string, logicalName: string, op: 'deleted'): void;
  unmark(kind: string, logicalName: string): void;
  list(): Array<{ kind: string; logicalName: string; op: 'deleted' }>;
}

export interface ActionContext {
  nutanix: NutanixClient;
  vars: Variables;
  cache: ClusterCache;
  session: Pick<GameSession, 'id' | 'trigram' | 'locale' | 'clusterProfile'>;
  logger: Logger;
  /** Writer for the mock adapter's per-session overlay. No-op in live mode. */
  mockOverlay: MockOverlay;
}

export type ActionFunction = (ctx: ActionContext) => Promise<void>;

/**
 * Context passed to an act or cleanup handler. Same surface as
 * {@link ActionContext} minus the mock overlay writer — acts target the
 * real cluster in live mode; in mock mode they're no-ops since the fixture
 * already shows the target state.
 */
export interface ActContext {
  nutanix: NutanixClient;
  /**
   * Kubernetes transport, present only for packs that need it (NKP). Unlike
   * the check context's, this one carries the write verbs: an act's whole job
   * is to perform the cluster-side step the learner would have done by hand.
   */
  kube?: KubeClient;
  vars: Variables;
  cache: ClusterCache;
  session: Pick<GameSession, 'id' | 'trigram' | 'locale' | 'clusterProfile'>;
  logger: Logger;
}

/**
 * Performs the cluster-side step a stage's check would validate — i.e. the
 * Nutanix API call(s) equivalent to the player's GUI action (create user,
 * create VM, attach category …). Should capture any UUIDs it produces into
 * `ctx.vars` using the same variable names the stage's check expects, so
 * subsequent stages can reference them via needs/captures chains.
 *
 * Idempotent — if the target resource already exists, return without error.
 *
 * Don't confuse with {@link ActionFunction}: `Action*` is the narrative-tag
 * dispatch (`<action name='X'/>` in locales), `Act*` is per-stage automation
 * fired by auto-play. Two parallel registries with different trigger contexts.
 */
export type ActFunction = (ctx: ActContext) => Promise<void>;

/**
 * Destroys the resource an act or player created. Matched to a stage by
 * name (same keying as acts). Idempotent — "already gone" is not an error.
 * Bulk cleanup fires every registered cleanup in reverse stage order after
 * an event to keep the HPoC tidy.
 */
export type CleanupFunction = (ctx: ActContext) => Promise<void>;

export type { MessageUnit };
