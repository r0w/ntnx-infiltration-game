import type { Database } from 'bun:sqlite';
import { networkInterfaces } from 'node:os';
import type { Logger } from '@ntnx-game/engine';
import { ClusterConfigQueries } from './db/queries';
import { getVersionInfo } from './version';

/**
 * Fire-and-forget stats emitter for NIG Central. Strictly opt-in: when
 * `NIG_CENTRAL_URL` is unset the service is inert — record() and start()
 * are no-ops and nothing is ever written or sent. When enabled, events go
 * to the local `telemetry_outbox` table and a background loop flushes them
 * in batches; Central being down, slow, or wrong can never affect the game
 * (short timeout, errors swallowed, backlog pruned oldest-first).
 */

export interface TelemetryDeps {
  db: Database;
  logger: Logger;
  /** NIG Central base URL; undefined/empty = telemetry disabled. */
  url?: string;
  /** Optional bearer token sent as Authorization header. */
  token?: string;
  packId: string;
  packVersion: string;
  /** Operator-facing server mode — lets Central separate live events from
   *  mock/test validation runs. */
  serverMode: 'mock' | 'test' | 'live';
  clusterProfile: string;
}

export interface TelemetryEvent {
  type:
    | 'session_started'
    | 'stage_passed'
    | 'stage_failed'
    | 'session_finished';
  sessionId: string;
  stageId?: string;
  stageName?: string;
  stageIndex?: number;
  /** Wall-clock ms the player spent on the stage (entry → pass). */
  wallMs?: number;
  /** Check execution ms (subset of wallMs). */
  checkMs?: number;
  /** session_finished: total ms from session start to finish. */
  totalMs?: number;
  locale?: string;
}

const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_BATCH = 200;
const SEND_TIMEOUT_MS = 5_000;
const OUTBOX_CAP = 10_000;

/** First non-internal IPv4 of the host, or 'unknown'. */
function localIp(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return 'unknown';
}

export class Telemetry {
  readonly enabled: boolean;
  /** `<ip>-<first-boot date>` — the operator's chosen instance identity.
   *  The date half is persisted in cluster_config so restarts on a later
   *  day don't split one deployment into two. */
  readonly deploymentId: string;
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly url: string;
  private readonly token?: string;
  private readonly deployment: Record<string, unknown>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private warnedSendFailure = false;

  constructor(deps: TelemetryDeps) {
    this.db = deps.db;
    this.logger = deps.logger;
    this.url = (deps.url ?? '').trim().replace(/\/+$/, '');
    this.token = deps.token || undefined;
    this.enabled = this.url.length > 0;
    const ip = localIp();
    const firstBootDate = this.enabled ? this.firstBootDate() : '';
    this.deploymentId = `${ip}-${firstBootDate}`;
    const version = getVersionInfo();
    this.deployment = {
      id: this.deploymentId,
      ip,
      firstBootDate,
      packId: deps.packId,
      packVersion: deps.packVersion,
      gameVersion: version.version,
      mode: deps.serverMode,
      clusterProfile: deps.clusterProfile,
    };
  }

  /** Queue an event locally. Never throws. */
  record(event: TelemetryEvent): void {
    if (!this.enabled) return;
    try {
      this.db
        .prepare('INSERT INTO telemetry_outbox (created_at, event_json) VALUES ($ts, $json)')
        .run({ $ts: Date.now(), $json: JSON.stringify({ ...event, ts: Date.now() }) });
    } catch (err) {
      this.logger.debug('telemetry record failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Start the background flush loop (immediate first flush). */
  start(): void {
    if (!this.enabled || this.timer) return;
    void this.flush();
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    // Don't hold the process open for telemetry.
    this.timer.unref?.();
    this.logger.info('telemetry enabled', { central: this.url, deploymentId: this.deploymentId });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Push pending events to Central. All failures are swallowed. */
  async flush(): Promise<void> {
    if (!this.enabled || this.flushing) return;
    this.flushing = true;
    try {
      this.prune();
      const rows = this.db
        .prepare('SELECT id, event_json FROM telemetry_outbox ORDER BY id LIMIT $n')
        .all({ $n: FLUSH_BATCH }) as Array<{ id: number; event_json: string }>;
      if (rows.length === 0) return;
      const events = rows
        .map((r) => {
          try {
            return JSON.parse(r.event_json) as unknown;
          } catch {
            return null;
          }
        })
        .filter((e) => e !== null);
      const res = await fetch(`${this.url}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ deployment: this.deployment, events }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`central responded ${res.status}`);
      const maxId = rows[rows.length - 1]!.id;
      this.db.prepare('DELETE FROM telemetry_outbox WHERE id <= $max').run({ $max: maxId });
      this.warnedSendFailure = false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Warn once per outage, then stay quiet — an unreachable Central is a
      // normal condition (offline lab), not something to spam logs with.
      if (!this.warnedSendFailure) {
        this.logger.warn('telemetry flush failed (will keep retrying quietly)', { err: msg });
        this.warnedSendFailure = true;
      } else {
        this.logger.debug('telemetry flush failed', { err: msg });
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Keep the newest OUTBOX_CAP rows; drop the oldest overflow. */
  private prune(): void {
    this.db
      .prepare(
        `DELETE FROM telemetry_outbox WHERE id NOT IN
           (SELECT id FROM telemetry_outbox ORDER BY id DESC LIMIT $cap)`,
      )
      .run({ $cap: OUTBOX_CAP });
  }

  /** Date (YYYY-MM-DD) of the first boot with telemetry on, persisted so the
   *  deployment id survives restarts. */
  private firstBootDate(): string {
    const cfg = new ClusterConfigQueries(this.db);
    const existing = cfg.get<string>('telemetry_first_boot');
    if (typeof existing === 'string' && existing.length > 0) return existing;
    const today = new Date().toISOString().slice(0, 10);
    cfg.setIfAbsent('telemetry_first_boot', today);
    return today;
  }
}
