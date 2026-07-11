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
  hasAvailableUpgrades?: boolean;
}

/** A PE cluster as LCM sees it. */
interface PeCluster {
  extId: string;
  /** LCM's own "this cluster has updates" flag. Undefined on older PCs. */
  hasAvailableUpgrades?: boolean;
}

/** A count, plus whether the inventory data behind it can be trusted. */
export interface LcmUpdatesReading {
  count: number;
  /**
   * False while LCM is rebuilding its entity data — the count is then a
   * meaningless snapshot of a half-populated list (see `readLcmUpdates`).
   */
  settled: boolean;
}

// v4.0.a1 404s on PC 7.5; v4.2 + v4.0 both answer with the same shape.
const LCM_VERSIONS = ['v4.2', 'v4.0'];
// PC caps $limit at 100; the default page is 50, which silently truncated
// a 94-entity inventory (FSM/NCC/Foundation/PC fell off page 1).
const PAGE_SIZE = 100;

/**
 * Read the LCM updates the player sees under Admin Center > LCM >
 * **"Prism Element Clusters"**, grouped the way that tab groups them, and
 * report whether that number is currently trustworthy.
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
 * …and the result is only meaningful when no inventory is running. A
 * "Perform Inventory" (any player can fire one from the LCM page; the install
 * runbook fires one per cluster at deploy) wipes `availableVersions` on every
 * entity of that cluster, then repopulates them module by module. Measured on
 * a 6-update HPoC: the count reads 0 for ~2m20s, then ramps 1 → 5 → 9 → 11
 * before settling back to 6, ~3.5 minutes end to end. Any answer compared
 * against that window is judged against noise — see issue #60.
 *
 * `settled` says whether we're inside such a window, from two signals:
 *   - the per-cluster LCM status reports an in-progress operation, which
 *     covers the whole window and nothing else;
 *   - LCM's own `hasAvailableUpgrades` flag contradicts our count, which only
 *     happens mid-rebuild (and catches the tail if the status call is unavailable).
 *
 * Returns `null` when LCM is unreachable, so callers fall back to format-only
 * validation (lenient) rather than a mis-scoped count (which would reject the
 * player's correct answer).
 *
 * Keep in sync with the pack-local copy in
 * `packs/ntnx-infiltration/checks/helpers.ts` if behaviour changes.
 */
export async function readLcmUpdates(
  nutanix: NutanixClient,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<LcmUpdatesReading | null> {
  const pe = await fetchPeClusters(nutanix, logger);
  if (pe === null) return null;
  const entities = await fetchAllLcmEntities(nutanix, logger);
  if (entities === null) return null;

  const count = dedupedUpdateCount(
    entities,
    new Set(pe.clusters.map((c) => c.extId)),
  );
  const settled = await isSettled(nutanix, pe.version, pe.clusters, count, logger);
  return { count, settled };
}

/**
 * Back-compat wrapper: the count when it can be trusted, `null` otherwise
 * (LCM unreachable *or* mid-inventory). Callers that cache the value — the
 * boot probe writes it to `cluster_config` with `setIfAbsent`, i.e. forever —
 * must never persist a count read mid-rebuild.
 */
export async function countLcmAvailableUpdates(
  nutanix: NutanixClient,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<number | null> {
  const reading = await readLcmUpdates(nutanix, logger);
  if (reading === null || !reading.settled) return null;
  return reading.count;
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

/**
 * Does `count` reflect a finished inventory? Pure half of the settled logic
 * (the busy flags come from the live status calls), exported for unit tests.
 *
 * A cluster whose `hasAvailableUpgrades` disagrees with what we counted is
 * mid-rebuild: LCM flips that flag to false the moment it wipes the entity
 * rows and only restores it once they're all back. An undefined flag (older
 * PC, mock fixtures) tells us nothing, so it never triggers.
 */
export function isReadingSettled(clusters: PeCluster[], count: number, anyBusy: boolean): boolean {
  if (anyBusy) return false;
  const flags = clusters.map((c) => c.hasAvailableUpgrades).filter((f) => typeof f === 'boolean');
  if (flags.length === 0) return true;
  if (count === 0 && flags.some((f) => f)) return false; // LCM has updates, we counted none
  if (count > 0 && flags.every((f) => !f)) return false; // we counted updates LCM doesn't have
  return true;
}

async function isSettled(
  nutanix: NutanixClient,
  version: string,
  clusters: PeCluster[],
  count: number,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<boolean> {
  const busy = await Promise.all(
    clusters.map((c) => clusterBusy(nutanix, version, c.extId, logger)),
  );
  const settled = isReadingSettled(clusters, count, busy.some((b) => b === true));
  if (!settled) {
    logger?.debug?.('LCM inventory data is mid-rebuild, count not trustworthy', { count });
  }
  return settled;
}

/**
 * Is LCM running an operation (inventory, upgrade) on this cluster? `status`
 * is **per-cluster and scoped by header**: without `X-Cluster-Id` PC answers
 * for the PCVM cluster only and reports idle all through a PE inventory (query
 * params don't work — the header is the only way). `null` when the status call
 * fails: unknown, so it doesn't by itself condemn the reading.
 */
async function clusterBusy(
  nutanix: NutanixClient,
  version: string,
  clusterExtId: string,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<boolean | null> {
  try {
    const res = await nutanix.request<{
      data?: { inProgressOperation?: { operationType?: string } };
    }>('GET', `/api/lifecycle/${version}/resources/status`, undefined, {
      'X-Cluster-Id': clusterExtId,
    });
    const op = res?.data?.inProgressOperation?.operationType;
    return typeof op === 'string' && op.length > 0;
  } catch (err) {
    logger?.debug?.('LCM status fetch failed, treating cluster as idle', {
      clusterExtId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Every PE cluster (clusterType === 'AOS'), plus the LCM API version that answered. */
async function fetchPeClusters(
  nutanix: NutanixClient,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<{ version: string; clusters: PeCluster[] } | null> {
  for (const v of LCM_VERSIONS) {
    try {
      const res = await nutanix.request<{ data?: LcmSummary[] }>(
        'GET',
        `/api/lifecycle/${v}/resources/lcm-summaries`,
      );
      const data = res?.data;
      if (!Array.isArray(data)) throw new Error('no data field');
      const clusters: PeCluster[] = [];
      for (const s of data) {
        if (s.clusterType === 'AOS' && s.clusterExtId) {
          clusters.push({ extId: s.clusterExtId, hasAvailableUpgrades: s.hasAvailableUpgrades });
        }
      }
      return { version: v, clusters };
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
      // Hard cap (100 pages × 100 = 10k entities, far past any real
      // inventory) so a misbehaving API that ignores paging can't spin us.
      for (let page = 0; page < 100; page++) {
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
