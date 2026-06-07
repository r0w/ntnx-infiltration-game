import { Hono } from 'hono';
import type { SessionService } from '../session-service';
import { HttpError } from '../session-service';
import type { LoadedPack } from '../pack-loader';
import { NutanixTransportError } from '@ntnx-game/nutanix';
import type { SubmitInputRequest } from '@ntnx-game/shared';
import { countLcmAvailableUpdates, discoverableNodeSerials } from '@ntnx-game/engine';

export interface StageRoutesDeps {
  service: SessionService;
  /** Pack reference — needed for act lookup on the auto-play `/act-current` route. */
  pack: LoadedPack;
  /**
   * Server mode (`mock | test | live`). The auto-play seed endpoint is gated
   * to `test` only: in `mock` the handlers crash (no POST fixtures) and in
   * `live` we don't trust the player to fire cluster-side mutations from
   * a one-click shortcut.
   */
  serverMode: 'mock' | 'test' | 'live';
}

export function buildStageRoutes(deps: StageRoutesDeps): Hono {
  const { service, pack, serverMode } = deps;
  const router = new Hono();

  router.post('/:id/advance', async (c) => {
    const r = await service.advance(c.req.param('id'));
    return c.json(r);
  });

  router.post('/:id/input', async (c) => {
    const body = (await c.req.json()) as SubmitInputRequest;
    if (!body.variable) throw new HttpError(400, 'missing variable');
    if (body.value === undefined) throw new HttpError(400, 'missing value');
    const r = await service.submitInput(c.req.param('id'), body.variable, String(body.value));
    return c.json(r);
  });

  // Phase 2 of the two-phase check: run the check deferred by /input.
  router.post('/:id/resolve-check', async (c) => {
    const r = await service.resolvePendingCheck(c.req.param('id'));
    return c.json(r);
  });

  router.post('/:id/skip-to/:stage', async (c) => {
    const stageName = c.req.param('stage');
    if (!stageName) throw new HttpError(400, 'missing stage name');
    const r = await service.skipTo(c.req.param('id'), stageName);
    return c.json(r);
  });

  router.post('/:id/goto/:stage', (c) => {
    const stageName = c.req.param('stage');
    if (!stageName) throw new HttpError(400, 'missing stage name');
    const r = service.gotoStage(c.req.param('id'), stageName);
    return c.json(r);
  });

  router.post('/:id/switch-identity', (c) => {
    const r = service.switchIdentity(c.req.param('id'));
    return c.json(r);
  });

  router.post('/:id/action/:name', async (c) => {
    const name = c.req.param('name');
    await service.fireAction(c.req.param('id'), name);
    return c.json({ fired: name });
  });

  router.get('/:id/actions', (c) => {
    // Enumerate pack-registered actions for DevPanel UX. Session id is in the
    // path for URL symmetry but the list itself is pack-wide, not per-session.
    return c.json({ names: service.listActionNames() });
  });

  /**
   * POST /:id/act-current — fires the registered **act** handler for the
   * stage the session is currently awaiting on. Used by the UI auto-play
   * toggle: typing "Ok" assumes the player did the cluster-side step (e.g.
   * created the user); auto-play does it for them by running the same act
   * the validation harness uses, then submits "Ok" client-side.
   *
   * Only allowed in `test` mode. `live` blocks because we don't want a
   * one-click shortcut nuking real demo state, and `mock` blocks because
   * the mock adapter has no POST fixtures so handlers throw on the first
   * `createX` call.
   */
  router.post('/:id/act-current', async (c) => {
    if (serverMode !== 'test') {
      throw new HttpError(403, `act-current disabled in ${serverMode} mode`);
    }
    const sessionId = c.req.param('id');
    const session = service.getSession(sessionId);
    if (!session.awaiting) throw new HttpError(409, 'session is not awaiting input');
    const actFn = pack.acts.get(session.awaiting.stageName);
    if (!actFn) {
      throw new HttpError(
        404,
        `no act registered for stage "${session.awaiting.stageName}"`,
      );
    }
    try {
      const r = await service.runActForAwaitingStage(sessionId, actFn);
      return c.json({ ok: true, ...r });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // Walk the cause chain for nested transport errors — Bun fetch
      // wraps the syscall a couple layers down, and acts may catch +
      // re-throw with their own message. The operator's UI banner gets
      // a much more useful signal when this is a connectivity problem
      // ("VPN down?") vs. a server-side act bug.
      const transport = findTransportError(err);
      // Plain `String(err)` returns `[object Object]` when the SDK throws
      // a bare object (without `.message`) — useless to the operator
      // banner. Try Error.message first, then JSON-stringify the body
      // (capped to avoid dumping a multi-KB response back to the client),
      // then fall back to a placeholder so the banner always says SOMETHING
      // actionable.
      let message: string;
      if (err instanceof Error && err.message) {
        message = err.message;
      } else if (err && typeof err === 'object') {
        try {
          const json = JSON.stringify(err);
          message = json && json !== '{}' ? json.slice(0, 400) : 'unknown error (empty object)';
        } catch {
          message = 'unknown error (non-serializable)';
        }
      } else {
        message = String(err) || 'unknown error';
      }
      return c.json(
        {
          ok: false,
          stageName: session.awaiting.stageName,
          error: message,
          transportError: transport !== null,
          transportCode: transport?.code,
        },
        500,
      );
    }
  });

  /**
   * POST /:id/auto-fill-current — for awaiting named-var prompts that
   * autoplay would otherwise skip (NodeSerial, NumberUpdates, Runway),
   * query the cluster live and return the answer so the frontend can
   * submit it. Returns `{ value: string }` when known, 404 when the
   * variable isn't auto-fillable (player must type manually). Test-mode
   * only — the same gating as /act-current.
   */
  router.post('/:id/auto-fill-current', async (c) => {
    // `live` keeps auto-fill off (operator must type — production demos
    // shouldn't skip steps in front of an audience). `test` and `mock`
    // both allow it: `test` looks up against the real PC, `mock` against
    // the fixtures (rackable-units + lifecycle/entities) and returns a
    // canned value for Runway (the lookup hits the OldPC raw, no fixture).
    if (serverMode === 'live') {
      throw new HttpError(403, `auto-fill disabled in ${serverMode} mode`);
    }
    const sessionId = c.req.param('id');
    const session = service.getSession(sessionId);
    if (!session.awaiting) throw new HttpError(409, 'session is not awaiting input');
    const variable = session.awaiting.variable;
    try {
      const value = await service.queryWithSessionContext(sessionId, async (ctx) => {
        if (variable === 'NodeSerial') return await lookupNodeSerial(ctx);
        if (variable === 'NumberUpdates') return await lookupNumberUpdates(ctx);
        if (variable === 'Runway') return await lookupRunway(ctx);
        return null;
      });
      if (value === null || value === undefined || value === '') {
        throw new HttpError(404, `no auto-fill for variable "${variable}"`);
      }
      return c.json({ ok: true, variable, value: String(value) });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error && err.message ? err.message : 'auto-fill failed';
      return c.json({ ok: false, variable, error: message }, 500);
    }
  });

  return router;
}

/** Live lookup for stage 28 — first DISCOVERABLE (unconfigured) node serial.
 *  Same data source as CheckNewNode so auto-fill ↔ validation stay aligned. */
async function lookupNodeSerial(ctx: import('@ntnx-game/engine').CheckContext): Promise<string | null> {
  try {
    const discoverable = await discoverableNodeSerials(ctx.nutanix, ctx.logger);
    return discoverable[0] ?? null;
  } catch {
    return null;
  }
}

/** Live lookup for stage 29 — count "Prism Element Clusters" LCM updates
 *  the same way CheckUpdates does, so auto-fill ↔ validation stay aligned. */
async function lookupNumberUpdates(ctx: import('@ntnx-game/engine').CheckContext): Promise<string | null> {
  const count = await countLcmAvailableUpdates(ctx.nutanix, ctx.logger);
  return count === null ? null : String(count);
}

/** Live lookup for stage 31 — query OldPC's v3/groups runway endpoint. */
async function lookupRunway(ctx: import('@ntnx-game/engine').CheckContext): Promise<string | null> {
  // Mock short-circuit: the OldPC lookup is a raw fetch (different host
  // than the main PC, can't go through the mock-adapter fixtures). Return
  // a canned value so mock auto-play can walk stage 31 — CheckRunway
  // accepts any positive integer in its format-only fallback path when
  // OldPC env vars aren't wired.
  if (ctx.nutanix.mode === 'mock') return '120';
  const oldPc = ctx.vars.get('OldPC');
  const user = ctx.vars.get('OldPCUsername');
  const pwd = ctx.vars.get('OldPCPassword');
  if (typeof oldPc !== 'string' || !oldPc || typeof user !== 'string' || typeof pwd !== 'string') {
    return null;
  }
  try {
    // Same scheme/port handling as CheckRunway: env may be a bare host
    // ('10.55.82.39') or a full URL. Detect by leading scheme.
    const stripped = oldPc.replace(/\/+$/, '');
    const base = /^https?:\/\//.test(stripped) ? stripped : `https://${stripped}:9440`;
    const now = Date.now();
    const res = await fetch(`${base}/api/nutanix/v3/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${btoa(`${user}:${pwd}`)}`,
      },
      body: JSON.stringify({
        entity_type: 'cluster',
        group_member_attributes: [{ attribute: 'capacity.runway' }],
        query_name: 'prism:RunwayInfoQueryModel',
        interval_start_ms: now - 3 * 86400 * 1000,
        interval_end_ms: now,
        downsampling_interval: 86400,
      }),
      tls: { rejectUnauthorized: false },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      group_results?: Array<{
        entity_results?: Array<{
          data?: Array<{ name?: string; values?: Array<{ values?: unknown[] }> }>;
        }>;
      }>;
    };
    const entry = body?.group_results?.[0]?.entity_results?.[0]?.data?.find(
      (d) => d.name === 'capacity.runway',
    );
    const v = entry?.values?.[0]?.values?.[0];
    return v != null ? String(v) : null;
  } catch {
    return null;
  }
}

function findTransportError(err: unknown): NutanixTransportError | null {
  let cur = err;
  for (let i = 0; i < 5; i++) {
    if (cur instanceof NutanixTransportError) return cur;
    if (!(cur instanceof Error)) return null;
    const next = (cur as { cause?: unknown }).cause;
    if (next === undefined || next === null) return null;
    cur = next;
  }
  return null;
}
