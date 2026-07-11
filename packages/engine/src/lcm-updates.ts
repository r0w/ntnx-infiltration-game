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
  /** False while LCM is rebuilding its entity list: the count is then noise. */
  settled: boolean;
}

// v4.0.a1 404s on PC 7.5; v4.2 + v4.0 both answer with the same shape.
const LCM_VERSIONS = ['v4.2', 'v4.0'];
// PC caps $limit at 100; the default page is 50, which silently truncated
// a 94-entity inventory (FSM/NCC/Foundation/PC fell off page 1).
const PAGE_SIZE = 100;

/**
 * Read the LCM updates the player sees under Admin Center > LCM >
 * **"Prism Element Clusters"**, grouped the way that tab groups them.
 *
 * The raw entities list needs three corrections: **paginate** (not just the
 * first 50), **scope** to PE clusters (`clusterType === 'AOS'` per
 * lcm-summaries — the PCVM is itself an AOS-software cluster, so only that
 * flag tells the two LCM tabs apart), and **dedup** per-node rows (the same NIC
 * firmware on 3 nodes is ONE update on screen) by (cluster, type, model).
 *
 * `settled` is false while an inventory is rebuilding the data, when the count
 * is noise: LCM wipes `availableVersions` cluster-wide, then repopulates module
 * by module, overshooting before it lands (issue #60). See `isReadingSettled`
 * for how we spot it.
 *
 * Returns `null` when LCM can't be read at all, so callers fall back to
 * format-only validation rather than reject a correct answer.
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
  // No PE cluster at all is not "nothing to update" — it's LCM answering with
  // something we don't understand. Treat it like unreachable, or a degraded
  // lcm-summaries would hand every player a confident zero.
  if (pe.clusters.length === 0) {
    logger?.warn?.('LCM reports no PE cluster, treating the update count as unreadable');
    return null;
  }
  const entities = await fetchAllLcmEntities(nutanix, logger);
  if (entities === null) return null;

  const count = dedupedUpdateCount(
    entities,
    new Set(pe.clusters.map((c) => c.extId)),
  );
  const settled = await isSettled(nutanix, pe.version, pe.clusters, entities, logger);
  return { count, settled };
}

/**
 * The count when it can be trusted, `null` otherwise (LCM unreadable *or*
 * mid-inventory). For callers that persist it: the boot probe caches it with
 * `setIfAbsent`, i.e. once and forever, so a mid-rebuild count must never leak.
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

/** What we know about one PE cluster at read time. */
export interface PeClusterReading {
  cluster: PeCluster;
  /** Updates counted on *this* cluster alone. */
  count: number;
  /** LCM's status for it: running an operation, idle, or `null` = couldn't ask. */
  busy: boolean | null;
}

/**
 * Does the reading reflect a finished inventory? Pure half of the settled logic
 * (the busy flags come from the live status calls), exported for unit tests.
 * Judged per cluster, never on the aggregate: a healthy PE would otherwise mask
 * a neighbour that is still rebuilding.
 */
export function isReadingSettled(readings: PeClusterReading[]): boolean {
  return (
    readings.length > 0 &&
    readings.every(({ cluster, count, busy }) => {
      if (busy === true) return false;
      // LCM's own flag disagreeing with what we counted only happens
      // mid-rebuild. Undefined (older PC, mock fixtures) tells us nothing.
      const flag = cluster.hasAvailableUpgrades;
      if (flag === true && count === 0) return false;
      if (flag === false && count > 0) return false;
      // Status unavailable and nothing counted: LCM drops the flag during the
      // wipe too, so neither signal separates a wiped cluster from an
      // up-to-date one. Don't gamble the player's answer on it.
      return !(busy === null && count === 0);
    })
  );
}

async function isSettled(
  nutanix: NutanixClient,
  version: string,
  clusters: PeCluster[],
  entities: LcmEntity[],
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<boolean> {
  const readings = await Promise.all(
    clusters.map(async (cluster): Promise<PeClusterReading> => ({
      cluster,
      count: dedupedUpdateCount(entities, new Set([cluster.extId])),
      busy: await clusterBusy(nutanix, version, cluster.extId, logger),
    })),
  );
  if (isReadingSettled(readings)) return true;
  // A running inventory explains itself; anything else means our count and LCM
  // disagree with no operation behind it, and the stage then quietly stops
  // validating — the operator needs to see that one.
  const msg = 'LCM update count is not trustworthy';
  if (readings.some((r) => r.busy === true)) logger?.debug?.(msg, { clusters: readings });
  else logger?.warn?.(msg, { clusters: readings });
  return false;
}

/**
 * Is LCM running an operation (inventory, upgrade) on this cluster? `status` is
 * scoped by header: without `X-Cluster-Id` PC answers for the PCVM cluster only
 * and reports idle all through a PE inventory (query params don't work, the
 * header is the only way). `null` = the call failed, i.e. unknown, which
 * `clusterSettled` treats as a reason for caution, not as idle.
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
    logger?.debug?.('LCM status fetch failed, cluster state unknown', {
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
