import type { Logger, NutanixClient } from '@ntnx-game/engine';
import { countLcmAvailableUpdates, discoverableNodeSerials } from '@ntnx-game/engine';
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

  await refreshLcmCount(deps);
}

/**
 * Re-read the LCM update count and keep `lcm_available_updates` current.
 *
 * This row is what `lcm-check-updates` judges against while an inventory is
 * rebuilding the live list (issue #60), so it has to be the truth, not a
 * boot-time souvenir: a stale one would confirm an answer that stopped being
 * right. Called at boot and on a timer.
 *
 * Writes only a settled count (`countLcmAvailableUpdates` returns null while an
 * inventory is in flight — caching noise here is exactly the trap). An
 * operator's /admin override (`source: 'admin'`) stays sticky.
 */
export async function refreshLcmCount(deps: ClusterConfigProbeDeps): Promise<void> {
  const { nutanix, cfg, logger } = deps;
  if (nutanix.mode === 'mock') return;
  try {
    const count = await countLcmAvailableUpdates(nutanix, logger);
    if (count === null) {
      logger.debug('cluster-config: LCM count unreadable or mid-inventory, keeping the last one');
      return;
    }
    const row = cfg.list().find((r) => r.key === 'lcm_available_updates');
    if (row?.source === 'admin') return; // operator knows better
    if (row?.value === count) return;
    cfg.set('lcm_available_updates', count, 'probe');
    logger.info('cluster-config: lcm_available_updates refreshed', {
      count,
      previous: row?.value ?? null,
    });
  } catch (err) {
    logger.warn('cluster-config: LCM count refresh failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
