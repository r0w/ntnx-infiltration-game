import type {
  CreateSessionRequest,
  CreateSessionResponse,
  DisabledStage,
  MessageUnit,
  SubmitInputRequest,
} from '@ntnx-game/shared';

export type { DisabledStage };

export interface AdvanceResponse {
  kind: 'units' | 'awaiting-input' | 'finished' | 'switch-session' | 'gated';
  /** Canonical stage name — present on units/awaiting-input/gated(stage). */
  stageName?: string;
  units: MessageUnit[];
  awaitingVariable?: string;
  /** Set when `kind === 'switch-session'` — swap localStorage to this id. */
  switchSessionId?: string;
  /** Discriminator on gated: 'stage' (per-stage gate) | 'global' (lunch lock). */
  gatedReason?: 'stage' | 'global';
  actions: string[];
  /** Phase-1 flag: check deferred to /resolve-check (two-phase themed check). */
  checkPending?: boolean;
  check?: { pass: boolean; neutral?: boolean; detail?: string; hint?: string; cheer?: string };
  disabledStages: DisabledStage[];
  typingSpeedMs?: number;
  rejected?: { expected: string; got: string; message?: string };
}

export interface SessionSnapshot {
  sessionId: string;
  trigram: string;
  /** Canonical stage name of the last passed stage; `null` = pre-game. */
  currentStage: string | null;
  clusterProfile: 'hpoc' | 'other';
  capabilities: string[];
  awaiting: { variable: string; stageName: string; renderOffset: number } | null;
  /** Set when the session reloaded mid-check — resolve it to finish the stage. */
  pendingCheck?: { stageName: string } | null;
  locale: string;
  finishedAt: number | null;
  replay?: MessageUnit[] | null;
}

const BASE = '/api';

async function post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return handle<T>(res);
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal });
  return handle<T>(res);
}

async function adminGet<T>(path: string, password: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Admin-Password': password },
  });
  return handle<T>(res);
}

async function adminDel<T>(path: string, password: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { 'X-Admin-Password': password },
  });
  return handle<T>(res);
}

async function adminPost<T>(path: string, password: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'X-Admin-Password': password, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handle<T>(res);
}

/**
 * Thrown by `handle()` on non-2xx. Carries the parsed JSON body so
 * callers can read structured fields the backend included alongside
 * `error` (e.g. act-current's `transportError` / `transportCode` for
 * VPN diagnostics in the auto-play banner). `body` is null when the
 * response wasn't JSON.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  constructor(status: number, body: Record<string, unknown> | null, detail: string) {
    super(`${status} ${detail}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, body, detail);
  }
  return (await res.json()) as T;
}

export interface PackInfo {
  id: string;
  name: string;
  /** Player-facing game title, from the pack. See PackManifest.title. */
  title: string;
  /** Print each screenshot's description under it. See PackManifest.imageCaptions. */
  imageCaptions: boolean;
  /**
   * Operator-facing server mode. `mock` = fixtures, `test` = real PC + dev
   * tools, `live` = real PC + production demo (dev tools + auto-play
   * hidden). Drives DevPanel visibility (it hosts the auto-play toggle).
   */
  mode: 'mock' | 'test' | 'live';
  /** Server's runtime clusterProfile — `'other'` means the engine
   *  filters `hpoc-only` stages, `'hpoc'` means they play normally.
   *  DevPanel uses this to dim `hpoc-only` stage chips only when
   *  they would actually be skipped. */
  clusterProfile: 'hpoc' | 'other';
  defaultLocale: string;
  supportedLocales: string[];
  /** Subset of `supportedLocales` that is still work-in-progress
   *  (partially translated) — the language picker flags these. */
  wipLocales?: string[];
  stages: Array<{
    name: string;
    active: boolean;
    impact: 'safe' | 'hpoc-only';
    requires: string[];
    hasCheck: boolean;
    captures: string[];
  }>;
}

/** One row of the pack's reading menu. Nests one level, like the bootcamp. */
export interface PackNavItem {
  stage: string;
  title: string;
  /** Position in pack order — compared against the player's own position. */
  index: number;
  /** Validated against the cluster, so the menu marks it as a lab. */
  hasCheck: boolean;
  items: PackNavItem[];
}

export interface PackNavChapter {
  id: string;
  title: string;
  optional: boolean;
  items: PackNavItem[];
}

export interface PackNavPayload {
  chapters: PackNavChapter[];
}

export interface ScoreboardEntry {
  rank: number;
  sessionId: string;
  trigram: string | null;
  username: string | null;
  stageName: string | null;
  stagesPassed: number;
  /** Stages the engine gated for this session (e.g. destructive on `other`).
   *  Kept for telemetry — the percent display now divides by
   *  `effectiveTotalStages` (more accurate for in-progress sessions). */
  stagesDisabled: number;
  totalStages: number;
  /** Cluster-aware playable count — see backend doc. The percent display
   *  divides by this so an in-progress player doesn't dip to 92% when
   *  3 stages are filtered but not yet walked-past. */
  effectiveTotalStages: number;
  startedAt: number;
  finishedAt: number | null;
  lastActivityAt: number | null;
  status: 'playing' | 'finished';
}

export interface ScoreboardPayload {
  packId: string;
  packName: string;
  mode: 'mock' | 'live';
  totalStages: number;
  entries: ScoreboardEntry[];
}

/** Per-entry origin tag — `null` = this instance, string = peer label. */
export interface CombinedScoreboardEntry extends ScoreboardEntry {
  peerLabel: string | null;
}

export interface CombinedPeerStatus {
  id: number;
  label: string;
  baseUrl: string;
  enabled: boolean;
  ok: boolean;
  entryCount: number;
  error?: string;
  durationMs: number;
}

export interface CombinedScoreboardPayload {
  packId: string;
  packName: string;
  mode: 'mock' | 'live';
  totalStages: number;
  /** Cluster label for this instance — surfaced on local entries (entries
   *  with `peerLabel === null`) so the player can see which cluster
   *  they're on. `null` when no `SELF_LABEL` env var is set. */
  selfLabel: string | null;
  entries: CombinedScoreboardEntry[];
  /** One row per *enabled* peer — diagnostic for the admin view. */
  peerStatus: CombinedPeerStatus[];
}

export interface AdminPeerEntry {
  id: number;
  label: string;
  baseUrl: string;
  enabled: boolean;
  addedAt: number;
}

export interface AdminPeersPayload {
  entries: AdminPeerEntry[];
}

export interface AdminUserEntry {
  sessionId: string;
  trigram: string | null;
  username: string | null;
  pin: string | null;
  /** Name of the last completed stage; null = pre-game. */
  currentStage: string | null;
  /** Name of the stage the player is ABOUT to play. null when finished. */
  nextStageName: string | null;
  stagesPassed: number;
  /** Stages the engine gated for this session (capability missing,
   *  destructive-on-other, missing-upstream). Kept for telemetry —
   *  `effectiveTotalStages` is the denominator the UI uses for the
   *  Progress cell. */
  stagesDisabled: number;
  totalStages: number;
  /** Cluster-aware playable count — see backend doc. The Progress cell
   *  in /admin uses this as the denominator so an in-progress session
   *  doesn't display N/39 when 3 stages are filtered for cluster
   *  reasons but not yet walked-past. */
  effectiveTotalStages: number;
  startedAt: number;
  finishedAt: number | null;
  lastActivityAt: number | null;
  locale: string;
  /** Last failed check on the stage being played; null once it passes. */
  lastFail: { stage: string; detail: string | null; at: number } | null;
}

/** One row of the append-only check-attempt log (admin Logs tab). */
export interface AdminAttemptEntry {
  id: number;
  sessionId: string;
  trigram: string | null;
  username: string | null;
  stageName: string;
  status: 'passed' | 'failed';
  checkedAt: number;
  durationMs: number | null;
  detail: string | null;
}

export interface AdminUsersPayload {
  packId: string;
  packName: string;
  totalStages: number;
  entries: AdminUserEntry[];
}

export interface AdminGateEntry {
  stageName: string;
  unlocked: boolean;
  arrivedCount: number;
  totalActive: number;
  arrivedTrigrams: string[];
  unlockedAt: number | null;
}

export interface AdminGatesPayload {
  entries: AdminGateEntry[];
}

export interface AdminPackStageEntry {
  stageName: string;
  active: boolean;
  adminGate: boolean;
  /** Pack-declared `impact` ('safe' default, 'hpoc-only' filtered on
   *  shared clusters when `clusterProfile === 'other'`). */
  impact: 'safe' | 'hpoc-only';
  activeOverridden: boolean;
  adminGateOverridden: boolean;
  needs: string[];
  captures: string[];
  brokenMissingVars: string[];
  /** Always-enforced capability requirements. */
  requires: string[];
  /** Capability requirements only enforced when `clusterProfile === 'other'`. */
  requiresOnOther: string[];
  /** Caps the stage needs (after `requiresOnOther` overlay) that aren't
   *  active on the server — non-empty → gate will skip the stage. */
  missingCapabilities: string[];
}

export interface AdminPackPayload {
  packId: string;
  packName: string;
  stages: AdminPackStageEntry[];
  brokenCount: number;
  /** Server's runtime clusterProfile. */
  clusterProfile: 'hpoc' | 'other';
  /** Operator-facing server mode. `mock` bypasses the hpoc-only gate;
   *  `test` and `live` both hit a real PC. */
  mode: 'mock' | 'test' | 'live';
}

export interface AdminPackTogglePreview {
  requested: string;
  cascade: Array<{ stageName: string; missingVars: string[] }>;
}

export interface AdminPackConfigPayload {
  /** Portable string carrying every operator override. */
  config: string;
  packId: string;
  overriddenCount: number;
}

export interface AdminPackConfigImportResult {
  ok: true;
  packId: string;
  applied: string[];
  /** In the config, absent from this pack: stages deleted since the export. */
  missingStages: string[];
  /** In this pack, absent from the config: stages added since the export.
   *  Left at their JSON default. */
  newStages: string[];
  /** Local overrides the import wiped (it replaces, it doesn't merge). */
  clearedStages: string[];
  /** Stages the imported setup leaves active with no surviving producer. */
  brokenStages: string[];
}

export interface AdminLunchStatus {
  paused: boolean;
  pausedAt: number | null;
  affectedCount: number;
}

export interface AdminLanguageEntry {
  code: string;
  /** Pack manifest flags this locale as work-in-progress. */
  wip: boolean;
  /** Currently listed in the end-user language selector (given mode + override). */
  visible: boolean;
  /** Operator has enabled this WIP locale for `live`. Always false for non-WIP. */
  enabledInLive: boolean;
}

export interface AdminLanguagesPayload {
  mode: 'mock' | 'test' | 'live';
  defaultLocale: string;
  entries: AdminLanguageEntry[];
}

export interface VersionInfo {
  version: string;
  gitSha: string | null;
  branch: string | null;
  buildTime: string | null;
  /** `owner/repo`, used to fetch GitHub Releases for the changelog modal. */
  repo: string;
}

export const api = {
  version: () => get<VersionInfo>('/version'),
  createSession: (req: CreateSessionRequest) =>
    post<CreateSessionResponse>('/session', req),
  getSession: (id: string) => get<SessionSnapshot>(`/session/${id}`),
  advance: (id: string) => post<AdvanceResponse>(`/session/${id}/advance`),
  submitInput: (id: string, req: SubmitInputRequest) =>
    post<AdvanceResponse>(`/session/${id}/input`, req),
  /** Phase 2 of the two-phase check: run the check deferred by submitInput. */
  resolveCheck: (id: string) =>
    post<AdvanceResponse>(`/session/${id}/resolve-check`),
  skipTo: (id: string, stageName: string) =>
    post<{ skipped: string[]; finalStage: string | null }>(
      `/session/${id}/skip-to/${encodeURIComponent(stageName)}`,
    ),
  gotoStage: (id: string, stageName: string) =>
    post<{ currentStage: string | null }>(
      `/session/${id}/goto/${encodeURIComponent(stageName)}`,
    ),
  switchIdentity: (id: string) =>
    post<{ currentStage: string | null }>(`/session/${id}/switch-identity`),
  /**
   * Auto-play helper: fires the registered **act** handler for whatever stage
   * the session is currently awaiting on. Server-side gated to `test` mode
   * (403 in `mock`/`live`). See routes/stage.ts:act-current.
   */
  actCurrent: (id: string) =>
    post<{
      ok: boolean;
      stageName: string;
      durationMs: number;
      error?: string;
      /** True when the act failed at the network layer (PC unreachable). */
      transportError?: boolean;
      /** Lowest syscall code (`ENETUNREACH` / `ENOTFOUND` / …) when known. */
      transportCode?: string;
    }>(`/session/${id}/act-current`),
  /** Live cluster lookup for the awaiting named-var prompt (NodeSerial /
   *  NumberUpdates / Runway). 404 when the variable isn't auto-fillable
   *  (player must type manually). */
  autoFillCurrent: (id: string) =>
    post<{ ok: boolean; variable: string; value?: string; error?: string }>(
      `/session/${id}/auto-fill-current`,
    ),
  /** The pack's reading menu, titles already in the session's language.
   *  `chapters: []` for a pack that ships no menu. */
  nav: (id: string) => get<PackNavPayload>(`/session/${id}/nav`),
  /** A stage the player has already reached, re-rendered for re-reading.
   *  403 for anything ahead of them. Changes nothing server-side. */
  readStage: (id: string, stage: string) =>
    get<{ stage: string; units: MessageUnit[] }>(
      `/session/${id}/read/${encodeURIComponent(stage)}`,
    ),
  pack: () => get<PackInfo>('/pack'),
  scoreboard: () => get<ScoreboardPayload>('/scoreboard'),
  combinedScoreboard: () => get<CombinedScoreboardPayload>('/scoreboard/combined'),
  sshPing: (target: string, signal?: AbortSignal) =>
    post<{
      ok: boolean;
      target: string;
      exitCode: number | null;
      output: string[];
      durationMs: number;
      error?: string;
    }>('/ssh/ping', { target }, signal),
  sshTcp: (target: string, port = 22, signal?: AbortSignal) =>
    post<{
      ok: boolean;
      target: string;
      port: number;
      ip?: string;
      durationMs: number;
      error?: string;
    }>('/ssh/tcp', { target, port }, signal),
  adminLogin: (password: string) =>
    post<{ ok: true }>('/admin/login', { password }),
  adminUsers: (password: string) =>
    adminGet<AdminUsersPayload>('/admin/users', password),
  adminAttempts: (password: string) =>
    adminGet<{ entries: AdminAttemptEntry[] }>('/admin/attempts', password),
  adminDelete: (password: string, sessionId: string) =>
    adminDel<{ ok: true; sessionId: string }>(`/admin/users/${sessionId}`, password),
  adminSkipCurrentStage: (password: string, sessionId: string) =>
    adminPost<{
      ok: true;
      sessionId: string;
      skipped: string;
      currentStage: string | null;
    }>(`/admin/users/${sessionId}/skip-current-stage`, password),
  adminGates: (password: string) =>
    adminGet<AdminGatesPayload>('/admin/gates', password),
  adminUnlockGate: (password: string, stageName: string) =>
    adminPost<{ ok: true; stageName: string; unlocked: boolean }>(
      `/admin/gates/${encodeURIComponent(stageName)}/unlock`,
      password,
    ),
  adminLockGate: (password: string, stageName: string) =>
    adminPost<{ ok: true; stageName: string; unlocked: boolean }>(
      `/admin/gates/${encodeURIComponent(stageName)}/lock`,
      password,
    ),
  adminPack: (password: string) => adminGet<AdminPackPayload>('/admin/pack', password),
  adminPackToggle: (
    password: string,
    stageName: string,
    field: 'active' | 'adminGate',
    value: boolean | null,
  ) =>
    adminPost<{ ok: true; stageName: string; field: string; value: boolean | null }>(
      `/admin/pack/stages/${encodeURIComponent(stageName)}/toggle?field=${field}`,
      password,
      { value },
    ),
  adminPackConfig: (password: string) =>
    adminGet<AdminPackConfigPayload>('/admin/pack/config', password),
  adminPackConfigImport: (password: string, config: string) =>
    adminPost<AdminPackConfigImportResult>('/admin/pack/config', password, { config }),
  adminPackConfigReset: (password: string) =>
    adminPost<{ ok: true; cleared: number }>('/admin/pack/config/reset', password),
  adminPackPreviewDisable: (password: string, stageName: string) =>
    adminGet<AdminPackTogglePreview>(
      `/admin/pack/preview-disable/${encodeURIComponent(stageName)}`,
      password,
    ),
  adminLunchStatus: (password: string) =>
    adminGet<AdminLunchStatus>('/admin/lunch', password),
  adminLunchLock: (password: string) =>
    adminPost<{ ok: true; paused: true }>('/admin/lunch/lock', password),
  adminLunchUnlock: (password: string) =>
    adminPost<{ ok: true; paused: false }>('/admin/lunch/unlock', password),
  adminCleanupAll: (password: string, trigram: string) =>
    adminPost<{
      ok: true;
      trigram: string;
      cleanedStages: number;
      failures: number;
      results: Array<{ stage: string; ok: boolean; error?: string; durationMs: number }>;
    }>(`/act/cleanup-all/${encodeURIComponent(trigram)}`, password),
  adminClusterConfig: (password: string) =>
    adminGet<AdminClusterConfigPayload>('/admin/cluster-config', password),
  adminClusterConfigSave: (
    password: string,
    body: { discoverableNodeSerials?: string[]; lcmAvailableUpdates?: number | null },
  ) =>
    fetch('/api/admin/cluster-config', {
      method: 'PUT',
      headers: { 'X-Admin-Password': password, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((res) => handle<AdminClusterConfigPayload>(res)),
  adminClusterConfigRefresh: (password: string) =>
    adminPost<AdminClusterConfigPayload>('/admin/cluster-config/refresh', password),
  adminClusterStatus: (password: string) =>
    adminGet<AdminClusterStatusPayload>('/admin/cluster-status', password),
  adminClusterVersions: (password: string) =>
    adminGet<AdminClusterVersionsPayload>('/admin/cluster-versions', password),
  adminPeers: (password: string) =>
    adminGet<AdminPeersPayload>('/admin/peers', password),
  adminPeerAdd: (password: string, body: { label: string; baseUrl: string }) =>
    adminPost<AdminPeerEntry>('/admin/peers', password, body),
  adminPeerDelete: (password: string, id: number) =>
    adminDel<{ ok: true; id: number }>(`/admin/peers/${id}`, password),
  adminPeerToggle: (password: string, id: number, enabled: boolean) =>
    fetch(`/api/admin/peers/${id}`, {
      method: 'PATCH',
      headers: { 'X-Admin-Password': password, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).then((res) => handle<{ ok: true; id: number; enabled: boolean }>(res)),
  adminSelfLabel: (password: string) =>
    adminGet<{ label: string | null }>('/admin/self-label', password),
  adminSelfLabelSave: (password: string, label: string | null) =>
    fetch('/api/admin/self-label', {
      method: 'PUT',
      headers: { 'X-Admin-Password': password, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    }).then((res) => handle<{ label: string | null }>(res)),
  adminLanguages: (password: string) =>
    adminGet<AdminLanguagesPayload>('/admin/languages', password),
  adminLanguageToggle: (password: string, code: string, enabled: boolean) =>
    fetch(`/api/admin/languages/${encodeURIComponent(code)}`, {
      method: 'PUT',
      headers: { 'X-Admin-Password': password, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).then((res) => handle<AdminLanguagesPayload>(res)),
  adminPlannerConfig: (password: string) =>
    adminGet<AdminPlannerConfigPayload>('/admin/planner-config', password),
  adminPlannerConfigSave: (
    password: string,
    body: { oldPc?: string | null; oldPcUsername?: string | null; oldPcPassword?: string | null },
  ) =>
    fetch('/api/admin/planner-config', {
      method: 'PUT',
      headers: { 'X-Admin-Password': password, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((res) => handle<AdminPlannerConfigPayload>(res)),
  adminCapabilities: (password: string) =>
    adminGet<{ flags: string[] }>('/admin/capabilities', password),
  adminCapabilitiesRefresh: (password: string) =>
    adminPost<AdminCapabilitiesRefreshPayload>('/admin/capabilities/refresh', password),
  adminEmailConfig: (password: string) =>
    adminGet<AdminEmailConfigPayload>('/admin/email-config', password),
  adminEmailConfigSave: (
    password: string,
    body: {
      /** Omit to keep the stored token, null to forget it. */
      mailtrapToken?: string | null;
      fromEmail?: string | null;
      fromName?: string | null;
      vars?: Record<string, string>;
    },
  ) =>
    fetch('/api/admin/email-config', {
      method: 'PUT',
      headers: { 'X-Admin-Password': password, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((res) => handle<AdminEmailConfigPayload>(res)),
  /** Probes `token` when given (a draft the operator hasn't saved), else the stored one. */
  adminEmailDomains: (password: string, token?: string) =>
    adminPost<{
      domains: Array<{ domain: string; verified: boolean }>;
      unauthorized?: boolean;
      error?: string;
    }>('/admin/email-domains', password, token ? { token } : {}),
  adminEmailTemplates: (password: string) =>
    adminGet<{ templates: AdminEmailTemplate[] }>('/admin/email-templates', password),
  adminEmailTemplateSave: (
    password: string,
    id: string,
    locale: string,
    body: { subject: string; html: string },
  ) =>
    fetch(`/api/admin/email-templates/${id}/${locale}`, {
      method: 'PUT',
      headers: { 'X-Admin-Password': password, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((res) => handle<{ ok: true; overridden: boolean }>(res)),
  adminEmailTemplateReset: (password: string, id: string, locale: string) =>
    adminDel<{ ok: true }>(`/admin/email-templates/${id}/${locale}`, password),
  adminEmailRoster: (password: string) =>
    adminGet<{ entries: AdminEmailRosterEntry[] }>('/admin/email-roster', password),
  adminEmailRosterAdd: (password: string, emails: string[]) =>
    adminPost<{ added: number; skipped: number; entries: AdminEmailRosterEntry[] }>(
      '/admin/email-roster',
      password,
      { emails },
    ),
  adminEmailRosterDelete: (password: string, id: number) =>
    adminDel<{ ok: true; entries: AdminEmailRosterEntry[] }>(`/admin/email-roster/${id}`, password),
  adminEmailSend: (
    password: string,
    body: {
      templateId: string;
      locale: string;
      subject: string;
      html: string;
      vars: Record<string, string>;
      mode: 'pending' | 'rows' | 'test';
      rosterIds?: number[];
      testAddress?: string;
    },
  ) => adminPost<AdminEmailSendPayload>('/admin/email-send', password, body),
};

export interface AdminCapabilitiesRefreshPayload {
  flags: string[];
  added: string[];
  removed: string[];
  probed: Array<{
    flag: string;
    detected: boolean;
    detail: string;
    transportError?: boolean;
    transportCode?: string;
  }>;
}

export interface AdminEmailConfigPayload {
  /** A token is stored. The token itself never reaches the browser. */
  mailtrapTokenSet: boolean;
  fromEmail: string;
  fromName: string;
  vars: Record<string, string>;
  /** PE cluster name probed live ('' when unknown) — default for {CLUSTER}. */
  clusterName: string;
  /** PC admin password from the deploy env ('' when unknown) — default for {PASSWORD}. */
  pcPassword: string;
}

export interface AdminEmailTemplate {
  id: 'invitation-vdi' | 'summary';
  locale: 'en' | 'fr' | 'de';
  subject: string;
  html: string;
  variables: Record<string, string>;
  overridden: boolean;
}

export interface AdminEmailRosterEntry {
  id: number;
  seat: number;
  email: string;
  addedAt: number;
  /** templateId → sentAt of the last successful delivery. */
  sent: Record<string, number>;
}

export interface AdminEmailSendPayload {
  ok: boolean;
  sent: number;
  failed: number;
  results: Array<{ to: string; seat: number; ok: boolean; error?: string }>;
}

export interface AdminPlannerConfigPayload {
  oldPc: string;
  oldPcUsername: string;
  oldPcPassword: string;
}

export interface AdminClusterConfigPayload {
  discoverableNodeSerials: string[];
  lcmAvailableUpdates: number | null;
  /** What the stage-29 count logic reads off LCM right now (null in mock / on error). */
  lcmLive: { count: number; settled: boolean } | null;
  meta: {
    discoverableNodeSerials?: { source: 'probe' | 'admin'; updatedAt: number };
    lcmAvailableUpdates?: { source: 'probe' | 'admin'; updatedAt: number };
  };
}

export interface AdminClusterStatusPayload {
  intelligentOps: {
    /** `null` in mock mode or when the probe couldn't reach PC. */
    state: 'ENABLED' | 'DISABLED' | 'UNKNOWN' | null;
    /** Prism UI deep-link to the IOps activation screen. `null` when the
     *  PC endpoint isn't configured (mock fixtures or local-dev). */
    enableUrl: string | null;
    /** Human-readable error if `state` is null and the probe failed. */
    error?: string;
  };
}


export interface AdminClusterVersionsPayload {
  rows: Array<{
    component: string;
    version: string;
    location?: string;
    source: 'pc' | 'lcm';
  }>;
  /** Set when no source could answer (empty in mock mode, no error). */
  error?: string;
}
