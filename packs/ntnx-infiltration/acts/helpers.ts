import type { ActContext } from '@ntnx-game/engine';

/**
 * Pull the player's trigram from session vars. All act handlers build
 * resource names from this — if missing, acts have nothing to do (stage 1
 * hasn't run yet in a fresh session).
 */
export function getTrigram(ctx: ActContext): string | undefined {
  const t = ctx.vars.get('Trigram');
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

/**
 * Read a session variable as a string or return undefined. Used for fields
 * like `ImageURL`, `Vlanid`, `Username` that acts pull from env-seeded vars
 * or from upstream stage captures.
 */
export function getVarString(ctx: ActContext, name: string): string | undefined {
  const v = ctx.vars.get(name);
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

/**
 * Unwrap the SDK's double envelope on list responses (`res.data.data`).
 * Live adapter produces this shape; mock adapter rebuilds it from the flat
 * fixture `{data: [...]}` so acts work in both modes.
 */
export function unwrapList<T>(res: unknown): T[] {
  const r = res as { data?: { data?: T[] } } | undefined;
  return r?.data?.data ?? [];
}

/** Unwrap a single-entity SDK response (`res.data.data`). */
export function unwrapOne<T>(res: unknown): T | undefined {
  const r = res as { data?: { data?: T } } | undefined;
  return r?.data?.data;
}

/**
 * Walk every page of an SDK list endpoint and return the flat array. v4
 * caps `$limit` at 100 per page, so any cluster with >100 entities of a
 * kind would silently fall off the first page — on a HPoC accumulating
 * VMs across runs (184 VMs as of 2026-04-26), a freshly-POSTed `zz4-vm`
 * lands on page 2+ and ensure() couldn't see it, leading to duplicate
 * POSTs and orphan VMs.
 *
 * Pass a `fetchPage` closure that calls the SDK list method with the
 * given pagination params:
 *
 *   const all = await listAllSdk<VM>(p => sdk(ctx).vmm.vms.listVms(p));
 *
 * Page-cap at 200 (= 20 000 entities) defensive upper bound.
 */
export async function listAllSdk<T>(
  fetchPage: (params: { '$limit': number; '$page': number }) => Promise<unknown>,
): Promise<T[]> {
  const PAGE = 100;
  const PAGE_CAP = 200;
  const all: T[] = [];
  for (let page = 0; page < PAGE_CAP; page++) {
    const res = await fetchPage({ '$limit': PAGE, '$page': page });
    const chunk = unwrapList<T>(res);
    all.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  return all;
}

/**
 * Walk every page of a v3 `.../list` endpoint. v3 lists take `length`+`offset`
 * and report `metadata.total_matches`; a flat `{ length: 250 }` silently drops
 * entity 251+ on a cluster that has piled up apps/blueprints/jobs across many
 * sessions, so a cleanup filtering client-side would miss (leak) its target.
 * Loop until we've pulled total_matches or a page comes back short.
 */
export async function listAllV3<T = unknown>(
  ctx: ActContext,
  path: string,
  body: Record<string, unknown> = {},
): Promise<T[]> {
  const PAGE = 250;
  const all: T[] = [];
  for (let offset = 0; offset < 20000; offset += PAGE) {
    const res = await ctx.nutanix.rest.request<{
      entities?: T[];
      metadata?: { total_matches?: number };
    }>('POST', path, { ...body, length: PAGE, offset });
    const chunk = res.entities ?? [];
    all.push(...chunk);
    const total = res.metadata?.total_matches;
    if (chunk.length < PAGE) break;
    if (typeof total === 'number' && all.length >= total) break;
  }
  return all;
}

/**
 * Walk every page of a v4 `.../list`-style GET reached via `rest.request` (for
 * domains with no SDK client, e.g. dataprotection). v4 lists cap `$limit` at
 * 100 and default to 50, so a bare GET silently drops entities past the first
 * page: a cleanup filtering client-side would miss (leak) its target on a
 * cluster that piles entities up across sessions. Returns the flat `data` array.
 */
export async function listAllV4Rest<T = unknown>(ctx: ActContext, path: string): Promise<T[]> {
  const PAGE = 100;
  const all: T[] = [];
  for (let page = 0; page < 200; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await ctx.nutanix.rest.request<{
      data?: T[];
      metadata?: { totalAvailableResults?: number };
    }>('GET', `${path}${sep}$page=${page}&$limit=${PAGE}`);
    const chunk = res.data ?? [];
    all.push(...chunk);
    const total = res.metadata?.totalAvailableResults;
    if (chunk.length < PAGE) break;
    if (typeof total === 'number' && all.length >= total) break;
  }
  return all;
}

/**
 * Pulls the `status: SUCCEEDED|FAILED` from a v4 task-tracked response. Many
 * v4 mutating endpoints return a task ref instead of the final entity; we
 * poll `/api/prism/v4.2/config/tasks/:extId` until terminal. Not used by
 * most acts (the SDK methods we call already wait) but kept for the few
 * that don't.
 */
export async function waitForTask(
  ctx: ActContext,
  taskExtId: string,
  timeoutMs = 60000,
): Promise<{ status?: string; errorMessages?: unknown[] }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await ctx.nutanix.rest.request<{
      data?: { status?: string; errorMessages?: unknown[] };
      // Pass the task extId raw: PC matches the literal `<base64>:<uuid>`
      // segment, as discover-nodes.ts and checks/helpers.ts poll it. Percent-
      // encoding the `:`/`=` would 404 the lookup on this route.
    }>('GET', `/api/prism/v4.2/config/tasks/${taskExtId}`);
    const status = res?.data?.status;
    if (status && /SUCCEED|SUCCESS|COMPLETE/i.test(status)) return res.data ?? {};
    if (status && /FAIL|ERROR|CANCEL/i.test(status)) {
      throw new Error(`Task ${taskExtId} terminal: ${status}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Task ${taskExtId} timed out after ${timeoutMs}ms`);
}

/**
 * Common flow: list entities, return the one matching `match` if present,
 * otherwise call `create` and return its result. Makes every act idempotent
 * without the handler writing the same `if (found) return found;` each time.
 */
export async function ensure<T>(opts: {
  list: () => Promise<T[]>;
  match: (item: T) => boolean;
  create: () => Promise<T | undefined>;
  logger?: { info: (msg: string, data?: unknown) => void };
  name: string;
}): Promise<T | undefined> {
  const items = await opts.list();
  const existing = items.find(opts.match);
  if (existing) {
    opts.logger?.info(`act noop: ${opts.name} already exists`);
    return existing;
  }
  opts.logger?.info(`act create: ${opts.name}`);
  return opts.create();
}

/**
 * Delete a Nutanix v4 entity by extId with proper `If-Match` ETag handling.
 * v4 endpoints enforce optimistic concurrency — `DELETE /<path>/<extId>`
 * returns 428 Precondition Required without `If-Match`, and 412 Precondition
 * Failed with a stale one. The real value comes from the `etag:` response
 * header on the GET-by-id call, but only the hash SUFFIX after the
 * `<prefix>:` separator is accepted by DELETE (not the full header value).
 *
 * Works in live mode via a raw fetch (so we can read response headers that
 * `rest.request()` swallows). In mock mode it's a no-op — the fixture store
 * doesn't model ETags.
 */
/**
 * POST to a v4 endpoint and return the parsed response body. Wraps direct
 * fetch (not `rest.request()`) because several v4 domains — notably
 * `datapolicies` and `opsmgmt` — require an `Ntnx-Request-Id` UUID header
 * for idempotency on every mutating call, which the `rest-adapter` doesn't
 * set. Using fetch directly lets us add it without bloating the shared
 * rest transport.
 *
 * Why not SDK: the generated SDK's error-wrap code mutates a frozen Bun
 * response-error (`err.data = ...`), uncaught TypeError crashes the
 * process. REST-via-fetch throws a clean Error with the response body —
 * caller's try/catch turns it into a structured `ok:false` payload.
 */
export async function postV4<T = unknown>(
  ctx: ActContext,
  path: string,
  body: unknown,
): Promise<T> {
  const pcEndpoint = getVarString(ctx, 'PC');
  const user = getVarString(ctx, 'PCUser');
  const password = getVarString(ctx, 'PCPassword');
  if (!pcEndpoint || !user || !password) {
    throw new Error('postV4: PC credentials missing in vars (PC / PCUser / PCPassword)');
  }
  const base = pcEndpoint.replace(/\/+$/, '');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const auth = `Basic ${btoa(`${user}:${password}`)}`;
  const init = {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Ntnx-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
    tls: { rejectUnauthorized: false },
  } as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await fetch(url, init as any);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Nutanix POST ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * POST a v4 action (e.g. `$actions/power-on`, `$actions/associate-categories`)
 * that requires `If-Match` optimistic concurrency. Flow:
 *   1. GET the resource to read the current `etag` response header
 *   2. POST the action with `If-Match: <full etag header value>` + the
 *      idempotency UUID, omitting the request body when no payload is
 *      expected (v4 rejects `{}` on bodyless actions with a schema error).
 * `resourcePath` is the GET path (`/vmm/v4.2/ahv/config/vms/{extId}`),
 * `actionPath` is the action suffix (`$actions/power-on`). Note the VM
 * actions live on v4.2, not v4.0 — the v4.0 counterparts return 404.
 */
export async function postV4Action<T = unknown>(
  ctx: ActContext,
  resourcePath: string,
  actionPath: string,
  body?: unknown,
): Promise<T> {
  const pcEndpoint = getVarString(ctx, 'PC');
  const user = getVarString(ctx, 'PCUser');
  const password = getVarString(ctx, 'PCPassword');
  if (!pcEndpoint || !user || !password) {
    throw new Error('postV4Action: PC credentials missing in vars');
  }
  const base = pcEndpoint.replace(/\/+$/, '');
  const auth = `Basic ${btoa(`${user}:${password}`)}`;
  // Step 1: GET resource for ETag
  const getUrl = `${base}${resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`}`;
  const getInit = {
    method: 'GET',
    headers: { Authorization: auth, Accept: 'application/json' },
    tls: { rejectUnauthorized: false },
  } as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getRes = await fetch(getUrl, getInit as any);
  if (!getRes.ok) {
    throw new Error(`postV4Action: GET ${resourcePath} failed (${getRes.status})`);
  }
  const etag = getRes.headers.get('etag') ?? '';
  // Step 2: POST action with If-Match + Request-Id
  const actionUrl = `${base}${resourcePath}/${actionPath.startsWith('/') ? actionPath.slice(1) : actionPath}`;
  const headers: Record<string, string> = {
    Authorization: auth,
    'If-Match': etag,
    'Ntnx-Request-Id': crypto.randomUUID(),
    Accept: 'application/json',
  };
  const init: {
    method: string;
    headers: Record<string, string>;
    tls: { rejectUnauthorized: boolean };
    body?: string;
  } = {
    method: 'POST',
    headers,
    tls: { rejectUnauthorized: false },
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await fetch(actionUrl, init as any);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`postV4Action ${actionPath} failed: ${res.status} ${text}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json')) return (await res.json()) as T;
  return undefined as T;
}

/**
 * PUT to a v4 endpoint with dual-attempt `If-Match` handling (full ETag
 * header value first, stripped hash fallback) — the same pattern as
 * `deleteV4Entity`, because v4 ETag conventions vary by domain:
 *   - IAM accepts the stripped hash suffix
 *   - VMM/microseg/security require the full `etag:<prefix>:<hash>` value
 * Callers pass the raw header value (whatever `etag` header came back on
 * GET); the helper strips on fallback. Same rationale for using direct
 * fetch: the generated SDK crashes Bun on non-2xx.
 */
export async function putV4<T = unknown>(
  ctx: ActContext,
  path: string,
  etagHeaderValue: string,
  body: unknown,
): Promise<T> {
  const pcEndpoint = getVarString(ctx, 'PC');
  const user = getVarString(ctx, 'PCUser');
  const password = getVarString(ctx, 'PCPassword');
  if (!pcEndpoint || !user || !password) {
    throw new Error('putV4: PC credentials missing in vars');
  }
  const base = pcEndpoint.replace(/\/+$/, '');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const auth = `Basic ${btoa(`${user}:${password}`)}`;
  const hashOnly = etagHeaderValue.includes(':')
    ? etagHeaderValue.slice(etagHeaderValue.lastIndexOf(':') + 1)
    : etagHeaderValue;
  const mkInit = (ifMatch: string) =>
    ({
      method: 'PUT',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'If-Match': ifMatch,
        'Ntnx-Request-Id': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
      tls: { rejectUnauthorized: false },
    }) as const;
  // Attempt 1: full header value (works for vmm/microseg/security/prism)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let res = await fetch(url, mkInit(etagHeaderValue) as any);
  if (!res.ok && res.status === 412 && hashOnly !== etagHeaderValue) {
    // Attempt 2: stripped hash (IAM style)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res = await fetch(url, mkInit(hashOnly) as any);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/**
 * GET a v4 entity by extId and return both the body and the ETag hash
 * suffix from the response header. Needed for update/delete flows that
 * must echo `If-Match`.
 */
export async function getV4WithEtag<T = unknown>(
  ctx: ActContext,
  path: string,
): Promise<{ body: T; etag: string; etagHash: string } | undefined> {
  const pcEndpoint = getVarString(ctx, 'PC');
  const user = getVarString(ctx, 'PCUser');
  const password = getVarString(ctx, 'PCPassword');
  if (!pcEndpoint || !user || !password) return undefined;
  const base = pcEndpoint.replace(/\/+$/, '');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const auth = `Basic ${btoa(`${user}:${password}`)}`;
  const init = {
    method: 'GET',
    headers: { Authorization: auth, Accept: 'application/json' },
    tls: { rejectUnauthorized: false },
  } as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await fetch(url, init as any);
  if (!res.ok) return undefined;
  const body = (await res.json()) as T;
  const etag = res.headers.get('etag') ?? '';
  const etagHash = etag.includes(':') ? etag.slice(etag.lastIndexOf(':') + 1) : etag;
  // Return both forms — `etag` is the raw header value (what vmm/microseg/
  // security/prism accept), `etagHash` is the stripped suffix (what IAM
  // accepts). `putV4` / `deleteV4Entity` try full → stripped, so passing
  // the raw `etag` is the right default.
  return { body, etag, etagHash };
}

export async function deleteV4Entity(
  ctx: ActContext,
  path: string,
  extId: string,
): Promise<boolean> {
  if (ctx.nutanix.mode === 'mock') return true;
  const pcEndpoint = getVarString(ctx, 'PC');
  const user = getVarString(ctx, 'PCUser');
  const password = getVarString(ctx, 'PCPassword');
  if (!pcEndpoint || !user || !password) {
    ctx.logger.warn('deleteV4Entity: PC/PCUser/PCPassword missing in vars');
    return false;
  }
  const base = pcEndpoint.replace(/\/+$/, '');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}/${extId}`;
  const auth = `Basic ${btoa(`${user}:${password}`)}`;
  const init = {
    method: 'GET',
    headers: { Authorization: auth, Accept: 'application/json' },
    tls: { rejectUnauthorized: false },
  } as const;
  // Use fetch directly so we can read headers. `tls` is a Bun extension.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getRes = await fetch(url, init as any);
  if (!getRes.ok) {
    ctx.logger.warn('deleteV4Entity GET failed', { path, extId, status: getRes.status });
    return false;
  }
  // v4 ETag conventions vary across domains:
  //   - IAM: DELETE accepts `If-Match: <hash>` (stripped suffix)
  //   - VMM: DELETE requires `If-Match: <full header value>` (prefix:hash)
  //   - prism categories: quoted hash, also accepts full value
  // Try the full header value first — it works for VMM/prism/security —
  // then fall back to the stripped suffix (IAM users, auth-policies).
  // 404 on first attempt is treated as success (idempotent cleanup).
  const headerEtag = getRes.headers.get('etag') ?? '';
  if (!headerEtag) {
    ctx.logger.warn('deleteV4Entity: no ETag on GET', { path, extId });
    return false;
  }
  const hashOnly = headerEtag.includes(':')
    ? headerEtag.slice(headerEtag.lastIndexOf(':') + 1)
    : headerEtag;
  const mkInit = (ifMatch: string) =>
    ({
      method: 'DELETE',
      headers: {
        Authorization: auth,
        'If-Match': ifMatch,
        // Mutating v4 endpoints in datapolicies/opsmgmt/security require
        // an idempotency UUID; IAM and vmm don't care but tolerate the
        // header. Add universally.
        'Ntnx-Request-Id': crypto.randomUUID(),
      },
      tls: { rejectUnauthorized: false },
    }) as const;
  // Attempt 1: full header value
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let delRes = await fetch(url, mkInit(headerEtag) as any);
  if (!delRes.ok && delRes.status === 412 && hashOnly !== headerEtag) {
    // Attempt 2: stripped hash (IAM style)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delRes = await fetch(url, mkInit(hashOnly) as any);
  }
  if (delRes.status === 404) return true;
  if (delRes.ok) {
    // A 202 means the delete is still running: v4 hands back a task and the
    // entity isn't gone yet. Returning now lets the next cleanup race it: the
    // VM delete 202s, the subnet delete fires while the VM still holds its
    // NICs, and the subnet leaks (looks like an ordering bug, isn't one). Wait
    // the task out so the serial chain is actually serial. 200/204 have no task.
    if (delRes.status === 202) {
      const taskExtId = await delRes
        .json()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((b: any) => b?.data?.extId as string | undefined)
        .catch(() => undefined);
      // Best-effort: the DELETE is already accepted (202). We poll only to
      // serialize the next dependent cleanup (subnet after VM). A slow, failed,
      // or unconfirmable task must not flip an accepted delete into an error.
      if (taskExtId) {
        try {
          await waitForTask(ctx, taskExtId);
        } catch (err) {
          ctx.logger.warn('deleteV4Entity: delete task did not confirm', {
            path,
            err: String(err).slice(0, 150),
          });
        }
      }
    }
    return true;
  }
  const body = await delRes.text().catch(() => '');
  // Throw so the per-stage `try/catch` in `/cleanup-all/:trigram` surfaces
  // this as `ok:false` in the results — previously we returned false and
  // the caller (`deleteByName`) swallowed it, leaving operators with a
  // misleading "all clean" report while resources stayed on the cluster.
  // Live regression: 2026-05-18 on 10.38.66.7 where networking v4 DELETEs
  // rejected `NTNX-Request-Id` (case-sensitive — `Ntnx-Request-Id` works) →
  // silently failed → VPCs/subnets leaked despite `failures: 0` reporting.
  throw new Error(
    `deleteV4Entity ${path}/${extId}: HTTP ${delRes.status} — ${body.slice(0, 200)}`,
  );
}
