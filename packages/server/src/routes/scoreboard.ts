import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { NutanixClient } from '@ntnx-game/engine';
import { SessionQueries } from '../db/queries';
import type { LoadedPack } from '../pack-loader';

export interface ScoreboardRoutesDeps {
  db: Database;
  pack: LoadedPack;
  /** Surfaced in the response so the frontend can enable the demo-preset
   *  switcher whenever the backend is running in mock mode (no need to
   *  opt in via URL param). Inferred from the NutanixClient at wire-up. */
  mode: NutanixClient['mode'];
}

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
   *  Frontend subtracts these from `totalStages` for the percent display. */
  stagesDisabled: number;
  totalStages: number;
  startedAt: number;
  finishedAt: number | null;
  lastActivityAt: number | null;
  status: 'playing' | 'finished';
}

export function buildScoreboardRoutes(deps: ScoreboardRoutesDeps): Hono {
  const router = new Hono();
  const sessions = new SessionQueries(deps.db);
  // Pack order is the source of truth for "next stage after X". Keep a
  // positional index so the scoreboard row doesn't need to re-scan the
  // array for each session.
  const order = deps.pack.stages.map((s) => s.name);
  const indexOf = (name: string | null): number => (name ? order.indexOf(name) : -1);
  const totalStages = deps.pack.stages.length;

  router.get('/', (c) => {
    const rows = sessions.listScoreboard(deps.pack.manifest.id);
    // Public scoreboard hides anonymous (= pre-trigram-capture) sessions.
    // The query keeps surfacing them for /admin's debug view; the filter
    // lives at the route layer so the projector display only shows
    // identified agents. Re-rank after filter so the visible rank is
    // gap-free.
    const identified = rows.filter((row) => row.trigram !== null);
    const entries: ScoreboardEntry[] = identified.map((row, idx) => {
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
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        lastActivityAt: row.lastActivityAt,
        status: finished ? 'finished' : 'playing',
      };
    });
    return c.json({
      packId: deps.pack.manifest.id,
      packName: deps.pack.manifest.name,
      mode: deps.mode,
      totalStages,
      entries,
    });
  });

  return router;
}
