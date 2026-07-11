import type { CheckContext, Logger, NutanixClient } from '@ntnx-game/engine';

/**
 * v3 endpoint response shape — `entities` holds the array instead of `data`
 * and is fetched via POST with a `{length, offset}` body. Used by NCM (Self-
 * Service Calm apps/blueprints/scheduler policies), X-Play action_rules, and
 * legacy IAM projects (not in the v4 SDK). The metadata wrapper mirrors v1/
 * v3 conventions; we ignore most of it and client-filter by name.
 */
export interface V3ListResponse<T> {
  entities?: T[];
  metadata?: { total_matches?: number; length?: number; offset?: number };
}

/**
 * POST a v3 list endpoint and return the `entities` array. `length` defaults
 * high enough to skip pagination for the small lists the pack touches (<100
 * projects, apps, blueprints per HPoC).
 */
export async function listAllV3<T>(
  ctx: CheckContext,
  path: string,
  length = 250,
): Promise<T[]> {
  const res = await ctx.nutanix.rest.request<V3ListResponse<T>>('POST', path, { length });
  return res?.entities ?? [];
}

/**
 * Reads the player's trigram from session variables. Stage 1 captures it via
 * `<input var='Trigram'/>`; every downstream check builds its expected entity
 * names from this value (e.g. `{Trigram}-adm`, `{Trigram}-proj`).
 */
export function getTrigram(ctx: CheckContext): string {
  const trigram = ctx.vars.get('Trigram');
  if (typeof trigram !== 'string' || trigram.length === 0) {
    throw new Error('Trigram not set — stage 1 (login) must run before any domain check.');
  }
  return trigram;
}

/**
 * GET a Nutanix v4 list endpoint, walking pages until exhausted, and return
 * the flat `data` array. v4 caps `$limit` at 100 per page, so any cluster
 * with >100 entities of a kind would silently fall off the first page —
 * a freshly-created `{trigram}-vm` on a HPoC carrying 184 VMs from prior
 * runs would never be found, causing false-negative checks.
 *
 * Strips any caller-provided `$limit`/`$page` and forces `$limit=100` per
 * page; loops `$page=N` from 0 until a short page comes back (or the
 * `metadata.totalAvailableResults` is reached). Capped at 200 pages
 * (= 20 000 entities) as a defensive upper bound — well past anything
 * we'd realistically see, and prevents an infinite loop on a misbehaving
 * endpoint that always claims `isTruncated`.
 */
export async function listAll<T>(ctx: CheckContext, path: string): Promise<T[]> {
  const PAGE = 100;
  const PAGE_CAP = 200;
  // Drop any caller-set $limit/$page — we own pagination here.
  const stripped = path
    .replace(/([?&])(?:\$limit|%24limit)=\d+/g, '$1')
    .replace(/([?&])(?:\$page|%24page)=\d+/g, '$1')
    .replace(/[?&]$/, '')
    .replace(/&&+/g, '&');
  const sep = stripped.includes('?') ? '&' : '?';
  const all: T[] = [];
  for (let page = 0; page < PAGE_CAP; page++) {
    const url = `${stripped}${sep}%24limit=${PAGE}&%24page=${page}`;
    const res = await ctx.nutanix.request<{
      data?: T[];
      metadata?: { totalAvailableResults?: number };
    }>('GET', url);
    const chunk = res.data ?? [];
    all.push(...chunk);
    if (chunk.length < PAGE) break;
    const total = res.metadata?.totalAvailableResults;
    if (typeof total === 'number' && all.length >= total) break;
  }
  return all;
}

/** Find the first entity with a matching name field, or undefined. */
export function findByName<T extends { name?: string }>(
  entities: readonly T[],
  name: string,
): T | undefined {
  return entities.find((e) => e.name === name);
}

/**
 * Flatten a Nutanix error into a single-line string suitable for a check
 * `detail` message. Avoids leaking stack traces into the user-facing UI.
 */
export function nutanixErrorDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Convenience: look up an entity by name, cache its UUID under the given
 * kind, and return the entity. Returns undefined if not found. Captures the
 * UUID into the engine's cluster_cache so downstream stages can reference
 * the same entity via `ctx.cache.get(kind, name)`.
 */
export function cacheEntity<T extends { extId?: string; name?: string }>(
  ctx: CheckContext,
  entities: readonly T[],
  name: string,
  kind: string,
): T | undefined {
  const found = findByName(entities, name);
  if (found && found.extId) {
    ctx.cache.set({ kind, logicalName: name, uuid: found.extId });
  }
  return found;
}

/**
 * Pick the locale-appropriate hint string from the inline map. Falls back
 * to `en` when the session's locale isn't represented in the map (e.g. a
 * pack adds a new locale without translating every check hint). Inline
 * map (rather than the locale-bundle catalog) keeps each check's hints
 * co-located with the assertion that produces them — when reviewing a
 * check, the player-facing strings are right there.
 */
export function localizedHint(
  ctx: CheckContext,
  hints: Record<string, string>,
): string {
  const locale = ctx.session.locale;
  return hints[locale] ?? hints.en ?? Object.values(hints)[0] ?? '';
}

/**
 * Resolve-by-name lookups (issue #31): the trigram-prefixed name is the
 * contract, stored UUIDs go stale when a resource is re-created.
 * Miss returns undefined; transport errors throw — don't conflate them.
 */
export async function lookupSubnetUuid(
  ctx: CheckContext,
  name: string,
): Promise<string | undefined> {
  const subnets = await listAll<{ extId?: string; name?: string }>(
    ctx,
    '/api/networking/v4.0/config/subnets',
  );
  return findByName(subnets, name)?.extId;
}

export async function lookupImageUuid(
  ctx: CheckContext,
  name: string,
): Promise<string | undefined> {
  const images = await listAll<{ extId?: string; name?: string }>(
    ctx,
    '/api/vmm/v4.0/content/images',
  );
  return findByName(images, name)?.extId;
}

/** v3 projects carry the name on spec/status/metadata depending on state. */
export async function lookupProjectUuid(
  ctx: CheckContext,
  name: string,
): Promise<string | undefined> {
  const projects = await listAllV3<{
    spec?: { name?: string };
    status?: { name?: string };
    metadata?: { name?: string; uuid?: string };
  }>(ctx, '/api/nutanix/v3/projects/list');
  return projects.find(
    (p) => p?.spec?.name === name || p?.status?.name === name || p?.metadata?.name === name,
  )?.metadata?.uuid;
}

/** v4 models each category key:value pair as its own entity. */
export async function lookupCategoryUuid(
  ctx: CheckContext,
  key: string,
  value: string,
): Promise<string | undefined> {
  const categories = await listAll<{ extId?: string; key?: string; value?: string }>(
    ctx,
    '/api/prism/v4.2/config/categories',
  );
  return categories.find((c) => c?.key === key && c?.value === value)?.extId;
}

export async function lookupProtectionPolicyUuid(
  ctx: CheckContext,
  name: string,
): Promise<string | undefined> {
  const policies = await listAll<{ extId?: string; name?: string }>(
    ctx,
    '/api/datapolicies/v4.2/config/protection-policies',
  );
  return findByName(policies, name)?.extId;
}

/** Self-Service apps live on v3; name is on status or metadata. */
export async function lookupAppUuid(
  ctx: CheckContext,
  name: string,
): Promise<string | undefined> {
  const apps = await listAllV3<{
    metadata?: { uuid?: string; name?: string };
    status?: { name?: string };
  }>(ctx, '/api/nutanix/v3/apps/list');
  return apps.find((a) => a?.status?.name === name || a?.metadata?.name === name)?.metadata
    ?.uuid;
}

/** For secondary assertions: transport error → `{failed: true}` (skip,
 *  logged), answer → `{uuid, failed: false}` with undefined = real miss. */
export async function lookupOrSkip(
  ctx: CheckContext,
  what: string,
  lookup: () => Promise<string | undefined>,
): Promise<{ uuid?: string; failed: boolean }> {
  try {
    return { uuid: await lookup(), failed: false };
  } catch (err) {
    ctx.logger.warn(`${what} lookup failed — skipping the assertion`, {
      err: nutanixErrorDetail(err).slice(0, 200),
    });
    return { failed: true };
  }
}

/** PC user uuid by username (case-insensitive) via v4 IAM.
 *  Miss → undefined, transport error → throw. */
export async function lookupUserUuid(
  ctx: CheckContext,
  name: string,
): Promise<string | undefined> {
  const users = await listAll<{ extId?: string; username?: string }>(
    ctx,
    '/api/iam/v4.0/authn/users',
  );
  return users.find((u) => (u?.username ?? '').toLowerCase() === name.toLowerCase())?.extId;
}

/**
 * Pack-local copy of the engine's `discoverableNodeSerials` (same body, same
 * semantics). Lives here because the pack module is dynamically loaded from
 * outside the Bun workspace boundary, so it can only type-import from
 * `@ntnx-game/engine` — value imports fail to resolve at runtime. Keep this
 * in sync with `packages/engine/src/discover-nodes.ts` if behavior changes.
 */
export async function discoverableNodeSerials(
  nutanix: NutanixClient,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<string[]> {
  if (nutanix.mode === 'mock') {
    const res = await nutanix.request<DiscoverTaskResponse>(
      'GET',
      `/api/clustermgmt/v4.2/config/task-response/mock-discover-task?taskResponseType=UNCONFIGURED_NODES`,
    );
    return extractSerials(res);
  }
  const clusters = await nutanix.request<{ data?: Array<{ extId?: string }> }>(
    'GET',
    '/api/clustermgmt/v4.0/config/clusters',
  );
  const clusterUuid = clusters.data?.[0]?.extId;
  if (!clusterUuid) throw new Error('discoverableNodeSerials: no cluster UUID');
  const discoverResp = await nutanix.request<{ data?: { extId?: string } }>(
    'POST',
    `/api/clustermgmt/v4.0.b2/config/clusters/${clusterUuid}/$actions/discover-unconfigured-nodes`,
    { timeout: 60, isManualDiscovery: false, addressType: 'IPV4' },
  );
  const taskExtId = discoverResp.data?.extId;
  if (!taskExtId) throw new Error('discoverableNodeSerials: discover task returned no extId');
  await pollDiscoverTask(nutanix, taskExtId, logger);
  const shortId = taskExtId.split(':').pop() ?? taskExtId;
  const respResp = await nutanix.request<DiscoverTaskResponse>(
    'GET',
    `/api/clustermgmt/v4.2/config/task-response/${shortId}?taskResponseType=UNCONFIGURED_NODES`,
  );
  return extractSerials(respResp);
}

interface DiscoverTaskResponse {
  data?: { response?: { nodeList?: Array<{ rackableUnitSerial?: string }> } };
}

function extractSerials(res: DiscoverTaskResponse | undefined): string[] {
  const list = res?.data?.response?.nodeList ?? [];
  const out: string[] = [];
  for (const n of list) {
    const s = n.rackableUnitSerial;
    if (typeof s === 'string' && s.trim().length > 0) out.push(s.trim());
  }
  return out;
}

async function pollDiscoverTask(
  nutanix: NutanixClient,
  taskExtId: string,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<void> {
  const taskPath = `/api/prism/v4.2/config/tasks/${taskExtId}`;
  const deadline = Date.now() + 3 * 60 * 1_000;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await nutanix.request<{ data?: { status?: string } }>('GET', taskPath);
      lastStatus = res?.data?.status;
      if (lastStatus === 'SUCCEEDED') return;
      if (lastStatus === 'FAILED' || lastStatus === 'CANCELED' || lastStatus === 'CANCELLED') {
        throw new Error(`discover task ${lastStatus}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('discover task ')) throw err;
      logger?.debug?.('discover task poll error, retrying', { err: msg.slice(0, 150) });
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`discover task timed out (last status: ${lastStatus ?? 'none'})`);
}

/** Shape we read off `/lifecycle/.../resources/entities` (only the counted fields). */
interface LcmEntity {
  entityType?: string;
  entityModel?: string;
  availableVersions?: unknown;
  clusterExtId?: string;
}

/** A PE cluster as LCM sees it. `hasAvailableUpgrades` is undefined on older PCs. */
interface PeCluster {
  extId: string;
  hasAvailableUpgrades?: boolean;
}

/** A count, plus whether the inventory data behind it can be trusted. */
export interface LcmUpdatesReading {
  count: number;
  settled: boolean;
}

/**
 * Pack-local copy of the engine's `readLcmUpdates` (see the note on
 * `discoverableNodeSerials` above for why the pack carries its own copy).
 * Counts the "Prism Element Clusters" LCM updates the player sees: paginate all
 * entities, keep only PE clusters (`clusterType === 'AOS'` per lcm-summaries —
 * the PCVM is itself an AOS-software cluster so locationType can't tell the tabs
 * apart), dedup per-node rows by (cluster, type, model).
 *
 * `settled` is false while an inventory is rebuilding the data, when the count
 * is noise (issue #60); see `clusterSettled`. Returns null when LCM can't be
 * read, so the caller falls back to format-only validation. Keep in sync with
 * `packages/engine/src/lcm-updates.ts`.
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
  const entities = await fetchLcmEntities(nutanix, logger);
  if (entities === null) return null;

  const count = dedupedUpdateCount(entities, new Set(pe.clusters.map((c) => c.extId)));
  // Judged per cluster, never on the aggregate: a healthy PE would otherwise
  // mask a neighbour that is still rebuilding.
  const readings = await Promise.all(
    pe.clusters.map(async (cluster) => ({
      cluster,
      count: dedupedUpdateCount(entities, new Set([cluster.extId])),
      busy: await clusterBusy(nutanix, pe.version, cluster.extId, logger),
    })),
  );
  const settled = readings.every(clusterSettled);
  if (!settled) {
    // A running inventory explains itself; anything else means our count and LCM
    // disagree with no operation behind it, and the stage then quietly stops
    // validating — the operator needs to see that one.
    const msg = 'LCM update count is not trustworthy';
    if (readings.some((r) => r.busy === true)) logger?.debug?.(msg, { clusters: readings });
    else logger?.warn?.(msg, { clusters: readings });
  }
  return { count, settled };
}

/** Updates on `peClusters`, deduped the way the LCM tab groups them: one row per
 *  (cluster, type, model), so the same NIC firmware on 3 nodes counts once. */
function dedupedUpdateCount(entities: LcmEntity[], peClusters: Set<string>): number {
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

/** Is this cluster's slice of the count trustworthy? Mirrors the engine's `isReadingSettled`. */
function clusterSettled(r: { cluster: PeCluster; count: number; busy: boolean | null }): boolean {
  if (r.busy === true) return false;
  // LCM's own flag disagreeing with what we counted only happens mid-rebuild.
  // Undefined (older PC, mock fixtures) tells us nothing.
  const flag = r.cluster.hasAvailableUpgrades;
  if (flag === true && r.count === 0) return false;
  if (flag === false && r.count > 0) return false;
  // Status unavailable and nothing counted: LCM drops the flag during the wipe
  // too, so neither signal separates a wiped cluster from an up-to-date one.
  return !(r.busy === null && r.count === 0);
}

/**
 * Is LCM running an operation (inventory, upgrade) on this cluster? `status` is
 * scoped by header: without `X-Cluster-Id` PC answers for the PCVM cluster only
 * and reports idle all through a PE inventory. `null` = the call failed, i.e.
 * unknown, which `clusterSettled` treats as a reason for caution, not as idle.
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

async function fetchLcmEntities(
  nutanix: NutanixClient,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<LcmEntity[] | null> {
  for (const v of ['v4.2', 'v4.0']) {
    try {
      const all: LcmEntity[] = [];
      // Hard cap (100 pages × 100 = 10k entities, far past any real
      // inventory) so a misbehaving API that ignores paging can't spin us.
      for (let page = 0; page < 100; page++) {
        const res = await nutanix.request<{ data?: LcmEntity[] }>(
          'GET',
          `/api/lifecycle/${v}/resources/entities?$limit=100&$page=${page}`,
        );
        const batch = res?.data;
        if (!Array.isArray(batch)) {
          if (page === 0) throw new Error('no data field');
          break;
        }
        all.push(...batch);
        if (batch.length < 100) break;
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

/** Every PE cluster (clusterType === 'AOS'), plus the LCM API version that answered. */
async function fetchPeClusters(
  nutanix: NutanixClient,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<{ version: string; clusters: PeCluster[] } | null> {
  for (const v of ['v4.2', 'v4.0']) {
    try {
      const res = await nutanix.request<{
        data?: Array<{
          clusterExtId?: string;
          clusterType?: string;
          hasAvailableUpgrades?: boolean;
        }>;
      }>('GET', `/api/lifecycle/${v}/resources/lcm-summaries`);
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
