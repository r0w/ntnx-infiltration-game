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
 * Resolve-by-name lookups (issue #31). Checks used to trust UUID vars
 * captured once by upstream stages; if the player re-created the resource
 * the stored UUID went stale and the check false-failed. The trigram-
 * prefixed name is the real contract with the player, so consumers resolve
 * it fresh at check time instead. Miss and transport errors both return
 * undefined — the caller either skips the assertion or fails with a clear
 * "resource not found" message when the binding is the point of the stage.
 */
export async function lookupSubnetUuid(
  ctx: CheckContext,
  name: string,
): Promise<string | undefined> {
  try {
    const subnets = await listAll<{ extId?: string; name?: string }>(
      ctx,
      '/api/networking/v4.0/config/subnets',
    );
    return findByName(subnets, name)?.extId;
  } catch {
    return undefined;
  }
}

export async function lookupImageUuid(
  ctx: CheckContext,
  name: string,
): Promise<string | undefined> {
  try {
    const images = await listAll<{ extId?: string; name?: string }>(
      ctx,
      '/api/vmm/v4.0/content/images',
    );
    return findByName(images, name)?.extId;
  } catch {
    return undefined;
  }
}

/** v3 projects carry the name on spec/status/metadata depending on state. */
export async function lookupProjectUuid(
  ctx: CheckContext,
  name: string,
): Promise<string | undefined> {
  try {
    const projects = await listAllV3<{
      spec?: { name?: string };
      status?: { name?: string };
      metadata?: { name?: string; uuid?: string };
    }>(ctx, '/api/nutanix/v3/projects/list');
    return projects.find(
      (p) => p?.spec?.name === name || p?.status?.name === name || p?.metadata?.name === name,
    )?.metadata?.uuid;
  } catch {
    return undefined;
  }
}

/** v4 models each category key:value pair as its own entity. */
export async function lookupCategoryUuid(
  ctx: CheckContext,
  key: string,
  value: string,
): Promise<string | undefined> {
  try {
    const categories = await listAll<{ extId?: string; key?: string; value?: string }>(
      ctx,
      '/api/prism/v4.2/config/categories',
    );
    return categories.find((c) => c?.key === key && c?.value === value)?.extId;
  } catch {
    return undefined;
  }
}

export async function lookupProtectionPolicyUuid(
  ctx: CheckContext,
  name: string,
): Promise<string | undefined> {
  try {
    const policies = await listAll<{ extId?: string; name?: string }>(
      ctx,
      '/api/datapolicies/v4.2/config/protection-policies',
    );
    return findByName(policies, name)?.extId;
  } catch {
    return undefined;
  }
}

/** Self-Service apps live on v3; name is on status or metadata. */
export async function lookupAppUuid(
  ctx: CheckContext,
  name: string,
): Promise<string | undefined> {
  try {
    const apps = await listAllV3<{
      metadata?: { uuid?: string; name?: string };
      status?: { name?: string };
    }>(ctx, '/api/nutanix/v3/apps/list');
    return apps.find((a) => a?.status?.name === name || a?.metadata?.name === name)?.metadata
      ?.uuid;
  } catch {
    return undefined;
  }
}

/** Look up a PC user's uuid by username (case-insensitive) via v4 IAM.
 *  Returns undefined on miss/error so callers can degrade gracefully. */
export async function lookupUserUuid(
  ctx: CheckContext,
  name: string,
): Promise<string | undefined> {
  try {
    const users = await listAll<{ extId?: string; username?: string }>(
      ctx,
      '/api/iam/v4.0/authn/users',
    );
    return users.find((u) => (u.username ?? '').toLowerCase() === name.toLowerCase())?.extId;
  } catch {
    return undefined;
  }
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

/**
 * Pack-local copy of the engine's `countLcmAvailableUpdates` (same body, same
 * semantics — see the note on `discoverableNodeSerials` above for why the pack
 * carries its own copy). Counts the "Prism Element Clusters" LCM updates the
 * player sees: paginate all entities, keep only PE clusters
 * (`clusterType === 'AOS'` per lcm-summaries — the PCVM is itself an AOS-
 * software cluster so locationType can't tell the tabs apart), dedup per-node
 * rows by (cluster, type, model). Returns null when LCM is unreachable so the
 * caller falls back to format-only validation. Keep in sync with
 * `packages/engine/src/lcm-updates.ts`.
 */
export async function countLcmAvailableUpdates(
  nutanix: NutanixClient,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<number | null> {
  const entities = await fetchLcmEntities(nutanix, logger);
  if (entities === null) return null;
  const peClusters = await fetchPeClusterIds(nutanix, logger);
  if (peClusters === null) return null;
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

/** clusterExtId set for every PE cluster (clusterType === 'AOS'). */
async function fetchPeClusterIds(
  nutanix: NutanixClient,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<Set<string> | null> {
  for (const v of ['v4.2', 'v4.0']) {
    try {
      const res = await nutanix.request<{
        data?: Array<{ clusterExtId?: string; clusterType?: string }>;
      }>('GET', `/api/lifecycle/${v}/resources/lcm-summaries`);
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
