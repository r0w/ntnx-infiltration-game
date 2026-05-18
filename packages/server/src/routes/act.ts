import { Hono } from 'hono';
import type {
  ActContext,
  ClusterCache,
  ClusterCacheEntry,
  ClusterProfile,
  NutanixClient,
  Variables,
} from '@ntnx-game/engine';
import { withVariableInterpolation } from '@ntnx-game/nutanix';
import { HttpError } from '../session-service';
import type { LoadedPack } from '../pack-loader';
import { consoleLogger } from '../logger';

export interface ActRoutesDeps {
  pack: LoadedPack;
  nutanix: NutanixClient;
  adminPassword: string;
  clusterProfile: ClusterProfile;
  /**
   * Vars the server seeds on session create (PC endpoint, VLAN, image URL,
   * admin creds). Acts need these to interpolate resource specs — e.g.
   * `{Vlanid}` → the subnet's networkId, `{ImageURL}` → the image source.
   * Passed in from the main app so per-pack env wiring stays centralised.
   */
  initialVariables?: Record<string, unknown>;
}

/**
 * `/api/act` — operator tools for firing per-stage **act** + cleanup
 * handlers (Phase 10b) and looping them across the pack (Phase 10c
 * auto-play + bulk cleanup). Not tied to a real player session: the
 * handler is called with a synthetic ActContext keyed by `trigram`, so
 * the operator can run any combination of acts against the live PC
 * without starting a game first.
 *
 * Uses the same `X-Admin-Password` header as `/api/admin`. All endpoints
 * return a structured log of what ran — useful for live validation where
 * each stage may need shape tweaks.
 */
export function buildActRoutes(deps: ActRoutesDeps): Hono {
  const router = new Hono();

  router.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 400 | 401 | 404 | 500);
    }
    throw err;
  });

  router.use('*', async (c, next) => {
    const header = c.req.header('x-admin-password');
    if (header !== deps.adminPassword) {
      throw new HttpError(401, 'admin auth required');
    }
    await next();
  });

  // Build an ActContext from scratch for a given trigram. No session row is
  // created — the context is ephemeral (vars + cache live in-memory for the
  // request's lifetime) so operator-run acts don't pollute the sessions
  // table with synthetic rows.
  /**
   * Heuristic: the pure-input stages each have a known variable name the
   * player would normally submit. When the auto-play caller has pre-seeded
   * that variable in `body.vars`, we treat the stage as runnable and let
   * the check validate. List kept small — extend if new pure-input stages
   * land in the pack.
   */
  function isInputCaptured(
    stage: { name: string },
    ctx: ActContext,
  ): boolean {
    const byStage: Record<string, string> = {
      login: 'Trigram',
      'switch-to-admin-user': 'Username',
      'expand-cluster': 'NodeSerial',
      'lcm-check-updates': 'NumberUpdates',
      'capacity-runway': 'Runway',
    };
    const varName = byStage[stage.name];
    if (!varName) return false;
    const val = ctx.vars.get(varName);
    if (typeof val === 'string') return val.length > 0;
    if (typeof val === 'number') return Number.isFinite(val);
    return false;
  }

  function makeContext(trigram: string, extraVars: Record<string, unknown> = {}): ActContext {
    const varStore = new Map<string, unknown>();
    for (const [k, v] of Object.entries(deps.initialVariables ?? {})) varStore.set(k, v);
    varStore.set('Trigram', trigram);
    for (const [k, v] of Object.entries(extraVars)) varStore.set(k, v);
    const vars: Variables = {
      get: (name) => varStore.get(name),
      has: (name) => varStore.has(name),
      // `capturedAtStage` is ignored here — the ephemeral act context has
      // no persistence backing it. Signature kept for engine compat.
      set: (name, value, _capturedAtStage) => {
        varStore.set(name, value);
      },
      delete: (name) => {
        varStore.delete(name);
      },
      snapshot: () => Object.fromEntries(varStore),
    };
    const cacheStore = new Map<string, ClusterCacheEntry>();
    const cache: ClusterCache = {
      get: (kind, logicalName) => cacheStore.get(`${kind}:${logicalName}`),
      set: (entry) => cacheStore.set(`${entry.kind}:${entry.logicalName}`, entry),
      all: () => [...cacheStore.values()],
    };
    return {
      // Wrap with variable interpolation so mock fixtures keyed
      // `/.../{Trigram}-vm` continue to match after the act resolves
      // `Trigram` in its requests. No-op on non-mock transports
      // (withVariableInterpolation early-returns when mode !== 'mock').
      nutanix: withVariableInterpolation(deps.nutanix, () =>
        Object.fromEntries(varStore),
      ),
      vars,
      cache,
      session: {
        id: `act-${trigram}`,
        trigram,
        locale: 'en',
        clusterProfile: deps.clusterProfile,
      },
      logger: consoleLogger,
    };
  }

  /**
   * Lists which stages have acts/cleanups registered. Useful to validate
   * pack wiring after edits without starting a full auto-play.
   */
  router.get('/registry', (c) =>
    c.json({
      acts: deps.pack.acts.names(),
      cleanups: deps.pack.cleanups.names(),
      stages: deps.pack.stages.map((s) => s.name),
    }),
  );

  /**
   * POST /run/:trigram/:stage — fire one act handler. Body can include
   * extra vars (overrides for Vlanid / ImageURL / Username / PIN) so the
   * operator can run an act against test values without editing the .env.
   */
  router.post('/run/:trigram/:stage', async (c) => {
    const trigram = c.req.param('trigram');
    const stage = c.req.param('stage');
    const body = (await c.req.json().catch(() => ({}))) as {
      vars?: Record<string, unknown>;
    };
    const fn = deps.pack.acts.get(stage);
    if (!fn) throw new HttpError(404, `no act registered for stage "${stage}"`);
    const ctx = makeContext(trigram, body.vars ?? {});
    const startedAt = Date.now();
    try {
      await fn(ctx);
      return c.json({
        ok: true,
        stage,
        trigram,
        durationMs: Date.now() - startedAt,
        capturedVars: ctx.vars.snapshot(),
      });
    } catch (err) {
      return c.json(
        {
          ok: false,
          stage,
          trigram,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        },
        500,
      );
    }
  });

  /** POST /cleanup/:trigram/:stage — fire one cleanup handler. */
  router.post('/cleanup/:trigram/:stage', async (c) => {
    const trigram = c.req.param('trigram');
    const stage = c.req.param('stage');
    const fn = deps.pack.cleanups.get(stage);
    if (!fn) throw new HttpError(404, `no cleanup registered for stage "${stage}"`);
    const ctx = makeContext(trigram);
    const startedAt = Date.now();
    try {
      await fn(ctx);
      return c.json({ ok: true, stage, trigram, durationMs: Date.now() - startedAt });
    } catch (err) {
      return c.json(
        {
          ok: false,
          stage,
          trigram,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        },
        500,
      );
    }
  });

  /**
   * POST /auto-play/:trigram — walks every stage in pack order. For each
   * stage with an act: fire act → run check. Records pass/fail per stage.
   * Does NOT advance a session; this is a validation harness, not a way to
   * progress a player. Checks are run against the same NutanixClient as
   * normal advances use.
   */
  router.post('/auto-play/:trigram', async (c) => {
    const trigram = c.req.param('trigram');
    const body = (await c.req.json().catch(() => ({}))) as {
      vars?: Record<string, unknown>;
      maxRetries?: number;
      retryDelayMs?: number;
    };
    // Defaults bumped from 3/2000 → 10/3000 because several live v4
    // endpoints are task-tracked: the POST returns 202 + task ref, the
    // resource appears in the list only after task completion (~10-30 s
    // for creates, longer for Calm app launches). 10 × 3 s ≈ 30 s of
    // tolerance per check, still bounded at ~19 min for a full pack
    // worst-case.
    const maxRetries = Math.max(0, body.maxRetries ?? 10);
    const retryDelayMs = Math.max(0, body.retryDelayMs ?? 3000);
    const ctx = makeContext(trigram, body.vars ?? {});

    const results: Array<{
      stage: string;
      acted: boolean;
      actError?: string;
      checkStatus: 'pass' | 'fail' | 'skipped' | 'no-check';
      checkDetail?: string;
      durationMs: number;
    }> = [];

    for (const stage of deps.pack.stages) {
      const started = Date.now();
      const actFn = deps.pack.acts.get(stage.name);
      const checkFn = stage.check ? deps.pack.checks.get(stage.check.fn) : undefined;

      let acted = false;
      let actError: string | undefined;
      if (actFn) {
        try {
          await actFn(ctx);
          acted = true;
        } catch (err) {
          actError = err instanceof Error ? err.message : String(err);
        }
      }

      let checkStatus: 'pass' | 'fail' | 'skipped' | 'no-check' = 'no-check';
      let checkDetail: string | undefined;
      if (!checkFn) {
        checkStatus = 'no-check';
      } else if (
        !actFn &&
        !stage.check?.rehydrate &&
        !stage.check?.args &&
        !isInputCaptured(stage, ctx)
      ) {
        // Pure-input stages (CheckNewNode / CheckRunway / CheckTrigram /
        // CheckUpdates) have no act AND rely on vars the player would
        // normally type. Skip when those vars are unset in our synthetic
        // context. If the caller pre-populated them in `body.vars` (e.g.
        // `{NodeSerial: 'ABC123', Runway: 120}`), we still run the check
        // — validation should exercise the input-validation logic too.
        checkStatus = 'skipped';
      } else {
        // Retry loop for checks that need PC eventual consistency (categories
        // sometimes lag 1–2s after createCategory returns).
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          const res = await checkFn({
            nutanix: ctx.nutanix,
            vars: ctx.vars,
            cache: ctx.cache,
            args: stage.check?.args ?? {},
            session: ctx.session,
            logger: ctx.logger,
          });
          if (res.pass) {
            checkStatus = 'pass';
            checkDetail = res.detail;
            if (res.captured) {
              for (const [k, v] of Object.entries(res.captured)) {
                ctx.vars.set(k, v, stage.name);
              }
            }
            break;
          }
          checkStatus = 'fail';
          checkDetail = res.detail;
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
          }
        }
      }

      results.push({
        stage: stage.name,
        acted,
        actError,
        checkStatus,
        checkDetail,
        durationMs: Date.now() - started,
      });
    }

    const summary = {
      passed: results.filter((r) => r.checkStatus === 'pass').length,
      failed: results.filter((r) => r.checkStatus === 'fail').length,
      noCheck: results.filter((r) => r.checkStatus === 'no-check').length,
      skipped: results.filter((r) => r.checkStatus === 'skipped').length,
      actErrors: results.filter((r) => r.actError).length,
    };

    return c.json({ ok: true, trigram, summary, results });
  });

  /**
   * POST /cleanup-all/:trigram — fire every registered cleanup in reverse
   * stage order for a post-event tidy. Errors per-stage are captured but
   * don't abort the loop — stages with resources already gone (404 from
   * Nutanix) are treated as success.
   */
  router.post('/cleanup-all/:trigram', async (c) => {
    const trigram = c.req.param('trigram');
    const ctx = makeContext(trigram);
    // Iterate the pack's CleanupRegistry in its insertion order — the pack
    // owns the cleanup sequence. Reverse-stage-order doesn't work for
    // cross-stage dependencies (e.g. `create-vm` (stage 12) must run
    // BEFORE `create-category` (stage 15) because the VM holds a tag
    // reference that blocks the category delete — pure reverse would
    // try create-category first and fail with HTTP 400).
    const cleanupOrder = deps.pack.cleanups.names();

    const results: Array<{ stage: string; ok: boolean; error?: string; durationMs: number }> =
      [];
    for (const stageName of cleanupOrder) {
      const fn = deps.pack.cleanups.get(stageName);
      if (!fn) continue;
      const started = Date.now();
      try {
        await fn(ctx);
        results.push({ stage: stageName, ok: true, durationMs: Date.now() - started });
      } catch (err) {
        results.push({
          stage: stageName,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started,
        });
      }
    }

    return c.json({
      ok: true,
      trigram,
      cleanedStages: results.length,
      failures: results.filter((r) => !r.ok).length,
      results,
    });
  });

  return router;
}
