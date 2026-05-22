import type { Logger, NutanixClient } from '@ntnx-game/engine';
import { discoverableNodeSerials } from '@ntnx-game/engine';
import { ClusterConfigQueries } from './db/queries';

export interface ClusterConfigProbeDeps {
  nutanix: NutanixClient;
  cfg: ClusterConfigQueries;
  logger: Logger;
}

/**
 * Boot-time snapshot of slow-to-query cluster facts: discoverable node
 * serials (for `expand-cluster`) and LCM available-updates count (for
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

  // ─── discoverable node serials ──────────────────────────────────────
  // Discover-unconfigured-nodes returns the rackmounted nodes NOT currently
  // in the cluster — exactly the set CheckNewNode (stage 28) wants. On a
  // single-node HPoC with no spare chassis, this returns []; we store the
  // empty list so admin UI can show "no spare nodes" instead of stale data.
  try {
    const serials = await discoverableNodeSerials(nutanix, logger);
    const inserted = cfg.setIfAbsent('discoverable_node_serials', serials);
    logger.info(
      inserted
        ? 'cluster-config probe: cached discoverable_node_serials'
        : 'cluster-config probe: discoverable_node_serials already set, kept existing',
      { count: serials.length },
    );
  } catch (err) {
    logger.warn('cluster-config probe: discover-unconfigured-nodes failed', {
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
