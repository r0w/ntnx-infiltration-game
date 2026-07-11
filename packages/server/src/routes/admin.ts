import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { CapabilityFlag, NutanixClient } from '@ntnx-game/engine';
import { probeCapabilities, type CapabilityProbeDetail } from '@ntnx-game/nutanix';
import { HttpError, type SessionService } from '../session-service';
import { AttemptQueries, SessionQueries, ScoreboardPeerQueries, type AdminSessionRow, type AttemptRow, type ScoreboardPeerRow } from '../db/queries';
import type { LoadedPack } from '../pack-loader';
import { analyzeDeps, cascadeDisable, type BrokenStage } from '../dep-analysis';
import { probeClusterConfig } from '../cluster-config-probe';
import {
  probeClusterName,
  probeIntelligentOps,
  probeSoftwareVersions,
  type IntelligentOpsProbeResult,
  type SoftwareVersionsProbeResult,
} from '../cluster-status-probe';
import { consoleLogger } from '../logger';
import {
  EMAIL_TEMPLATES,
  listMailtrapDomains,
  sendMailtrapEmail,
} from '../email';
import { EmailRosterQueries, type ClusterConfigQueries, type EmailRosterRow } from '../db/queries';
import { EMAIL_RE, substituteSeat, substituteVars } from '@ntnx-game/shared';

export interface AdminRoutesDeps {
  db: Database;
  pack: LoadedPack;
  /** Read from config; default `nutanix/4u`. See config.ts for rationale. */
  adminPassword: string;
  /**
   * Required for gate management — the admin endpoints need to flip the
   * service's in-memory unlock set, not just the DB row, otherwise running
   * sessions wouldn't see the change until the next server restart.
   */
  service: SessionService;
  /** Required for the /cluster-config refresh endpoint to re-probe live. */
  nutanix: NutanixClient;
  /** Operator-facing server mode (`mock | test | live`). Surfaced on
   *  /pack so the admin badge matches what the player sees and the
   *  install BP's MODE variable. Distinct from `nutanix.mode` (transport
   *  layer — `mock | live`) which collapses `test` and `live` together. */
  serverMode: 'mock' | 'test' | 'live';
  /** Runtime clusterProfile (post mock-override). Surfaced on /pack. */
  clusterProfile: 'hpoc' | 'other';
  /** Boot-time capability flags from the cluster probe. Used by the
   *  `/pack` table to mark stages that would be skipped by the gate
   *  for missing caps in the current profile. */
  capabilities: CapabilityFlag[];
  /** Configured PC endpoint (e.g. `https://10.8.16.7:9440`). Used by
   *  `/cluster-status` to build the Prism UI deep-link to the IOps
   *  activation page. May be empty in mock mode. */
  pcEndpoint: string;
  /** PC admin password from the deploy env. Seeds the invitation's
   *  {PASSWORD}: the VDI accounts use it too. Empty outside a deploy. */
  pcPassword?: string;
  /** Test seam for /email-send — defaults to the real Mailtrap call. */
  sendEmail?: typeof sendMailtrapEmail;
}

export interface AdminClusterStatusPayload {
  intelligentOps: IntelligentOpsProbeResult;
}

// Per-field cluster_config semantics shared by /planner-config and
// /email-config: string sets (trimmed), null or empty string clears,
// missing key leaves the stored value untouched. Callers must run
// assertStringField on EVERY field before applying any, so a 400 never
// leaves a partial write.
function assertStringField(incoming: unknown, key: string): void {
  if (incoming !== undefined && incoming !== null && typeof incoming !== 'string') {
    throw new HttpError(400, `${key} must be a string or null`);
  }
}
function applyStringField(cfg: ClusterConfigQueries, incoming: unknown, key: string): void {
  if (incoming === undefined) return;
  if (incoming === null || (typeof incoming === 'string' && incoming.trim() === '')) {
    cfg.delete(key);
  } else if (typeof incoming === 'string') {
    cfg.set(key, incoming.trim(), 'admin');
  }
}

export type AdminClusterVersionsPayload = SoftwareVersionsProbeResult;

export interface AdminEmailConfigPayload {
  /** Whether a token is stored. The token itself is write-only: it never
   *  leaves the server, so an operator screen-sharing /admin can't leak it. */
  mailtrapTokenSet: boolean;
  fromEmail: string;
  fromName: string;
  /** Last-used template variable values ({CLUSTER}, {PASSWORD}, …), persisted per deployment. */
  vars: Record<string, string>;
  /** PE cluster name probed from the live PC (e.g. `DM3-POC004`) — seeds
   *  {CLUSTER}. '' when unknown (mock mode / probe failed). */
  clusterName: string;
  /** The PC admin password the operator typed at blueprint launch — the
   *  VDI accounts share it, so it seeds {PASSWORD}. '' outside a
   *  blueprint deploy (dev, mock). */
  pcPassword: string;
}

export interface AdminEmailTemplatePayload {
  id: string;
  locale: string;
  subject: string;
  html: string;
  variables: Record<string, string>;
  /** True when the operator saved a deployment-local edit of this template. */
  overridden: boolean;
}

export interface AdminEmailSendPayload {
  ok: boolean;
  sent: number;
  failed: number;
  results: Array<{ to: string; seat: number; ok: boolean; error?: string }>;
}

export interface AdminClusterConfigPayload {
  discoverableNodeSerials: string[];
  lcmAvailableUpdates: number | null;
  /** Per-row metadata so /admin can show "edited by operator" vs probe-set. */
  meta: {
    discoverableNodeSerials?: { source: 'probe' | 'admin'; updatedAt: number };
    lcmAvailableUpdates?: { source: 'probe' | 'admin'; updatedAt: number };
  };
}

export interface AdminUserEntry
  extends Omit<AdminSessionRow, 'lastFailStage' | 'lastFailDetail' | 'lastFailAt'> {
  /** Name of the stage the player is ABOUT to play (i.e. after currentStage). */
  nextStageName: string | null;
  /**
   * Last failed check on a stage still ahead of the player, so the operator
   * can see what's missing without walking over. null once the stage passes
   * (the history row flips to 'passed') or when the player moved past it
   * (admin skip).
   */
  lastFail: { stage: string; detail: string | null; at: number } | null;
  totalStages: number;
  /** Stages this cluster will let a fresh session actually play (raw pack
   *  total minus stages filtered for cluster reasons — capability missing,
   *  destructive-on-other, pack-disabled by overlay). Same for every entry
   *  on a given snapshot; per-entry to keep the row self-contained. Used
   *  as the denominator in the "Progress" cell so a player who legitimately
   *  passed everything reachable shows N/N instead of N/39. */
  effectiveTotalStages: number;
}

export interface AdminGateEntry {
  stageName: string;
  unlocked: boolean;
  /**
   * Active sessions (finished_at IS NULL) whose current position is at or
   * past the stage just before this gate — i.e. anyone who has reached
   * this gate or already passed through it. Broader than strict "parked
   * at the gate" so the operator sees the full progress picture.
   */
  arrivedCount: number;
  /** All non-finished sessions in the pack — denominator for the % display. */
  totalActive: number;
  /**
   * Trigrams (or Usernames as fallback) of the players in arrivedCount,
   * sorted alpha. Surfaced as a tooltip on the count so the operator can
   * see WHO has arrived without leaving the page.
   */
  arrivedTrigrams: string[];
  /** When `unlocked === true`, ms-since-epoch the unlock was recorded. */
  unlockedAt: number | null;
}

export interface AdminPackStageEntry {
  stageName: string;
  /** Effective active value after overlay (what the runner uses). */
  active: boolean;
  /** Effective adminGate value after overlay. */
  adminGate: boolean;
  /** Pack-declared `impact` ('safe' default, 'hpoc-only' filtered on
   *  shared clusters). Surfaced so the operator can see at a glance which
   *  stages would skip when `clusterProfile === 'other'`. */
  impact: 'safe' | 'hpoc-only';
  /** True iff the operator has overridden `active` (vs using the JSON value). */
  activeOverridden: boolean;
  /** True iff the operator has overridden `adminGate`. */
  adminGateOverridden: boolean;
  /** Stage's declared `needs` (variables it consumes from upstream). */
  needs: string[];
  /** Stage's declared `captures` (variables it produces). */
  captures: string[];
  /** Vars in `needs` that have no surviving producer in the effective pack. */
  brokenMissingVars: string[];
  /** Always-enforced capability requirements. */
  requires: string[];
  /** Capability requirements only enforced when `clusterProfile === 'other'`. */
  requiresOnOther: string[];
  /** Caps from `requires` (always) + `requiresOnOther` (only when
   *  `clusterProfile === 'other'`) that are NOT currently activated on the
   *  server. Non-empty → the gate will skip this stage at session-create
   *  with `reason: 'missing-capability'`. The admin UI uses this to render
   *  a `skipped (needs …)` status badge. */
  missingCapabilities: string[];
}

export interface AdminPackPayload {
  packId: string;
  packName: string;
  stages: AdminPackStageEntry[];
  /** Total broken stages — quick top-of-page indicator for the operator. */
  brokenCount: number;
  /** Server's runtime clusterProfile. New sessions inherit this; combined
   *  with each stage's `impact` it tells the operator which stages would
   *  be auto-skipped at session creation. */
  clusterProfile: 'hpoc' | 'other';
  /** Server mode (mock | test | live). In `mock` the hpoc-only gate is
   *  bypassed (clusterProfile is forced to `hpoc` at boot) — surface this
   *  so the /admin pack table can mute the "would be filtered" callout
   *  and the operator badge matches the BP's MODE variable. */
  mode: 'mock' | 'test' | 'live';
}

export interface AdminPackTogglePreview {
  /** What the operator originally asked to disable. */
  requested: string;
  /** Stages that would also become broken if `requested` were turned off. */
  cascade: BrokenStage[];
}

export interface AdminLunchStatus {
  paused: boolean;
  /** ms-since-epoch the pause was engaged, or null when running. */
  pausedAt: number | null;
  /** Active sessions that would be (or are) blocked by the lock. */
  affectedCount: number;
}

/**
 * `/api/admin` — operator tools for event-day ops. Gated by a single shared
 * password (`ADMIN_PASSWORD` env). The password travels in the
 * `X-Admin-Password` header; validation is a plain string equality (no
 * hashing, no timing-safe compare) because this isn't a security boundary
 * against a capable adversary — it's a "don't let a curious player nuke
 * sessions" guard on a trusted LAN.
 */
export function buildAdminRoutes(deps: AdminRoutesDeps): Hono {
  const router = new Hono();
  // Local HttpError → JSON bridge so the sub-router behaves correctly in
  // isolation (used by tests). The top-level app.onError also catches these
  // when mounted via `app.route(...)`, but each layer wraps the previous,
  // and Hono only runs the innermost handler — so we need one here.
  router.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 400 | 401 | 404 | 500);
    }
    throw err;
  });
  const sessions = new SessionQueries(deps.db);
  const attempts = new AttemptQueries(deps.db);
  const totalStages = deps.pack.stages.length;
  // Position of each stage in the effective pack order — used to answer
  // "next stage after N" and "has session arrived at stage X?" without
  // re-scanning the array.
  const positionOf = (name: string | null | undefined): number => {
    if (!name) return -1;
    const stages = deps.service.listEffectiveStages();
    for (let i = 0; i < stages.length; i++) if (stages[i]!.name === name) return i;
    return -1;
  };

  // POST /login validates the password without mutating anything — used by
  // the frontend to check the stashed password is still good before rendering
  // the user list. Also lets the UI surface a clear "wrong password" state
  // instead of failing on the first resource-level call.
  router.post('/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    if (typeof body.password !== 'string' || body.password !== deps.adminPassword) {
      throw new HttpError(401, 'invalid admin password');
    }
    return c.json({ ok: true });
  });

  // Auth middleware for every other route. Header name matches the one the
  // frontend adds in api.ts; rejecting with 401 lets the UI kick back to the
  // login form.
  router.use('*', async (c, next) => {
    const header = c.req.header('x-admin-password');
    if (header !== deps.adminPassword) {
      throw new HttpError(401, 'admin auth required');
    }
    await next();
  });

  router.get('/users', (c) => {
    const effective = deps.service.listEffectiveStages();
    const rows = sessions.listAdmin(deps.pack.manifest.id);
    // Compute once per request — same value for every row on this snapshot.
    const effectiveTotalStages = deps.service.effectivePlayableCount(
      deps.capabilities ?? [],
      deps.clusterProfile,
    );
    const entries: AdminUserEntry[] = rows.map((row) => {
      const { lastFailStage, lastFailDetail, lastFailAt, ...rest } = row;
      let nextStageName: string | null = null;
      if (row.finishedAt === null) {
        const curIdx = positionOf(row.currentStage);
        const nextIdx = curIdx + 1;
        nextStageName = nextIdx < effective.length ? (effective[nextIdx]?.name ?? null) : null;
      }
      // Surface the fail only while its stage is still ahead of the player.
      // Position-based (not `=== nextStageName`): per-session disabled stages
      // can sit between currentStage and the one actually being played. An
      // admin skip lands currentStage ON the failed stage → hidden.
      const lastFail =
        row.finishedAt === null &&
        lastFailStage !== null &&
        lastFailAt !== null &&
        positionOf(lastFailStage) > positionOf(row.currentStage)
          ? { stage: lastFailStage, detail: lastFailDetail, at: lastFailAt }
          : null;
      return {
        ...rest,
        nextStageName,
        lastFail,
        totalStages,
        effectiveTotalStages,
      };
    });
    return c.json({
      packId: deps.pack.manifest.id,
      packName: deps.pack.manifest.name,
      totalStages,
      entries,
    });
  });

  // Append-only trail of check attempts (newest first) — the Logs tab.
  // stage_history keeps only each stage's latest state; this keeps the story.
  router.get('/attempts', (c) => {
    const raw = Number(c.req.query('limit') ?? 200);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 1000) : 200;
    const entries: AttemptRow[] = attempts.listRecent(deps.pack.manifest.id, limit);
    return c.json({ entries });
  });

  router.delete('/users/:id', (c) => {
    const id = c.req.param('id');
    const changed = sessions.deleteById(id);
    if (changed === 0) throw new HttpError(404, 'session not found');
    return c.json({ ok: true, sessionId: id });
  });

  // Admin escape hatch: bump a player past the stage they're currently
  // playing without them having to satisfy the check. Use case: a stage
  // is unwinnable on this cluster (capability missing, API regressed,
  // narrative blocker, …) and the operator wants the player to keep
  // progressing. Reuses the existing `service.gotoStage` semantics —
  // the skipped stage gets NO `stage_history` row, so `stagesPassed`
  // (the score) is not incremented for it. Cleanly distinguishes
  // "skipped by admin" from "passed legitimately".
  //
  // Mechanics: gotoStage(target) sets currentStage = target - 1. To
  // skip the stage the player is about to play (= currentStage + 1),
  // we target currentStage + 2. End-of-pack edge cases (no next stage,
  // or skip would land past the last stage) return 400 — admin should
  // delete-and-restart or accept the player as finished instead.
  router.post('/users/:id/skip-current-stage', (c) => {
    const sid = c.req.param('id');
    const session = deps.service.getSession(sid); // throws 404 if not found
    if (session.finishedAt !== null) {
      throw new HttpError(400, 'session already finished');
    }
    const effective = deps.service.listEffectiveStages();
    const curIdx = positionOf(session.currentStage);
    const skipIdx = curIdx + 1;
    if (skipIdx >= effective.length) {
      throw new HttpError(400, 'player has no next stage to skip');
    }
    const skippedName = effective[skipIdx]!.name;
    const targetIdx = skipIdx + 1;
    if (targetIdx >= effective.length) {
      throw new HttpError(
        400,
        `cannot skip the final stage '${skippedName}'; delete the session or let the player finish`,
      );
    }
    const targetName = effective[targetIdx]!.name;
    const r = deps.service.gotoStage(sid, targetName);
    return c.json({ ok: true, sessionId: sid, skipped: skippedName, ...r });
  });

  // ─── gates ──────────────────────────────────────────────────────────
  // Stages with adminGate=true (after overlay) are listed here. We read
  // from `service.listEffectiveStages()` — NOT from the JSON-loaded
  // `deps.pack.stages` — so that gates the operator toggled on via the
  // pack tab also surface here. Same story for unlock/lock: the validity
  // check uses the effective adminGate value.
  router.get('/gates', (c) => {
    const unlocked = new Set(deps.service.listUnlockedGates());
    const allSessions = sessions.listAdmin(deps.pack.manifest.id);
    const active = allSessions.filter((s) => s.finishedAt === null);
    const totalActive = active.length;
    const unlockedAtByName = new Map(
      deps.service.gateUnlocks
        .list(deps.pack.manifest.id)
        .map((r) => [r.stageName, r.unlockedAt]),
    );
    const effective = deps.service.listEffectiveStages();
    const entries: AdminGateEntry[] = effective
      .filter((s) => s.adminGate)
      .map((s) => {
        const gateIdx = s.index;
        const arrived = active.filter((sess) => positionOf(sess.currentStage) >= gateIdx - 1);
        const arrivedTrigrams = arrived
          .map((sess) => sess.trigram ?? sess.username ?? `?${sess.sessionId.slice(0, 4)}`)
          .sort((a, b) => a.localeCompare(b));
        return {
          stageName: s.name,
          unlocked: unlocked.has(s.name),
          arrivedCount: arrived.length,
          totalActive,
          arrivedTrigrams,
          unlockedAt: unlockedAtByName.get(s.name) ?? null,
        };
      });
    // Sort so the leftmost card is always the operator's most-actionable
    // gate. Tier 0 = locked + everyone has arrived (perfect unlock moment).
    // Tier 1 = locked + some have arrived (decision call). Tier 2 = locked
    // + no one yet (way upcoming). Tier 3 = unlocked (already opened, kept
    // around for re-lock). Within each tier, pack order wins so the next
    // narrative beat surfaces first.
    const tier = (e: AdminGateEntry): number => {
      if (e.unlocked) return 3;
      if (e.totalActive > 0 && e.arrivedCount === e.totalActive) return 0;
      if (e.arrivedCount > 0) return 1;
      return 2;
    };
    entries.sort(
      (a, b) => tier(a) - tier(b) || positionOf(a.stageName) - positionOf(b.stageName),
    );
    return c.json({ entries });
  });

  router.post('/gates/:stageName/unlock', (c) => {
    const stageName = c.req.param('stageName');
    const stage = deps.service.listEffectiveStages().find((s) => s.name === stageName);
    if (!stage) throw new HttpError(404, 'stage not found');
    if (!stage.adminGate) throw new HttpError(400, 'stage has no adminGate');
    deps.service.setGateUnlock(stageName, true);
    return c.json({ ok: true, stageName, unlocked: true });
  });

  router.post('/gates/:stageName/lock', (c) => {
    const stageName = c.req.param('stageName');
    const stage = deps.service.listEffectiveStages().find((s) => s.name === stageName);
    if (!stage) throw new HttpError(404, 'stage not found');
    if (!stage.adminGate) throw new HttpError(400, 'stage has no adminGate');
    deps.service.setGateUnlock(stageName, false);
    return c.json({ ok: true, stageName, unlocked: false });
  });

  // ─── pack editor ───────────────────────────────────────────────────
  // Full pack listing with effective overlay state + broken-dep markers.
  // The operator uses this to flip stages on/off; toggling persists via
  // pack_overlay and the service rebuilds its runner so live sessions
  // pick up the change on their next advance().
  router.get('/pack', (c) => {
    const baseStages = deps.service.listBaseStages();
    const effective = deps.service.listEffectiveStages();
    const overlay = new Map(
      deps.service.packOverlay.list(deps.pack.manifest.id).map((r) => [r.stageName, r]),
    );
    const analysis = analyzeDeps({ stages: effective });
    const brokenByName = new Map(analysis.broken.map((b) => [b.stageName, b]));
    const baseByName = new Map(baseStages.map((s) => [s.name, s]));

    // Merge boot-probed caps with dynamic ones (currently only
    // PlannerCluster — flips on when admin saves the Planner creds in
    // cluster_config). Mirrors session-service.create() so the badges
    // shown here match the gate the next session will actually hit.
    // `new Set(undefined)` is the historical undefined-tolerant guard
    // (some test harnesses build deps without `capabilities`).
    const activeCaps = new Set<CapabilityFlag>(deps.capabilities ?? []);
    for (const c of deps.service.computeDynamicCapabilities()) activeCaps.add(c);
    const stagesPayload: AdminPackStageEntry[] = effective.map((s) => {
      const o = overlay.get(s.name);
      const base = baseByName.get(s.name);
      const requires = s.requires ?? [];
      const requiresOnOther = s.requiresOnOther ?? [];
      // Mirror the capability-gate logic: requires is always enforced;
      // requiresOnOther only when the runtime cluster is shared. The admin
      // table reports what WOULD happen for a new session on this server,
      // so we evaluate against the boot-time profile + caps.
      const effectiveRequires = deps.clusterProfile === 'other'
        ? [...requires, ...requiresOnOther]
        : requires;
      const missingCapabilities = effectiveRequires.filter((c) => !activeCaps.has(c));
      return {
        stageName: s.name,
        active: s.active,
        adminGate: s.adminGate ?? false,
        impact: s.impact ?? 'safe',
        activeOverridden: !!o && o.active !== null && o.active !== (base?.active ?? true),
        adminGateOverridden: !!o && o.adminGate !== null && o.adminGate !== (base?.adminGate ?? false),
        needs: s.needs ?? [],
        captures: s.captures ?? [],
        brokenMissingVars: brokenByName.get(s.name)?.missingVars ?? [],
        requires,
        requiresOnOther,
        missingCapabilities,
      };
    });

    const payload: AdminPackPayload = {
      packId: deps.pack.manifest.id,
      packName: deps.pack.manifest.name,
      stages: stagesPayload,
      brokenCount: analysis.broken.length,
      clusterProfile: deps.clusterProfile,
      mode: deps.serverMode,
    };
    return c.json(payload);
  });

  // POST /pack/stages/:name/toggle?field=active|adminGate
  // Body: { value: boolean | null }   (null = clear override → JSON default)
  router.post('/pack/stages/:name/toggle', async (c) => {
    const stageName = c.req.param('name');
    const field = c.req.query('field');
    if (field !== 'active' && field !== 'adminGate') {
      throw new HttpError(400, "field must be 'active' or 'adminGate'");
    }
    const baseStage = deps.pack.stages.find((s) => s.name === stageName);
    if (!baseStage) throw new HttpError(404, 'stage not found');
    const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    if (body.value !== null && typeof body.value !== 'boolean') {
      throw new HttpError(400, 'value must be boolean or null');
    }
    deps.service.packOverlay.setField(deps.pack.manifest.id, stageName, field, body.value);
    deps.service.applyEffectiveStages();
    return c.json({ ok: true, stageName, field, value: body.value });
  });

  // ─── lunch lock (pack-wide pause) ──────────────────────────────────
  // Always-on toggle the operator can flip whenever — the player session
  // finishes the current stage, the next advance returns kind='gated'
  // with reason='global', the player polls every 3 s until unlock.
  router.get('/lunch', (c) => {
    const info = deps.service.globalPauseInfo();
    const active = sessions
      .listAdmin(deps.pack.manifest.id)
      .filter((s) => s.finishedAt === null);
    const status: AdminLunchStatus = {
      paused: info !== null,
      pausedAt: info?.pausedAt ?? null,
      affectedCount: active.length,
    };
    return c.json(status);
  });

  router.post('/lunch/lock', (c) => {
    deps.service.setGlobalPause(true);
    return c.json({ ok: true, paused: true });
  });

  router.post('/lunch/unlock', (c) => {
    deps.service.setGlobalPause(false);
    return c.json({ ok: true, paused: false });
  });

  // GET /pack/preview-disable/:name — returns the cascade closure of also
  // disabling this stage. Lets the UI show the operator a confirmation
  // modal listing what else would break before they commit.
  router.get('/pack/preview-disable/:name', (c) => {
    const stageName = c.req.param('name');
    const stage = deps.pack.stages.find((s) => s.name === stageName);
    if (!stage) throw new HttpError(404, 'stage not found');
    const effective = deps.service.listEffectiveStages();
    const r = cascadeDisable(effective, new Set([stageName]));
    const preview: AdminPackTogglePreview = { requested: stageName, cascade: r.cascade };
    return c.json(preview);
  });

  // ─── cluster config (cached snapshot of slow PC queries) ────────────
  // Boot-populated, manually overridable. CheckNewNode and CheckUpdates
  // read from here to skip the discover-unconfigured-nodes / LCM-inventory
  // live calls.
  function readClusterConfig(): AdminClusterConfigPayload {
    const rows = deps.service.clusterConfig.list();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const serialsRow = byKey.get('discoverable_node_serials');
    const lcmRow = byKey.get('lcm_available_updates');
    const serials = Array.isArray(serialsRow?.value)
      ? (serialsRow!.value.filter((s) => typeof s === 'string') as string[])
      : [];
    const lcm = typeof lcmRow?.value === 'number' ? lcmRow.value : null;
    return {
      discoverableNodeSerials: serials,
      lcmAvailableUpdates: lcm,
      meta: {
        ...(serialsRow
          ? {
              discoverableNodeSerials: { source: serialsRow.source, updatedAt: serialsRow.updatedAt },
            }
          : {}),
        ...(lcmRow
          ? { lcmAvailableUpdates: { source: lcmRow.source, updatedAt: lcmRow.updatedAt } }
          : {}),
      },
    };
  }

  router.get('/cluster-config', (c) => c.json(readClusterConfig()));

  router.put('/cluster-config', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      discoverableNodeSerials?: unknown;
      lcmAvailableUpdates?: unknown;
    };
    if ('discoverableNodeSerials' in body) {
      if (!Array.isArray(body.discoverableNodeSerials)) {
        throw new HttpError(400, 'discoverableNodeSerials must be an array of strings');
      }
      const serials = body.discoverableNodeSerials
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      deps.service.clusterConfig.set('discoverable_node_serials', serials, 'admin');
    }
    if ('lcmAvailableUpdates' in body) {
      const v = body.lcmAvailableUpdates;
      if (v === null) {
        // Allow explicit null to clear → fall back to live query at check time.
        deps.service.clusterConfig.delete('lcm_available_updates');
      } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        deps.service.clusterConfig.set('lcm_available_updates', Math.floor(v), 'admin');
      } else {
        throw new HttpError(400, 'lcmAvailableUpdates must be a non-negative integer or null');
      }
    }
    return c.json(readClusterConfig());
  });

  router.post('/cluster-config/refresh', async (c) => {
    if (deps.nutanix.mode !== 'live') {
      throw new HttpError(400, `cluster-config refresh disabled in ${deps.nutanix.mode} mode`);
    }
    // Force-refresh: drop existing rows so the probe re-populates from
    // the cluster (the probe's setIfAbsent semantics protect operator
    // edits, but here the operator explicitly asked to re-fetch).
    deps.service.clusterConfig.delete('discoverable_node_serials');
    deps.service.clusterConfig.delete('lcm_available_updates');
    await probeClusterConfig({
      nutanix: deps.nutanix,
      cfg: deps.service.clusterConfig,
      logger: consoleLogger,
    });
    return c.json(readClusterConfig());
  });

  // ─── scoreboard peers ───────────────────────────────────────────────
  // Admin-curated list of peer instances whose `/api/scoreboard` is
  // merged into this server's `/api/scoreboard/combined`. baseUrl is the
  // peer game's HTTP base (e.g. `http://10.55.89.44:3000`); the combined
  // endpoint appends `/api/scoreboard` itself. No URL-reachability check
  // on insert — the combined endpoint's `peerStatus[]` surfaces broken
  // peers in real time, which is more honest than a one-time probe.
  const peers = new ScoreboardPeerQueries(deps.db);

  // Self-label = the name surfaced on this instance's own entries in
  // the combined view (so the player can spot their own cluster vs
  // peer-fetched ones). Persisted in cluster_config so a restart keeps
  // the operator's value; same key the /combined route reads.
  router.get('/self-label', (c) => {
    const label = deps.service.clusterConfig.get<string>('self_label') ?? null;
    return c.json({ label });
  });

  router.put('/self-label', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown };
    if (body.label === null || body.label === '') {
      deps.service.clusterConfig.delete('self_label');
      return c.json({ label: null });
    }
    if (typeof body.label !== 'string') {
      throw new HttpError(400, 'label must be a string or null');
    }
    const trimmed = body.label.trim();
    if (!trimmed) {
      deps.service.clusterConfig.delete('self_label');
      return c.json({ label: null });
    }
    deps.service.clusterConfig.set('self_label', trimmed, 'admin');
    return c.json({ label: trimmed });
  });

  function rowToPeer(r: ScoreboardPeerRow) {
    return {
      id: r.id,
      label: r.label,
      baseUrl: r.baseUrl,
      enabled: r.enabled,
      addedAt: r.addedAt,
    };
  }

  router.get('/peers', (c) => c.json({ entries: peers.list().map(rowToPeer) }));

  router.post('/peers', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      label?: unknown;
      baseUrl?: unknown;
    };
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    if (!label) throw new HttpError(400, 'label is required');
    if (!baseUrl) throw new HttpError(400, 'baseUrl is required');
    // Accept http(s)://host[:port] with optional path; reject anything that
    // doesn't parse. We strip any trailing slash in the route handler so
    // the stored value is canonical.
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new HttpError(400, 'baseUrl must be a valid http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new HttpError(400, 'baseUrl protocol must be http or https');
    }
    const canonical = baseUrl.replace(/\/+$/, '');
    try {
      const row = peers.add(label, canonical);
      return c.json(rowToPeer(row));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(msg)) {
        throw new HttpError(409, `peer with baseUrl ${canonical} already exists`);
      }
      throw err;
    }
  });

  router.delete('/peers/:id', (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) throw new HttpError(400, 'invalid peer id');
    const ok = peers.remove(id);
    if (!ok) throw new HttpError(404, `peer ${id} not found`);
    return c.json({ ok: true, id });
  });

  router.patch('/peers/:id', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) throw new HttpError(400, 'invalid peer id');
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      throw new HttpError(400, 'enabled must be a boolean');
    }
    const ok = peers.setEnabled(id, body.enabled);
    if (!ok) throw new HttpError(404, `peer ${id} not found`);
    return c.json({ ok: true, id, enabled: body.enabled });
  });

  // ─── Planner (secondary PC) creds ────────────────────────────────────
  // Persisted in cluster_config; consumed by session-service.create() to
  // (1) compute the PlannerCluster capability flag (gates stages 31 +
  // 32 in the pack) and (2) project the 3 vars (OldPC / OldPCUsername /
  // OldPCPassword) into per-session variables so CheckRunway has a
  // current creds set. Editing here re-enables those stages on fresh
  // sessions without a server restart.
  router.get('/planner-config', (c) => {
    const cfg = deps.service.clusterConfig;
    return c.json({
      oldPc: cfg.get<string>('old_pc') ?? '',
      oldPcUsername: cfg.get<string>('old_pc_username') ?? '',
      oldPcPassword: cfg.get<string>('old_pc_password') ?? '',
    });
  });

  router.put('/planner-config', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      oldPc?: unknown;
      oldPcUsername?: unknown;
      oldPcPassword?: unknown;
    };
    const cfg = deps.service.clusterConfig;
    assertStringField(body.oldPc, 'oldPc');
    assertStringField(body.oldPcUsername, 'oldPcUsername');
    assertStringField(body.oldPcPassword, 'oldPcPassword');
    applyStringField(cfg, body.oldPc, 'old_pc');
    applyStringField(cfg, body.oldPcUsername, 'old_pc_username');
    applyStringField(cfg, body.oldPcPassword, 'old_pc_password');
    return c.json({
      oldPc: cfg.get<string>('old_pc') ?? '',
      oldPcUsername: cfg.get<string>('old_pc_username') ?? '',
      oldPcPassword: cfg.get<string>('old_pc_password') ?? '',
    });
  });

  // ─── Participant emails (issue #30) ──────────────────────────────────
  // Operator-sent invitations / lab summaries, composed and fired from
  // the /admin Emails tab. Sender identity = a Mailtrap Send API token +
  // a from-address on a domain verified in that Mailtrap account; both
  // persisted in cluster_config so each operator wires their own after
  // deploy. Recipients live on a seat-numbered roster (email ↔ VDI
  // account) and each template type is one-shot per participant.
  const roster = new EmailRosterQueries(deps.db);
  const sendEmail = deps.sendEmail ?? sendMailtrapEmail;
  const emailTplKey = (id: string, locale: string) => `email_tpl:${id}.${locale}`;
  const findTemplate = (id: unknown, locale: unknown) =>
    EMAIL_TEMPLATES.find((t) => t.id === id && t.locale === locale);

  const emailConfigPayload = (): AdminEmailConfigPayload => {
    const cfg = deps.service.clusterConfig;
    return {
      mailtrapTokenSet: (cfg.get<string>('mailtrap_token') ?? '') !== '',
      fromEmail: cfg.get<string>('email_from') ?? '',
      fromName: cfg.get<string>('email_from_name') ?? '',
      vars: cfg.get<Record<string, string>>('email_vars') ?? {},
      clusterName: cfg.get<string>('cluster_name') ?? '',
      pcPassword: deps.pcPassword ?? '',
    };
  };

  // Deployments that composed an invitation before the {PASSWORD} fix saved
  // the cluster name as the password. Drop that row so the composer falls
  // back to the PC admin password instead of re-sending the wrong one.
  const dropStalePasswordVar = () => {
    const cfg = deps.service.clusterConfig;
    const clusterName = cfg.get<string>('cluster_name');
    const vars = cfg.get<Record<string, string>>('email_vars');
    if (!deps.pcPassword || !clusterName || vars?.PASSWORD !== clusterName) return;
    const { PASSWORD: _stale, ...rest } = vars;
    cfg.set('email_vars', rest, 'admin');
    consoleLogger.info('dropped stale email {PASSWORD} var (held the cluster name)');
  };

  // Probe the PE cluster name once per boot and cache it in cluster_config
  // (setIfAbsent, so an operator edit — if we ever add one — stays sticky).
  // The boot-scoped flag also memoizes a null verdict: without it, a PC
  // with no eligible cluster would re-fire the live probe on every GET.
  let clusterNameProbeDone = false;
  router.get('/email-config', async (c) => {
    const cfg = deps.service.clusterConfig;
    if (!clusterNameProbeDone && cfg.get<string>('cluster_name') === undefined) {
      clusterNameProbeDone = true;
      const name = await probeClusterName({ nutanix: deps.nutanix, logger: consoleLogger });
      if (name) cfg.setIfAbsent('cluster_name', name);
    }
    dropStalePasswordVar();
    return c.json(emailConfigPayload());
  });

  router.put('/email-config', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      mailtrapToken?: unknown;
      fromEmail?: unknown;
      fromName?: unknown;
      vars?: unknown;
    };
    const cfg = deps.service.clusterConfig;
    // Validate everything before writing anything (no partial writes).
    assertStringField(body.mailtrapToken, 'mailtrapToken');
    assertStringField(body.fromEmail, 'fromEmail');
    assertStringField(body.fromName, 'fromName');
    if (
      body.vars !== undefined &&
      (body.vars === null ||
        typeof body.vars !== 'object' ||
        Array.isArray(body.vars) ||
        !Object.values(body.vars).every((v) => typeof v === 'string'))
    ) {
      throw new HttpError(400, 'vars must be an object of strings');
    }
    // Token is write-only: the composer omits it unless the operator typed a
    // new one (omitted = keep the stored one, null = forget it).
    applyStringField(cfg, body.mailtrapToken, 'mailtrap_token');
    applyStringField(cfg, body.fromEmail, 'email_from');
    applyStringField(cfg, body.fromName, 'email_from_name');
    if (body.vars !== undefined) cfg.set('email_vars', body.vars, 'admin');
    return c.json(emailConfigPayload());
  });

  // Verified sending domains of the configured token — powers the
  // "tank@<domain>" from-address suggestion in the UI.
  router.get('/email-domains', async (c) => {
    const token = deps.service.clusterConfig.get<string>('mailtrap_token') ?? '';
    if (!token) throw new HttpError(400, 'Mailtrap token not configured');
    const r = await listMailtrapDomains(token);
    return c.json(r);
  });

  // Effective templates: bundled defaults with the operator's
  // deployment-local override applied when one was saved.
  router.get('/email-templates', (c) => {
    const cfg = deps.service.clusterConfig;
    const templates: AdminEmailTemplatePayload[] = EMAIL_TEMPLATES.map((t) => {
      const ov = cfg.get<{ subject: string; html: string }>(emailTplKey(t.id, t.locale));
      return {
        id: t.id,
        locale: t.locale,
        subject: ov?.subject ?? t.subject,
        html: ov?.html ?? t.html,
        variables: t.variables,
        overridden: ov !== undefined,
      };
    });
    return c.json({ templates });
  });

  // Save the operator's draft as this deployment's template (a draft
  // matching the bundled default clears the override instead). Sending
  // does the same implicitly; this is the explicit "save" button.
  router.put('/email-templates/:id/:locale', async (c) => {
    const { id, locale } = c.req.param();
    const template = findTemplate(id, locale);
    if (!template) throw new HttpError(404, `unknown template ${id}.${locale}`);
    const body = (await c.req.json().catch(() => ({}))) as { subject?: unknown; html?: unknown };
    if (typeof body.subject !== 'string' || !body.subject.trim()) {
      throw new HttpError(400, 'subject is required');
    }
    if (typeof body.html !== 'string' || !body.html.trim()) {
      throw new HttpError(400, 'html body is required');
    }
    const cfg = deps.service.clusterConfig;
    const overridden = body.html !== template.html || body.subject.trim() !== template.subject;
    if (overridden) {
      cfg.set(emailTplKey(id, locale), { subject: body.subject.trim(), html: body.html }, 'admin');
    } else {
      cfg.delete(emailTplKey(id, locale));
    }
    return c.json({ ok: true, overridden });
  });

  // Reset a template to its bundled default.
  router.delete('/email-templates/:id/:locale', (c) => {
    const { id, locale } = c.req.param();
    if (!findTemplate(id, locale)) throw new HttpError(404, `unknown template ${id}.${locale}`);
    deps.service.clusterConfig.delete(emailTplKey(id, locale));
    return c.json({ ok: true });
  });

  router.get('/email-roster', (c) => {
    return c.json({ entries: roster.list() });
  });

  router.post('/email-roster', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { emails?: unknown };
    if (
      !Array.isArray(body.emails) ||
      body.emails.length === 0 ||
      !body.emails.every((e) => typeof e === 'string')
    ) {
      throw new HttpError(400, 'emails must be a non-empty array of strings');
    }
    const cleaned = body.emails.map((e) => e.trim()).filter(Boolean);
    const invalid = cleaned.filter((e) => !EMAIL_RE.test(e));
    if (invalid.length > 0) {
      throw new HttpError(400, `invalid email(s): ${invalid.join(', ')}`);
    }
    let added = 0;
    let skipped = 0;
    for (const e of cleaned) {
      if (roster.add(e)) added++;
      else skipped++; // already on the roster
    }
    return c.json({ added, skipped, entries: roster.list() });
  });

  router.delete('/email-roster/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) throw new HttpError(400, 'bad roster id');
    if (!roster.remove(id)) throw new HttpError(404, `roster entry ${id} not found`);
    return c.json({ ok: true, entries: roster.list() });
  });

  router.post('/email-send', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      templateId?: unknown;
      locale?: unknown;
      subject?: unknown;
      html?: unknown;
      vars?: unknown;
      mode?: unknown;
      rosterIds?: unknown;
      testAddress?: unknown;
    };
    const template = findTemplate(body.templateId, body.locale);
    if (!template) throw new HttpError(400, 'unknown templateId/locale');
    if (typeof body.subject !== 'string' || !body.subject.trim()) {
      throw new HttpError(400, 'subject is required');
    }
    if (typeof body.html !== 'string' || !body.html.trim()) {
      throw new HttpError(400, 'html body is required');
    }
    const vars: Record<string, string> =
      body.vars && typeof body.vars === 'object' && !Array.isArray(body.vars)
        ? (Object.fromEntries(
            Object.entries(body.vars as Record<string, unknown>).filter(
              ([, v]) => typeof v === 'string',
            ),
          ) as Record<string, string>)
        : {};
    const mode = body.mode;
    if (mode !== 'pending' && mode !== 'rows' && mode !== 'test') {
      throw new HttpError(400, `mode must be pending | rows | test`);
    }

    const cfg = deps.service.clusterConfig;
    const token = cfg.get<string>('mailtrap_token') ?? '';
    const fromEmail = cfg.get<string>('email_from') ?? '';
    if (!token || !fromEmail) {
      throw new HttpError(400, 'email sender not configured (Mailtrap token + from address)');
    }
    const fromName = cfg.get<string>('email_from_name') ?? '';

    // Resolve targets. `pending` = roster entries this template type
    // never reached (the one-shot guarantee); `rows` = explicit resend.
    let targets: Array<Pick<EmailRosterRow, 'seat' | 'email'> & { id?: number }>;
    if (mode === 'test') {
      const addr = typeof body.testAddress === 'string' ? body.testAddress.trim() : '';
      if (!EMAIL_RE.test(addr)) throw new HttpError(400, 'testAddress must be an email');
      targets = [{ seat: 1, email: addr }];
    } else if (mode === 'rows') {
      const ids = Array.isArray(body.rosterIds)
        ? body.rosterIds.filter((n): n is number => Number.isInteger(n))
        : [];
      if (ids.length === 0) throw new HttpError(400, 'rosterIds required for mode=rows');
      targets = roster.byIds(ids);
      if (targets.length === 0) throw new HttpError(404, 'no matching roster entries');
    } else {
      targets = roster.pendingFor(template.id);
    }

    // Operator {VARS} first, then the per-recipient {ID} (= VDI seat) —
    // in both the body and the subject.
    const htmlBase = substituteVars(body.html, vars);
    const subjectBase = substituteVars(body.subject.trim(), vars);

    // Sequential on purpose: a roomful of recipients at most, and
    // Mailtrap rate-limits burst sends on free plans. The 10s per-send
    // budget keeps a worst-case 20-seat batch under the server's 250s
    // idleTimeout (index.ts) so the client never loses the report.
    const results: AdminEmailSendPayload['results'] = [];
    for (const t of targets) {
      const r = await sendEmail({
        token,
        fromEmail,
        fromName,
        to: t.email,
        subject: substituteSeat(subjectBase, t.seat),
        html: substituteSeat(htmlBase, t.seat),
        timeoutMs: 10000,
      });
      results.push({ to: t.email, seat: t.seat, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
      if (r.ok && mode !== 'test' && t.id !== undefined) roster.markSent(t.id, template.id);
    }

    if (mode !== 'test') {
      // The edited draft becomes this deployment's template for the next
      // sends; a draft matching the bundled default clears any override.
      if (body.html !== template.html || body.subject.trim() !== template.subject) {
        cfg.set(
          emailTplKey(template.id, template.locale),
          { subject: body.subject.trim(), html: body.html },
          'admin',
        );
      } else {
        cfg.delete(emailTplKey(template.id, template.locale));
      }
      // Merge, don't replace: each template type carries only its own
      // vars, and a summary send must not wipe the invitation's saved
      // CLUSTER/PASSWORD for late roster additions.
      cfg.set(
        'email_vars',
        { ...(cfg.get<Record<string, string>>('email_vars') ?? {}), ...vars },
        'admin',
      );
    }

    const failed = results.filter((r) => !r.ok).length;
    consoleLogger.info('participant emails sent via admin', {
      template: `${template.id}.${template.locale}`,
      mode,
      count: results.length,
      failed,
    });
    const payload: AdminEmailSendPayload = {
      ok: failed === 0,
      sent: results.length - failed,
      failed,
      results,
    };
    return c.json(payload);
  });

  // ─── capabilities ───────────────────────────────────────────────────
  // GET returns the merged active set (HTTP-probed + dynamic config-
  // driven) — what /admin/pack uses when computing missingCapabilities.
  // Useful as the "is the engine really on, right now?" view alongside
  // the per-stage badges.
  router.get('/capabilities', (c) => {
    const merged = new Set<CapabilityFlag>(deps.capabilities ?? []);
    for (const cf of deps.service.computeDynamicCapabilities()) merged.add(cf);
    return c.json({ flags: Array.from(merged) });
  });

  // ─── capabilities re-probe ──────────────────────────────────────────
  // Re-runs the boot-time capability probe (capability-probe.ts) and
  // overwrites `deps.capabilities` in place. Used when the operator
  // flips a feature in Prism mid-event — e.g. activates the Calm
  // Policy Engine manually after the BP `activate_policy_engine.py`
  // gave up in best-effort mode (project_calm_policy_vm_unstable),
  // or enables Intelligent Operations. Without this, the new state
  // requires a server restart to take effect on /admin/pack +
  // session-create gating.
  //
  // PlannerCluster is NOT touched here — it's already config-driven
  // via cluster_config (see /planner-config above), recomputed on
  // every session.create(). The re-probe only refreshes the
  // HTTP-detected flags (NCM / IO / CalmDSL / NodeRemove /
  // MultiNode / ApprovalPolicy).
  router.post('/capabilities/refresh', async (c) => {
    const before = new Set(deps.capabilities);
    const probe = await probeCapabilities({
      nutanix: deps.nutanix,
      logger: consoleLogger,
    });
    // Mutate in place so the array reference shared by /pack + session
    // route immediately sees the new contents — no need to thread a
    // setter through every consumer.
    deps.capabilities.splice(0, deps.capabilities.length, ...probe.flags);
    const after = new Set(probe.flags);
    const added = probe.flags.filter((f) => !before.has(f));
    const removed = Array.from(before).filter((f) => !after.has(f));
    consoleLogger.info('capabilities re-probed via admin', {
      flags: probe.flags,
      added,
      removed,
    });
    return c.json({
      flags: probe.flags,
      added,
      removed,
      // Same shape as /api/health.capabilityProbe — gives the operator
      // a per-flag verdict so they can see WHICH probe answered what.
      probed: probe.details.map((d) => ({
        flag: d.flag,
        detected: d.detected,
        detail: d.detail,
        transportError: d.transportError,
        transportCode: d.transportCode,
      })),
    });
  });

  // ─── live cluster status (no DB) ────────────────────────────────────
  // Read-only probes, hit the live PC on every call; frequency is
  // "operator opens the Cluster tab". Split endpoints so each panel
  // refreshes without re-running the other probe.
  router.get('/cluster-status', async (c) => {
    const intelligentOps = await probeIntelligentOps({
      nutanix: deps.nutanix,
      pcEndpoint: deps.pcEndpoint,
      logger: consoleLogger,
    });
    const payload: AdminClusterStatusPayload = { intelligentOps };
    return c.json(payload);
  });

  router.get('/cluster-versions', async (c) => {
    const payload: AdminClusterVersionsPayload = await probeSoftwareVersions({
      nutanix: deps.nutanix,
      logger: consoleLogger,
    });
    return c.json(payload);
  });

  return router;
}
