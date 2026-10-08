import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { CapabilityFlag, ClusterProfile, NutanixClient } from '@ntnx-game/engine';
import { SessionQueries, ScoreboardPeerQueries, ClusterConfigQueries } from '../db/queries';
import type { LoadedPack } from '../pack-loader';
import type { SessionService } from '../session-service';
import { consoleLogger } from '../logger';
import { readScoreboardDisplay } from '../scoreboard-display';

export interface ScoreboardRoutesDeps {
  db: Database;
  pack: LoadedPack;
  /** Transport mode, inferred from the NutanixClient at wire-up. */
  mode: NutanixClient['mode'];
  /** Needed for `effectivePlayableCount` — the denominator used by the
   *  frontend's percent computation. */
  service: SessionService;
  capabilities: readonly CapabilityFlag[];
  clusterProfile: ClusterProfile;
}

/** Persisted key for the operator-set cluster label, surfaced as
 *  `selfLabel` on the `/combined` response. Stored in `cluster_config`
 *  (same table as other admin-managed runtime config) so a restart
 *  doesn't drop the value. */
const SELF_LABEL_KEY = 'self_label';

/** Per-peer fetch outcome for the combined endpoint's diagnostic panel. */
export interface CombinedPeerStatus {
  id: number;
  label: string;
  baseUrl: string;
  enabled: boolean;
  ok: boolean;
  /** Number of entries this peer contributed (0 on error). */
  entryCount: number;
  /** Set when `ok === false`. */
  error?: string;
  /** Round-trip ms for the GET. */
  durationMs: number;
}

const PEER_FETCH_TIMEOUT_MS = 5_000;

export interface ScoreboardEntry {
  rank: number;
  sessionId: string;
  trigram: string | null;
  username: string | null;
  /**
   * Stage the player is currently on — the one right after `currentStage`
   * in pack order. `null` when the player has finished the pack.
   */
  stageName: string | null;
  stagesPassed: number;
  /** Stages the engine gated for this session (e.g. destructive on `other`).
   *  Retained for telemetry — `effectiveTotalStages` is the denominator
   *  the frontend percent display uses now (more accurate for in-progress
   *  sessions, see field doc). */
  stagesDisabled: number;
  totalStages: number;
  /** Stages this cluster will let a fresh session actually play (raw pack
   *  total minus stages filtered for cluster reasons — capability missing,
   *  destructive-on-other, pack-disabled by overlay). Same value for every
   *  row on a given snapshot. Used as the percent denominator instead of
   *  `totalStages - stagesDisabled` so in-progress sessions don't dip to
   *  92% when they're actually on track for 100%. */
  effectiveTotalStages: number;
  startedAt: number;
  finishedAt: number | null;
  lastActivityAt: number | null;
  /** Stages whose step-by-step help the player displayed. Optional: peers
   *  on an older version don't send it (read as 0). */
  helpUses?: number;
  /** Total help penalty in seconds, added to the playing time in the
   *  ranking. Optional for the same reason as `helpUses`. */
  helpPenaltySec?: number;
  /** Time the operator held the player (admin gates, pack-wide pause) in waits
   *  that are over, in ms. Taken off the playing time. Optional: peers on an
   *  older version don't send it (read as 0). */
  blockedMs?: number;
  /** Start of the wait still running, `null` when the player is not held. */
  blockedSince?: number | null;
  /** Why the player is held right now. */
  blockedReason?: 'gate' | 'pause' | null;
  /** End of the player's latest wait; the idle clock restarts there. */
  lastReleasedAt?: number | null;
  status: 'playing' | 'finished';
}

export function buildScoreboardRoutes(deps: ScoreboardRoutesDeps): Hono {
  const router = new Hono();
  const sessions = new SessionQueries(deps.db);
  const peers = new ScoreboardPeerQueries(deps.db);
  const clusterConfig = new ClusterConfigQueries(deps.db);
  router.get('/display', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(readScoreboardDisplay(clusterConfig));
  });
  // Pack order is the source of truth for "next stage after X". Keep a
  // positional index so the scoreboard row doesn't need to re-scan the
  // array for each session.
  const order = deps.pack.stages.map((s) => s.name);
  const indexOf = (name: string | null): number => (name ? order.indexOf(name) : -1);
  const totalStages = deps.pack.stages.length;

  function buildLocalEntries(): ScoreboardEntry[] {
    const rows = sessions.listScoreboard(
      deps.pack.manifest.id,
      deps.pack.manifest.identity?.variable,
    );
    // Compute once per request — same value across every row.
    const effectiveTotalStages = deps.service.effectivePlayableCount(
      deps.capabilities,
      deps.clusterProfile,
    );
    // Public scoreboard hides anonymous (= pre-trigram-capture) sessions.
    // The query keeps surfacing them for /admin's debug view; the filter
    // lives at the route layer so the projector display only shows
    // identified agents. Re-rank after filter so the visible rank is
    // gap-free.
    const identified = rows.filter((row) => row.trigram !== null);
    return identified.map((row, idx) => {
      const finished = row.finishedAt !== null;
      let stageName: string | null = null;
      if (!finished) {
        const curIdx = indexOf(row.currentStage);
        const nextIdx = curIdx + 1;
        stageName = nextIdx < order.length ? (order[nextIdx] ?? null) : null;
      }
      return {
        rank: idx + 1,
        sessionId: row.sessionId,
        trigram: row.trigram,
        username: row.username,
        stageName,
        stagesPassed: row.stagesPassed,
        stagesDisabled: row.stagesDisabled,
        totalStages,
        effectiveTotalStages,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        lastActivityAt: row.lastActivityAt,
        helpUses: row.helpUses,
        helpPenaltySec: row.helpPenaltySec,
        blockedMs: row.blockedMs,
        blockedSince: row.blockedSince,
        blockedReason: row.blockedReason,
        lastReleasedAt: row.lastReleasedAt,
        status: finished ? 'finished' : 'playing',
      };
    });
  }

  router.get('/', (c) => {
    return c.json({
      packId: deps.pack.manifest.id,
      packName: deps.pack.manifest.name,
      mode: deps.mode,
      totalStages,
      entries: buildLocalEntries(),
    });
  });

  // Combined view: fan out to every enabled peer in parallel, merge their
  // entries with the local scoreboard, re-rank globally. Each entry is
  // tagged with `peerLabel` (null = local) so the UI can show origin.
  // Peer failures are non-fatal — the local + healthy-peer entries are
  // still returned, and the failed peer is surfaced in `peerStatus[]`
  // for the admin diagnostic. Re-implements the legacy Python
  // `/combined` (Flask app, dropped in v3 rewrite) but via JSON
  // fan-out instead of regex-HTML scraping.
  router.get('/combined', async (c) => {
    const local = buildLocalEntries().map((e) => ({ ...e, peerLabel: null as string | null }));
    const enabled = peers.list().filter((p) => p.enabled);
    const results = await Promise.all(
      enabled.map((peer) => fetchPeer(peer.baseUrl, peer.label, peer.id, peer.enabled)),
    );
    const peerEntries = results.flatMap((r) => r.entries);
    const merged = mergeScoreboards([...local, ...peerEntries]);
    const selfLabel = clusterConfig.get<string>(SELF_LABEL_KEY) ?? null;
    return c.json({
      packId: deps.pack.manifest.id,
      packName: deps.pack.manifest.name,
      mode: deps.mode,
      totalStages,
      selfLabel,
      entries: merged,
      peerStatus: results.map((r) => r.status),
    });
  });

  return router;
}

/**
 * Re-rank a list of mixed (local + peer) entries into a single board.
 *
 * Ordering matches the AgentCard render (progress-first): more
 * stagesPassed wins, then the shortest playing time (finish - start, minus the
 * time the operator held the player, plus the step-by-step help penalties, see
 * {@link effectiveDuration}), then earliest finish, then earliest start
 * (= "got there first"). `rank` is rewritten gap-free; `sessionId` is
 * namespaced with `peerLabel:` when the entry came from a peer so the
 * frontend `key` doesn't collide between instances that happen to have
 * matching session UUIDs (unlikely but cheap to defend against).
 */
export function mergeScoreboards(
  rows: Array<ScoreboardEntry & { peerLabel: string | null }>,
): Array<ScoreboardEntry & { peerLabel: string | null }> {
  const sorted = [...rows].sort((a, b) => {
    if (b.stagesPassed !== a.stagesPassed) return b.stagesPassed - a.stagesPassed;
    const aDur = effectiveDuration(a);
    const bDur = effectiveDuration(b);
    if (aDur !== bDur) return aDur - bDur;
    if (a.finishedAt !== null && b.finishedAt !== null && a.finishedAt !== b.finishedAt) {
      return a.finishedAt - b.finishedAt;
    }
    return a.startedAt - b.startedAt;
  });
  return sorted.map((e, idx) => ({
    ...e,
    rank: idx + 1,
    sessionId: e.peerLabel ? `${e.peerLabel}:${e.sessionId}` : e.sessionId,
  }));
}

/**
 * Playing time as the ranking sees it, in ms: finish minus start, minus the
 * time the operator held the player in a gate or the pause (waits are not the
 * player's time), plus the step-by-step help penalties. `Infinity` while
 * unfinished, so those entries tie on this key exactly as before. A peer on an
 * older version sends no waits and no penalty (both 0).
 */
export function effectiveDuration(
  e: Pick<ScoreboardEntry, 'startedAt' | 'finishedAt' | 'blockedMs' | 'helpPenaltySec'>,
): number {
  if (e.finishedAt === null) return Number.POSITIVE_INFINITY;
  const playing = Math.max(0, e.finishedAt - e.startedAt - (e.blockedMs ?? 0));
  return playing + (e.helpPenaltySec ?? 0) * 1000;
}

interface PeerFetchResult {
  status: CombinedPeerStatus;
  entries: Array<ScoreboardEntry & { peerLabel: string }>;
}

async function fetchPeer(
  baseUrl: string,
  label: string,
  id: number,
  enabled: boolean,
): Promise<PeerFetchResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/scoreboard`;
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PEER_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const durationMs = Date.now() - t0;
    if (!res.ok) {
      return {
        status: {
          id, label, baseUrl, enabled,
          ok: false,
          entryCount: 0,
          error: `HTTP ${res.status}`,
          durationMs,
        },
        entries: [],
      };
    }
    const payload = (await res.json()) as { entries?: ScoreboardEntry[] };
    const raw = Array.isArray(payload.entries) ? payload.entries : [];
    const tagged = raw.map((e) => ({ ...e, peerLabel: label }));
    return {
      status: {
        id, label, baseUrl, enabled,
        ok: true,
        entryCount: tagged.length,
        durationMs,
      },
      entries: tagged,
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    consoleLogger.debug('combined-scoreboard peer fetch failed', {
      baseUrl, label, error: msg,
    });
    return {
      status: {
        id, label, baseUrl, enabled,
        ok: false,
        entryCount: 0,
        error: msg,
        durationMs,
      },
      entries: [],
    };
  } finally {
    clearTimeout(timer);
  }
}
