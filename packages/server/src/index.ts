import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createNutanixClient, probeCapabilities } from '@ntnx-game/nutanix';
import { createKubeClient, createLiveKubeFromKubeconfig } from '@ntnx-game/kube-transport';
import { loadConfig } from './config';
import { consoleLogger } from './logger';
import { openDatabase } from './db/database';
import { loadPack } from './pack-loader';
import { resolveClusterProfile } from './cluster-profile';
import { buildApp } from './app';

async function main() {
  const cfg = loadConfig();
  mkdirSync(cfg.dataDir, { recursive: true });
  const dbPath = resolve(cfg.dataDir, 'game.db');
  const db = openDatabase({ path: dbPath });
  consoleLogger.info('database opened', { path: dbPath });

  const pack = await loadPack(cfg.packsDir, cfg.gamePack);
  consoleLogger.info('pack loaded', {
    id: pack.manifest.id,
    stages: pack.stages.length,
    checks: pack.checks.names(),
  });

  // Transport selection is binary: mock vs real PC. `test` rides the same
  // SDK/REST stack as `live` — the distinction is purely UI-side (dev tools
  // + auto-play visibility), so the engine sees `'live'` for both.
  const transportMode: 'mock' | 'live' = cfg.mode === 'mock' ? 'mock' : 'live';

  // Cluster profile gates `impact: destructive` stages on shared clusters.
  // In mock mode there is no cluster — fixtures are immutable JSON — so the
  // destructive guard is a no-op risk-wise. Default `hpoc` so all stages
  // (expand-cluster, create-approval-policy, …) play through; otherwise a
  // mock session that didn't set CLUSTER_PROFILE in env would silently skip
  // them and the player would see 37/39 at the end with no explanation.
  // But honor an *explicit* CLUSTER_PROFILE — an operator who deliberately
  // sets `other` wants to preview the shared-cluster (filtered) stage set.
  let clusterProfile: 'hpoc' | 'other';
  if (transportMode === 'mock') {
    clusterProfile = cfg.clusterProfile ?? 'hpoc';
    consoleLogger.info('cluster profile (mock mode)', {
      profile: clusterProfile,
      reason: cfg.clusterProfile ? 'explicit-env' : 'default-fixtures-not-a-real-cluster',
    });
  } else {
    clusterProfile = resolveClusterProfile({
      explicit: cfg.clusterProfile,
      logger: consoleLogger,
    });
  }
  const fixturesPath = resolve(pack.dir, 'fixtures.json');
  const nutanix = await createNutanixClient({
    mode: transportMode,
    pcEndpoint: cfg.pcEndpoint || undefined,
    user: cfg.pcUser || undefined,
    password: cfg.pcPassword || undefined,
    fixtures: transportMode === 'mock' ? fixturesPath : undefined,
    verifySsl: cfg.pcVerifySsl,
    timeoutMs: cfg.pcTimeoutMs,
    maxRetries: cfg.pcMaxRetries,
    logger: consoleLogger,
  });
  consoleLogger.info('nutanix client ready', {
    serverMode: cfg.mode,
    transport: nutanix.mode,
    verifySsl: cfg.pcVerifySsl,
    timeoutMs: cfg.pcTimeoutMs,
    maxRetries: cfg.pcMaxRetries,
  });

  // Read-only k8s transport for the NKP pack. In mock mode it reads the pack's
  // fixtures.json (`kube` section), no cluster. In live/test mode, if a
  // kubeconfig path is provided (NKP_KUBECONFIG), read the real cluster with it.
  // NCP packs never touch ctx.kube, so this stays undefined for them.
  let kube;
  if (transportMode === 'mock') {
    kube = createKubeClient({ mode: 'mock', fixtures: fixturesPath });
  } else if (process.env.NKP_KUBECONFIG) {
    const { readFileSync } = await import('node:fs');
    kube = createLiveKubeFromKubeconfig(readFileSync(process.env.NKP_KUBECONFIG, 'utf8'));
    consoleLogger.info('kube transport ready (live)', { kubeconfig: process.env.NKP_KUBECONFIG });
  }

  const probe = await probeCapabilities({ nutanix, logger: consoleLogger });

  // Loud aggregate diagnostic when the cluster is fully unreachable in
  // a real-PC mode. Boot continues — server keeps running on mock-ish
  // paths and the operator can fix connectivity without restarting.
  if (transportMode === 'live' && probe.unreachable) {
    const codes = Array.from(
      new Set(probe.details.map((d) => d.transportCode).filter((c): c is string => !!c)),
    );
    consoleLogger.error('cannot reach Prism Central', {
      pcEndpoint: cfg.pcEndpoint,
      transportCodes: codes,
    });
  }

  // Snapshot slow-to-query cluster facts (rackable-unit serials, LCM
  // update count) into SQLite so checks don't hit the live endpoints
  // on every player attempt. Skipped in mock mode; failures degrade
  // to "live query at check-time" via the existing fallback paths.
  // Operator-edited rows are sticky (probe never overwrites them).
  if (transportMode === 'live' && !probe.unreachable) {
    try {
      const { ClusterConfigQueries } = await import('./db/queries');
      const { probeClusterConfig } = await import('./cluster-config-probe');
      await probeClusterConfig({
        nutanix,
        cfg: new ClusterConfigQueries(db),
        logger: consoleLogger,
      });
    } catch (err) {
      consoleLogger.warn('cluster-config probe failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Seed secondary-PC ("Planner") config into cluster_config so /admin
  // can edit it post-launch and the change propagates to new sessions.
  // setIfAbsent: never overwrite an admin edit. Skip empty env values
  // so unset operators don't pin "" rows the admin would then have to
  // clear. The PlannerCluster capability is computed from these.
  {
    const { ClusterConfigQueries } = await import('./db/queries');
    const cfgQ = new ClusterConfigQueries(db);
    if (cfg.gameOldPc) cfgQ.setIfAbsent('old_pc', cfg.gameOldPc);
    if (cfg.gameOldPcUsername) cfgQ.setIfAbsent('old_pc_username', cfg.gameOldPcUsername);
    if (cfg.gameOldPcPassword) cfgQ.setIfAbsent('old_pc_password', cfg.gameOldPcPassword);
  }

  // Seed template-facing variables from env so `{PC}` / `{PCUser}` /
  // `{PCPassword}` / `{ImageURL}` render something instead of leaving a hole
  // in the prompt. Empty strings are kept (template renders ''), which is the
  // same behavior the player sees pre-login anyway. `Vlanid` is intentionally
  // absent — it's always allocated per-session (collision-free); pinning it
  // would break multi-player at stage 10 (two subnets on one VLAN).
  // OldPC* are NOT in this map — they're projected from cluster_config at
  // session-create instead, so admin edits via /admin → cluster apply
  // without a server restart.
  const initialVariables: Record<string, unknown> = {
    PC: cfg.pcEndpoint,
    PCUser: cfg.pcUser,
    PCPassword: cfg.pcPassword,
    ImageURL: cfg.gameImageUrl,
    EmailReport: cfg.gameEmailReport,
    ProdUsername: cfg.gameProdUsername,
    ProdPassword: cfg.gameProdPassword,
    frontendHost: cfg.gameFrontendHost,
    // NKP pack: the real Kommander dashboard URL (clickable in-game). Falls back
    // to a placeholder so the prompt renders before an operator sets it.
    DashboardUrl: process.env.NKP_DASHBOARD_URL || 'https://your-nkp-console/dkp/kommander/dashboard',
  };

  // NIG Central stats emitter — inert unless NIG_CENTRAL_URL is set.
  const { Telemetry } = await import('./telemetry');
  const telemetry = new Telemetry({
    db,
    logger: consoleLogger,
    url: cfg.nigCentralUrl,
    token: cfg.nigCentralToken,
    packId: pack.manifest.id,
    packVersion: pack.manifest.version,
    serverMode: cfg.mode,
    clusterProfile,
  });
  telemetry.start();

  const { app } = buildApp({
    db,
    pack,
    nutanix,
    kube,
    serverMode: cfg.mode,
    clusterEndpoint: cfg.pcEndpoint,
    clusterProfile,
    capabilities: probe.flags,
    capabilityProbe: probe.details,
    globalTypingSpeedMs: cfg.typingSpeedMs,
    initialVariables,
    publicDir: cfg.publicDir,
    adminPassword: cfg.adminPassword,
    pcPassword: cfg.pcPassword,
    telemetry,
  });

  Bun.serve({
    port: cfg.port,
    fetch: app.fetch,
    // Default 10 s idle timeout closes long-running endpoints like
    // `/act-current` (image-from-URL upload polls up to 90 s; Calm app
    // launches poll up to ~3.5 min). Bun caps idleTimeout at 255 s — set
    // it to 250 to leave margin and have the slowest act paths cap their
    // own internal deadlines below this so the response writes back
    // before Bun closes the connection.
    idleTimeout: 250,
  });
  consoleLogger.info('server listening', { port: cfg.port });
}

// The Nutanix JS SDKs generate error-handling code that mutates the error
// object (`err.data = ...`) after a non-2xx HTTP response. Bun freezes
// response errors by default, so that assignment throws a TypeError
// inside a superagent callback — an uncaught exception that would crash
// the process. Log and swallow so failed SDK calls can surface via the
// seed/cleanup endpoints' normal error paths (they set `ok: false` in
// their JSON response).
process.on('uncaughtException', (err) => {
  consoleLogger.error('uncaughtException (logged, not crashing)', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join(' | ') : undefined,
  });
});
process.on('unhandledRejection', (reason) => {
  consoleLogger.error('unhandledRejection (logged, not crashing)', {
    reason:
      reason instanceof Error ? reason.message : JSON.stringify(reason).slice(0, 200),
  });
});

main().catch((err) => {
  consoleLogger.error('fatal', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
