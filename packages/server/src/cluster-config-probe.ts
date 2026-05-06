import type { Logger, NutanixClient } from '@ntnx-game/engine';
import { ClusterConfigQueries } from './db/queries';

export interface ClusterConfigProbeDeps {
  nutanix: NutanixClient;
  cfg: ClusterConfigQueries;
  logger: Logger;
}

/**
 * Boot-time snapshot of slow-to-query cluster facts: rackable-unit serials
 * (for `expand-cluster`) and LCM available-updates count (for
 * `lcm-check-updates`). Each value is upserted **only if absent** — the
 * operator's manual edits via `/admin` (tagged `source='admin'`) are
 * sticky and never overwritten by a probe re-run.
 *
 * In `mock` mode this is a no-op: the mock fixtures already shape both
 * checks the right way, and the test suite shouldn't invent serials.
 *
 * Used at:
 * - Server boot (best-effort; failures degrade to "live query at check-time")
 * - `POST /api/admin/cluster-config/refresh` (operator-triggered force,
 *   which deletes the keys first so the probe re-populates).
 */
export async function probeClusterConfig(deps: ClusterConfigProbeDeps): Promise<void> {
  const { nutanix, cfg, logger } = deps;
  if (nutanix.mode === 'mock') {
    logger.debug('cluster-config probe skipped (mock mode)');
    return;
  }

  // ─── rackable-unit serials ──────────────────────────────────────────
  try {
    const clusters = await nutanix.request<{ data?: Array<{ extId?: string }> }>(
      'GET',
      '/api/clustermgmt/v4.0/config/clusters',
    );
    const clusterUuid = clusters.data?.[0]?.extId;
    if (!clusterUuid) {
      logger.warn('cluster-config probe: no cluster UUID, skipping rackable-units');
    } else {
      let units: Array<{ serial?: string }> = [];
      for (const v of ['v4.0.b2', 'v4.0', 'v4.2']) {
        try {
          const res = await nutanix.request<{ data?: Array<{ serial?: string }> }>(
            'GET',
            `/api/clustermgmt/${v}/config/clusters/${clusterUuid}/rackable-units`,
          );
          if (res?.data) {
            units = res.data;
            break;
          }
        } catch {
          // try next version
        }
      }
      const serials = units
        .map((u) => (u.serial ?? '').trim())
        .filter((s) => s.length > 0);
      if (serials.length > 0) {
        const inserted = cfg.setIfAbsent('rackable_unit_serials', serials);
        logger.info(
          inserted
            ? 'cluster-config probe: cached rackable_unit_serials'
            : 'cluster-config probe: rackable_unit_serials already set, kept existing',
          { count: serials.length },
        );
      }
    }
  } catch (err) {
    logger.warn('cluster-config probe: rackable-units fetch failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // ─── LCM available updates count ────────────────────────────────────
  try {
    let entities: Array<{ availableVersions?: unknown }> = [];
    for (const v of ['v4.0.a1', 'v4.0', 'v4.2']) {
      try {
        const res = await nutanix.request<{ data?: typeof entities }>(
          'GET',
          `/api/lifecycle/${v}/resources/entities`,
        );
        if (res?.data) {
          entities = res.data;
          break;
        }
      } catch {
        // try next version
      }
    }
    if (entities.length > 0) {
      const count = entities.filter((e) => 'availableVersions' in e).length;
      const inserted = cfg.setIfAbsent('lcm_available_updates', count);
      logger.info(
        inserted
          ? 'cluster-config probe: cached lcm_available_updates'
          : 'cluster-config probe: lcm_available_updates already set, kept existing',
        { count },
      );
    }
  } catch (err) {
    logger.warn('cluster-config probe: LCM entities fetch failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
