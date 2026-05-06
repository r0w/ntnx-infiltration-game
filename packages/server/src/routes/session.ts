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
  supportedLocales: readonly Locale[];
}

export function buildSessionRoutes(deps: SessionRoutesDeps): Hono {
  const router = new Hono();

  router.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as CreateSessionRequest;
    const requested = typeof body.locale === 'string' ? body.locale : undefined;
    const locale: Locale =
      requested && deps.supportedLocales.includes(requested) ? requested : deps.defaultLocale;
    const session = deps.service.create({
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
      trigram: session.trigram,
      currentStage: session.currentStage,
      clusterProfile: session.clusterProfile,
      capabilities: session.capabilities,
      awaiting: session.awaiting,
      locale: session.locale,
      finishedAt: session.finishedAt,
      replay,
    });
  });

  return router;
}
