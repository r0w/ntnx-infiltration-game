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
 * Self-healing variable resolver: read `varName` from session vars first;
 * if missing/empty, look it up live on the cluster via `lookup` and persist
 * the recovered extId back to session vars (under `varName`, captured at
 * the current stage). Returns undefined when the resource isn't on the
 * cluster either — the caller decides whether to surface that as a check
 * failure or skip the assertion entirely.
 *
 * Why: stages capture UUIDs (NetworkUUID, ImageUUID, ProjectUUID, …) when
 * the upstream stage's check runs, but server restarts / DB migrations /
 * resumed sessions can leave a downstream check seeing an absent var even
 * though the resource exists. Re-discovering by name is invisible to the
 * player and avoids "run upstream stages first" diagnostics that confuse
 * the user when, from their POV, they DID run them.
 */
export async function recoverVar(
  ctx: CheckContext,
  varName: string,
  stageName: string,
  lookup: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const existing = ctx.vars.get(varName);
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const recovered = await lookup();
  if (recovered) {
    ctx.vars.set(varName, recovered, stageName);
    return recovered;
  }
  return undefined;
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
