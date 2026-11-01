import type { Logger, PackClusterFact } from '@ntnx-game/engine';
import type { ClusterConfigQueries } from './db/queries';

export interface StoreClusterFactsDeps {
  facts: PackClusterFact[];
  cfg: ClusterConfigQueries;
  logger: Logger;
}

/**
 * Cache what a pack read off its cluster into `cluster_config`.
 *
 * The pack decides *what* is worth caching and how fresh it must be; the one
 * rule the server keeps for itself is that **an operator's value always wins**.
 * Rows the operator typed in `/admin` are tagged `source='admin'`, and no probe
 * overwrites them: on event day the person in the room knows better than a
 * query, and silently correcting them mid-run would be the worst kind of help.
 */
export async function storeClusterFacts(deps: StoreClusterFactsDeps): Promise<void> {
  const { facts, cfg, logger } = deps;
  for (const fact of facts) {
    const existing = cfg.list().find((r) => r.key === fact.key);
    if (existing?.source === 'admin') {
      logger.debug('cluster-facts: kept the operator’s value', { key: fact.key });
      continue;
    }
    if (fact.write === 'refresh') {
      if (existing?.value === fact.value) continue;
      cfg.set(fact.key, fact.value, 'probe');
      logger.info('cluster-facts: refreshed', {
        key: fact.key,
        previous: existing?.value ?? null,
      });
      continue;
    }
    const inserted = cfg.setIfAbsent(fact.key, fact.value);
    logger.info(inserted ? 'cluster-facts: cached' : 'cluster-facts: already set, kept', {
      key: fact.key,
    });
  }
}
