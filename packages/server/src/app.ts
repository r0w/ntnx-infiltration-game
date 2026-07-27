import { resolve } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import type { Database } from 'bun:sqlite';
import type { CapabilityFlag, ClusterProfile, NutanixClient } from '@ntnx-game/engine';
import { StageRunner } from '@ntnx-game/engine';
import type { CapabilityProbeDetail } from '@ntnx-game/nutanix';
import type { LoadedPack } from './pack-loader';
import { consoleLogger } from './logger';
import { SessionService, HttpError } from './session-service';
import { buildSessionRoutes } from './routes/session';
import { buildStageRoutes } from './routes/stage';
import { buildScoreboardRoutes } from './routes/scoreboard';
import { buildSshRoutes } from './routes/ssh';
import { buildAdminRoutes } from './routes/admin';
import { buildActRoutes } from './routes/act';
import { effectiveSupportedLocales } from './effective-locales';
import { getVersionInfo } from './version';
import type { Telemetry } from './telemetry';

export interface AppDeps {
  db: Database;
  pack: LoadedPack;
  nutanix: NutanixClient;
  /**
   * Operator-facing mode (`mock | test | live`). The engine's NutanixClient
   * is binary (`mock | live`) — `serverMode` carries the UI-only `test`
   * distinction so the frontend can hide DevPanel + auto-play in `live`.
   * Defaults to the engine's transport mode when omitted (preserves the
   * `mock | live` semantics for tests that don't pass it).
   */
  serverMode?: 'mock' | 'test' | 'live';
  clusterEndpoint: string;
  clusterProfile: ClusterProfile;
  capabilities: CapabilityFlag[];
  capabilityProbe?: CapabilityProbeDetail[];
  globalTypingSpeedMs?: number;
  initialVariables?: Record<string, unknown>;
  publicDir?: string;
  adminPassword: string;
  /** PC admin password (deploy env) — seeds the invitation email's {PASSWORD}. */
  pcPassword?: string;
  /** NIG Central stats emitter — optional, absent in tests. */
  telemetry?: Telemetry;
}

export function buildApp(deps: AppDeps): { app: Hono; service: SessionService } {
  const runner = new StageRunner(deps.pack.stages, deps.pack.checks, { logger: consoleLogger });
  const service = new SessionService({
    db: deps.db,
    runner,
    nutanix: deps.nutanix,
    actions: deps.pack.actions,
    logger: consoleLogger,
    packId: deps.pack.manifest.id,
    bundle: deps.pack.bundle,
    globalTypingSpeedMs: deps.globalTypingSpeedMs,
    initialVariables: deps.initialVariables,
    telemetry: deps.telemetry,
  });

  const app = new Hono();

  // Server-facing mode label (`mock | test | live`). Falls back to the
  // engine transport mode when callers don't pass `serverMode`, keeping
  // existing tests (which use `nutanix.mode = 'mock'`) accurate.
  const serverMode: 'mock' | 'test' | 'live' = deps.serverMode ?? deps.nutanix.mode;

  // WIP-locale filter (issue #65). Evaluated per request so the operator
  // enabling/disabling a WIP locale from /admin takes effect on the next
  // /api/pack + session-create call — no server restart. Mock/test always
  // include WIP locales (for translators + QA); live filters them unless
  // the operator has enabled them via the cluster_config override.
  const getEffectiveLocales = () =>
    effectiveSupportedLocales(
      deps.pack.manifest.supportedLocales,
      deps.pack.manifest.wipLocales,
      serverMode,
      service.clusterConfig,
    );

  app.get('/api/health', (c) =>
    c.json({
      status: 'ok',
      pack: deps.pack.manifest.id,
      stages: deps.pack.stages.length,
      checks: deps.pack.checks.names(),
      clusterProfile: deps.clusterProfile,
      capabilities: deps.capabilities,
      capabilityProbe: deps.capabilityProbe ?? [],
      mode: serverMode,
      transport: deps.nutanix.mode,
    }),
  );

  // Build-stamped version + repo, read by the admin footer. Left public
  // (no admin auth) on purpose: it leaks nothing sensitive.
  app.get('/api/version', (c) => c.json(getVersionInfo()));

  app.get('/api/pack', (c) => {
    const locales = getEffectiveLocales();
    return c.json({
      id: deps.pack.manifest.id,
      name: deps.pack.manifest.name,
      mode: serverMode,
      // Surfaced so the DevPanel can dim/highlight destructive stages
      // only on shared clusters (clusterProfile === 'other'); on hpoc
      // those stages play normally and shouldn't be marked red.
      clusterProfile: deps.clusterProfile,
      defaultLocale: deps.pack.manifest.defaultLocale,
      supportedLocales: locales,
      // Which of the offered locales are still work-in-progress, so the
      // language picker can flag them as such (partially translated).
      wipLocales: locales.filter((l) =>
        (deps.pack.manifest.wipLocales ?? []).includes(l),
      ),
      // The frontend keys + displays stages by name; `s.index` is the engine's
      // ephemeral positional index and must never leak past this boundary.
      stages: deps.pack.stages.map((s) => ({
        name: s.name,
        active: s.active,
        impact: s.impact ?? 'safe',
        requires: s.requires ?? [],
        hasCheck: !!s.check,
        captures: s.captures ?? [],
      })),
    });
  });

  // Pack-bundled assets (images referenced by `<image src='…'/>` tags in
  // locale catalogs). Flat filenames only — reject anything that looks like
  // a path traversal attempt. Served with a short-ish browser cache so the
  // reveal animation doesn't re-fetch every render.
  app.get('/api/pack-assets/:file', async (c) => {
    const file = c.req.param('file');
    if (!/^[\w.-]+\.(png|jpe?g|webp|gif|svg)$/i.test(file)) {
      throw new HttpError(400, 'invalid asset filename');
    }
    const filePath = resolve(deps.pack.dir, 'assets', file);
    const f = Bun.file(filePath);
    if (!(await f.exists())) throw new HttpError(404, 'asset not found');
    const type =
      file.toLowerCase().endsWith('.png') ? 'image/png' :
      /\.(jpe?g)$/i.test(file) ? 'image/jpeg' :
      file.toLowerCase().endsWith('.webp') ? 'image/webp' :
      file.toLowerCase().endsWith('.gif') ? 'image/gif' :
      'image/svg+xml';
    return new Response(await f.arrayBuffer(), {
      headers: { 'content-type': type, 'cache-control': 'public, max-age=3600' },
    });
  });

  app.route(
    '/api/session',
    buildSessionRoutes({
      service,
      clusterEndpoint: deps.clusterEndpoint,
      clusterProfile: deps.clusterProfile,
      capabilities: deps.capabilities,
      defaultLocale: deps.pack.manifest.defaultLocale,
      getSupportedLocales: getEffectiveLocales,
    }),
  );
  app.route(
    '/api/session',
    buildStageRoutes({ service, pack: deps.pack, serverMode }),
  );
  app.route(
    '/api/scoreboard',
    buildScoreboardRoutes({
      db: deps.db,
      pack: deps.pack,
      mode: deps.nutanix.mode,
      service,
      capabilities: deps.capabilities,
      clusterProfile: deps.clusterProfile,
    }),
  );
  app.route('/api/ssh', buildSshRoutes());
  app.route(
    '/api/admin',
    buildAdminRoutes({
      db: deps.db,
      pack: deps.pack,
      adminPassword: deps.adminPassword,
      service,
      nutanix: deps.nutanix,
      serverMode,
      clusterProfile: deps.clusterProfile,
      capabilities: deps.capabilities,
      pcEndpoint: deps.clusterEndpoint,
      pcPassword: deps.pcPassword,
    }),
  );
  app.route(
    '/api/act',
    buildActRoutes({
      pack: deps.pack,
      nutanix: deps.nutanix,
      adminPassword: deps.adminPassword,
      clusterProfile: deps.clusterProfile,
      initialVariables: deps.initialVariables,
    }),
  );

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 400 | 401 | 404 | 409 | 500);
    }
    consoleLogger.error('unhandled error', { message: err.message });
    return c.json({ error: 'internal server error' }, 500);
  });

  if (deps.publicDir) {
    app.use('/*', serveStatic({ root: deps.publicDir }));
    app.get('*', serveStatic({ path: 'index.html', root: deps.publicDir }));
  } else {
    app.get('/', (c) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>ntnx-infiltration · api only</title>
<style>body{font-family:monospace;background:#0a0e12;color:#c7d2dc;padding:40px;line-height:1.6}
a{color:#7cdcfe}code{background:#0d1317;padding:2px 6px;border-radius:3px}</style>
<h1 style="color:#7cdcfe">ntnx-infiltration · API-only mode</h1>
<p>Backend is running but no frontend is mounted. Two options:</p>
<h3>Dev (two terminals)</h3>
<pre><code>cd packages/frontend
bun run dev</code></pre>
<p>Then open <a href="http://localhost:5173">http://localhost:5173</a>.</p>
<h3>Prod (single port)</h3>
<pre><code>bun --cwd packages/frontend run build
PUBLIC_DIR=$PWD/packages/frontend/dist bun packages/server/src/index.ts</code></pre>
<p>Health: <a href="/api/health">/api/health</a></p>`,
      ),
    );
  }

  return { app, service };
}
