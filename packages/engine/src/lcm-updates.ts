import type { Logger, NutanixClient } from './types';

/** Shape we read off `/lifecycle/.../resources/entities` (only the fields we count on). */
export interface LcmEntity {
  entityType?: string;
  entityModel?: string;
  entityVersion?: string;
  availableVersions?: unknown;
  clusterExtId?: string;
}

interface LcmSummary {
  clusterExtId?: string;
  clusterType?: string; // 'AOS' (a PE cluster) | 'PRISM_CENTRAL'
}

// v4.0.a1 404s on PC 7.5; v4.2 + v4.0 both answer with the same shape.
const LCM_VERSIONS = ['v4.2', 'v4.0'];
// PC caps $limit at 100; the default page is 50, which silently truncated
// a 94-entity inventory (FSM/NCC/Foundation/PC fell off page 1).
const PAGE_SIZE = 100;

/**
 * Count the LCM updates the player sees under Admin Center > LCM >
 * **"Prism Element Clusters"**, grouped the way that tab groups them.
 *
 * The raw entities list needs three corrections:
 *   - **paginate** — page through all entities, not the first 50.
 *   - **scope** — keep only entities on a PE cluster (`clusterType === 'AOS'`
 *     per lcm-summaries). The PCVM is itself an AOS-software cluster, so it
 *     carries CLUSTER-scoped entities (NCC, …) that look just like a PE's;
 *     only the per-cluster `clusterType` reliably tells the two LCM tabs
 *     apart (`locationType` does not — the PE cluster also has PC-typed rows).
 *   - **dedup** — collapse per-node rows (same NIC firmware on 3 nodes is
 *     ONE update on screen) by (cluster, type, model).
 *
 * Counts only entities with a non-empty `availableVersions`. Returns `null`
 * when LCM entities or summaries are unreachable, so callers fall back to
 * format-only validation (lenient) rather than a mis-scoped count (which
 * would reject the player's correct answer).
 *
 * Keep in sync with the pack-local copy in
 * `packs/ntnx-infiltration/checks/helpers.ts` if behaviour changes.
 */
export async function countLcmAvailableUpdates(
  nutanix: NutanixClient,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<number | null> {
  const entities = await fetchAllLcmEntities(nutanix, logger);
  if (entities === null) return null;
  const peClusters = await fetchPeClusterIds(nutanix, logger);
  if (peClusters === null) return null;
  return dedupedUpdateCount(entities, peClusters);
}

/** Pure counting logic, split out so it can be unit-tested without a client. */
export function dedupedUpdateCount(entities: LcmEntity[], peClusters: Set<string>): number {
  const seen = new Set<string>();
  for (const e of entities) {
    const av = e.availableVersions;
    const hasUpdate = Array.isArray(av) ? av.length > 0 : Boolean(av);
    if (!hasUpdate) continue;
    if (!e.clusterExtId || !peClusters.has(e.clusterExtId)) continue; // PE tab only
    seen.add(`${e.clusterExtId}|${e.entityType ?? ''}|${e.entityModel ?? ''}`);
  }
  return seen.size;
}

/** clusterExtId set for every PE cluster (clusterType === 'AOS'). */
async function fetchPeClusterIds(
  nutanix: NutanixClient,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<Set<string> | null> {
  for (const v of LCM_VERSIONS) {
    try {
      const res = await nutanix.request<{ data?: LcmSummary[] }>(
        'GET',
        `/api/lifecycle/${v}/resources/lcm-summaries`,
      );
      const data = res?.data;
      if (!Array.isArray(data)) throw new Error('no data field');
      const ids = new Set<string>();
      for (const s of data) {
        if (s.clusterType === 'AOS' && s.clusterExtId) ids.add(s.clusterExtId);
      }
      return ids;
    } catch (err) {
      logger?.debug?.('LCM summaries fetch failed, trying next version', {
        version: v,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}

async function fetchAllLcmEntities(
  nutanix: NutanixClient,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<LcmEntity[] | null> {
  for (const v of LCM_VERSIONS) {
    try {
      const all: LcmEntity[] = [];
      for (let page = 0; ; page++) {
        const res = await nutanix.request<{ data?: LcmEntity[] }>(
          'GET',
          `/api/lifecycle/${v}/resources/entities?$limit=${PAGE_SIZE}&$page=${page}`,
        );
        const batch = res?.data;
        if (!Array.isArray(batch)) {
          if (page === 0) throw new Error('no data field');
          break;
        }
        all.push(...batch);
        if (batch.length < PAGE_SIZE) break;
      }
      return all;
    } catch (err) {
      logger?.debug?.('LCM entities fetch failed, trying next version', {
        version: v,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}
