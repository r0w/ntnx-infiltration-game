import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { CapabilityFlag, NutanixClient } from '@ntnx-game/engine';
import { HttpError, type SessionService } from '../session-service';
import { SessionQueries, ScoreboardPeerQueries, type AdminSessionRow, type ScoreboardPeerRow } from '../db/queries';
import type { LoadedPack } from '../pack-loader';
import { analyzeDeps, cascadeDisable, type BrokenStage } from '../dep-analysis';
import { probeClusterConfig } from '../cluster-config-probe';
import { probeIntelligentOps, type IntelligentOpsProbeResult } from '../cluster-status-probe';
import { consoleLogger } from '../logger';

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
}

export interface AdminClusterStatusPayload {
  intelligentOps: IntelligentOpsProbeResult;
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

export interface AdminUserEntry extends AdminSessionRow {
  /** Name of the stage the player is ABOUT to play (i.e. after currentStage). */
  nextStageName: string | null;
  totalStages: number;
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
    const entries: AdminUserEntry[] = rows.map((row) => {
      let nextStageName: string | null = null;
      if (row.finishedAt === null) {
        const curIdx = positionOf(row.currentStage);
        const nextIdx = curIdx + 1;
        nextStageName = nextIdx < effective.length ? (effective[nextIdx]?.name ?? null) : null;
      }
      return {
        ...row,
        nextStageName,
        totalStages,
      };
    });
    return c.json({
      packId: deps.pack.manifest.id,
      packName: deps.pack.manifest.name,
      totalStages,
      entries,
    });
  });

  router.delete('/users/:id', (c) => {
    const id = c.req.param('id');
    const changed = sessions.deleteById(id);
    if (changed === 0) throw new HttpError(404, 'session not found');
    return c.json({ ok: true, sessionId: id });
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
        const gateIdx = s.id;
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

    const activeCaps = new Set(deps.capabilities);
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

  // ─── live cluster status (no DB) ────────────────────────────────────
  // Read-only probe of PC product enablement. Currently surfaces the
  // Intelligent Operations state — no public API to flip it (PRI-55201
  // on the v4 endpoint), so the response includes a deep-link to the
  // Prism UI activation page. Hits the live PC on every call; intended
  // frequency is "operator opens the Cluster tab", caching adds nothing.
  router.get('/cluster-status', async (c) => {
    const intelligentOps = await probeIntelligentOps({
      nutanix: deps.nutanix,
      pcEndpoint: deps.pcEndpoint,
      logger: consoleLogger,
    });
    const payload: AdminClusterStatusPayload = { intelligentOps };
    return c.json(payload);
  });

  return router;
}
