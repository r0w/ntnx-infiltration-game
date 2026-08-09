import type { PackBootContext, PackClusterFact } from '@ntnx-game/engine';
import { discoverableNodeSerials } from '../checks/helpers';

/**
 * The two cluster answers this game caches instead of re-asking on every
 * player attempt: the serials of the nodes not yet in the cluster (stage 28,
 * `expand-cluster`) and the number of LCM updates available (stage 29,
 * `lcm-check-updates`). Both are slow, and both are the same for every player.
 *
 * Neither is fatal. A fact this cannot read is simply omitted, and the check
 * falls back to querying live at check time — slower, not wrong. Storage, and
 * the rule that an operator's `/admin` value always wins, belong to the
 * server: see `storeClusterFacts`.
 */
export async function readClusterFacts(ctx: PackBootContext): Promise<PackClusterFact[]> {
  const { logger } = ctx;
  const nutanix = ctx.transports.nutanix;
  if (nutanix.mode === 'mock') {
    // The fixtures already shape both checks correctly, and a test suite has no
    // business inventing hardware serials.
    logger.debug('cluster facts skipped (mock mode)');
    return [];
  }
  const facts: PackClusterFact[] = [];

  // Read once and keep: a spare chassis does not appear mid-event, and an
  // empty list is itself the answer ("no spare node") rather than stale data.
  try {
    facts.push({
      key: 'discoverable_node_serials',
      value: await discoverableNodeSerials(nutanix, logger),
      write: 'if-absent',
    });
  } catch (err) {
    logger.warn('cluster facts: discover-unconfigured-nodes failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Re-read every boot, because it moves — but only ever a *settled* count.
  // Mid-inventory LCM reports garbage for minutes, and caching that would pin a
  // wrong answer for the whole event, so an unsettled reading is omitted and
  // the last good value stands.
  try {
    const count = await ctx.probes.lcmAvailableUpdates();
    if (count === null) {
      logger.debug('cluster facts: LCM count unreadable or mid-inventory, keeping the last one');
    } else {
      facts.push({ key: 'lcm_available_updates', value: count, write: 'refresh' });
    }
  } catch (err) {
    logger.warn('cluster facts: LCM count read failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return facts;
}
