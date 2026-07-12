import { Hono } from 'hono';
import type { SessionService } from '../session-service';
import type { CapabilityFlag, ClusterProfile, Locale } from '@ntnx-game/engine';
import type { CreateSessionRequest } from '@ntnx-game/shared';

export interface SessionRoutesDeps {
  service: SessionService;
  clusterEndpoint: string;
  clusterProfile: ClusterProfile;
  capabilities: CapabilityFlag[];
  defaultLocale: Locale;
  /**
   * Getter (not array) so the WIP-locale gate (issue #65) is re-evaluated
   * on each session-create — an operator flipping a WIP locale in `/admin`
   * takes effect immediately without a server restart.
   */
  getSupportedLocales: () => readonly Locale[];
}

export function buildSessionRoutes(deps: SessionRoutesDeps): Hono {
  const router = new Hono();

  router.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as CreateSessionRequest;
    const requested = typeof body.locale === 'string' ? body.locale : undefined;
    const supported = deps.getSupportedLocales();
    const locale: Locale =
      requested && supported.includes(requested) ? requested : deps.defaultLocale;
    const session = await deps.service.create({
      locale,
      clusterEndpoint: deps.clusterEndpoint,
      clusterProfile: deps.clusterProfile,
      capabilities: deps.capabilities,
    });
    return c.json({
      sessionId: session.id,
      currentStage: session.currentStage,
      clusterProfile: session.clusterProfile,
      capabilities: session.capabilities,
      awaiting: session.awaiting,
      locale: session.locale,
    });
  });

  router.get('/:id', (c) => {
    const session = deps.service.getSession(c.req.param('id'));
    const replay = deps.service.replayAwaiting(session);
    return c.json({
      sessionId: session.id,
      // The column is a placeholder (= session id); the real trigram is the
      // captured session variable. null until the player types it.
      trigram: deps.service.capturedTrigram(session.id),
      currentStage: session.currentStage,
      clusterProfile: session.clusterProfile,
      capabilities: session.capabilities,
      awaiting: session.awaiting,
      // Surface only the stage name — the client re-runs /resolve-check to
      // finish a check it was parked on when it reloaded.
      pendingCheck: session.pendingCheck ? { stageName: session.pendingCheck.stageName } : null,
      locale: session.locale,
      finishedAt: session.finishedAt,
      replay,
    });
  });

  return router;
}
