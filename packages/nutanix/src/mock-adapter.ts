import { readFileSync, existsSync } from 'node:fs';
import type { NutanixClient, NutanixSdkSurface } from '@ntnx-game/engine';

/**
 * Map from "METHOD path" to response body. Exact path match; no query-string
 * normalisation for now (keep the test harness predictable).
 */
export type MockFixtures = Record<string, unknown>;

/**
 * Build a fake SDK domain tree that routes each method call through the
 * mock `request()` to the fixture store. Structure mirrors the real
 * `NutanixSdk` shape in sdk-adapter.ts — resources return objects whose
 * methods translate `listFoo()` / `createFoo()` / `deleteFooById()` into
 * corresponding REST calls. The SDK envelope `{ data: { data: [...] } }`
 * is reconstructed so checks/seeds written against the SDK shape work in
 * mock mode too.
 *
 * Only the resources the pack actually uses are wired; adding a new SDK
 * call means extending this and the real sdk-adapter together.
 */
function buildMockSdk(request: NutanixClient['request']): NutanixSdkSurface {
  /** Wrap a raw fixture response `{data: [...]}` into the SDK double-envelope. */
  async function list<T>(path: string): Promise<{ data: { data: T[]; resultsTotal: number } }> {
    const raw = await request<{ data?: T[] }>('GET', path);
    const items = raw?.data ?? [];
    return { data: { data: items, resultsTotal: items.length } };
  }
  async function getOne<T>(path: string): Promise<{ data: { data: T } }> {
    const raw = await request<T>('GET', path);
    return { data: { data: raw } };
  }
  async function createOne<T>(path: string, body: unknown): Promise<{ data: { data: T } }> {
    const raw = await request<T>('POST', path, body);
    return { data: { data: raw } };
  }
  async function deleteOne<T>(path: string): Promise<{ data: { data: T | undefined } }> {
    const raw = await request<T | undefined>('DELETE', path);
    return { data: { data: raw } };
  }
  async function update<T>(path: string, body: unknown): Promise<{ data: { data: T } }> {
    const raw = await request<T>('PUT', path, body);
    return { data: { data: raw } };
  }

  return {
    iam: {
      users: {
        listUsers: () => list('/api/iam/v4.0/authn/users'),
        getUserById: (extId: string) => getOne(`/api/iam/v4.0/authn/users/${extId}`),
        createUser: (body: unknown) => createOne('/api/iam/v4.0/authn/users', body),
        deleteUserById: (extId: string) => deleteOne(`/api/iam/v4.0/authn/users/${extId}`),
      },
      authzPolicies: {
        listAuthorizationPolicies: () => list('/api/iam/v4.0/authz/authorization-policies'),
        createAuthorizationPolicy: (body: unknown) =>
          createOne('/api/iam/v4.0/authz/authorization-policies', body),
        deleteAuthorizationPolicyById: (extId: string) =>
          deleteOne(`/api/iam/v4.0/authz/authorization-policies/${extId}`),
      },
      roles: {
        listRoles: () => list('/api/iam/v4.0/authz/roles'),
      },
    },
    vmm: {
      vms: {
        listVms: () => list('/api/vmm/v4.0/ahv/config/vms'),
        getVmById: (extId: string) => getOne(`/api/vmm/v4.0/ahv/config/vms/${extId}`),
        createVm: (body: unknown) => createOne('/api/vmm/v4.0/ahv/config/vms', body),
        deleteVmById: (extId: string) => deleteOne(`/api/vmm/v4.0/ahv/config/vms/${extId}`),
        associateCategories: (extId: string, body: unknown) =>
          update(`/api/vmm/v4.0/ahv/config/vms/${extId}/$actions/associate-categories`, body),
        migrateVmToHost: (extId: string, body: unknown) =>
          update(`/api/vmm/v4.0/ahv/config/vms/${extId}/$actions/migrate`, body),
      },
      images: {
        listImages: () => list('/api/vmm/v4.0/content/images'),
        createImage: (body: unknown) => createOne('/api/vmm/v4.0/content/images', body),
        deleteImageById: (extId: string) => deleteOne(`/api/vmm/v4.0/content/images/${extId}`),
      },
    },
    prism: {
      categories: {
        listCategories: () => list('/api/prism/v4.2/config/categories'),
        createCategory: (body: unknown) => createOne('/api/prism/v4.2/config/categories', body),
        deleteCategoryById: (extId: string) =>
          deleteOne(`/api/prism/v4.2/config/categories/${extId}`),
      },
      tasks: {
        getTaskById: (extId: string) => getOne(`/api/prism/v4.2/config/tasks/${extId}`),
      },
    },
    networking: {
      subnets: {
        listSubnets: () => list('/api/networking/v4.0/config/subnets'),
        createSubnet: (body: unknown) =>
          createOne('/api/networking/v4.0/config/subnets', body),
        deleteSubnetById: (extId: string) =>
          deleteOne(`/api/networking/v4.0/config/subnets/${extId}`),
      },
    },
    microseg: {
      policies: {
        listNetworkSecurityPolicies: () => list('/api/microseg/v4.0/config/policies'),
        createNetworkSecurityPolicy: (body: unknown) =>
          createOne('/api/microseg/v4.0/config/policies', body),
        updateNetworkSecurityPolicyById: (extId: string, body: unknown) =>
          update(`/api/microseg/v4.0/config/policies/${extId}`, body),
        deleteNetworkSecurityPolicyById: (extId: string) =>
          deleteOne(`/api/microseg/v4.0/config/policies/${extId}`),
      },
    },
    datapolicies: {
      storage: {
        listStoragePolicies: () => list('/api/datapolicies/v4.2/config/storage-policies'),
        createStoragePolicy: (body: unknown) =>
          createOne('/api/datapolicies/v4.2/config/storage-policies', body),
        deleteStoragePolicyById: (extId: string) =>
          deleteOne(`/api/datapolicies/v4.2/config/storage-policies/${extId}`),
      },
      protection: {
        listProtectionPolicies: () => list('/api/datapolicies/v4.2/config/protection-policies'),
        createProtectionPolicy: (body: unknown) =>
          createOne('/api/datapolicies/v4.2/config/protection-policies', body),
        deleteProtectionPolicyById: (extId: string) =>
          deleteOne(`/api/datapolicies/v4.2/config/protection-policies/${extId}`),
      },
    },
    security: {
      approvals: {
        listApprovalPolicies: () =>
          list('/api/security/v4.1/management/approval-policies'),
        createApprovalPolicy: (body: unknown) =>
          createOne('/api/security/v4.1/management/approval-policies', body),
        deleteApprovalPolicyById: (extId: string) =>
          deleteOne(`/api/security/v4.1/management/approval-policies/${extId}`),
      },
    },
    opsmgmt: {
      reportConfigs: {
        listReportConfigs: () => list('/api/opsmgmt/v4.0/config/report-configs'),
        createReportConfig: (body: unknown) =>
          createOne('/api/opsmgmt/v4.0/config/report-configs', body),
        deleteReportConfigById: (extId: string) =>
          deleteOne(`/api/opsmgmt/v4.0/config/report-configs/${extId}`),
      },
      reports: {
        listReports: () => list('/api/opsmgmt/v4.0/config/reports'),
      },
    },
  };
}

export function createMockAdapter(source?: MockFixtures | string): NutanixClient {
  const fixtures: MockFixtures =
    typeof source === 'string' ? loadFixturesFromFile(source) : source ?? {};

  const request = async <T>(method: string, path: string, _body?: unknown): Promise<T> => {
    const verb = method.toUpperCase();
    const fullKey = `${verb} ${path}`;
    if (fullKey in fixtures) return fixtures[fullKey] as T;
    // Fallback: strip query string (`?$limit=100&$page=0`, `?filter=...`).
    // Fixtures are keyed by path-only for list endpoints since the same
    // resource list is what the seed wants regardless of paging.
    const queryStart = path.indexOf('?');
    if (queryStart >= 0) {
      const pathOnly = path.slice(0, queryStart);
      const pathKey = `${verb} ${pathOnly}`;
      if (pathKey in fixtures) return fixtures[pathKey] as T;
    }
    throw new Error(`No mock fixture for "${fullKey}". Record one or add it to fixtures.`);
  };

  const sdk = buildMockSdk(request);
  return {
    mode: 'mock',
    request,
    sdk,
    rest: { request },
  };
}

function loadFixturesFromFile(path: string): MockFixtures {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as MockFixtures;
}

/**
 * Wrap a mock client so every response has `{VarName}` placeholders in its
 * string values substituted with live values from the caller's variable map.
 * Lets a static fixture like `{"username": "{Trigram}-adm"}` respond with the
 * current player's trigram without the mock needing session awareness.
 *
 * Non-mock clients are returned as-is — the interpolation only fires when the
 * server seeded responses from `fixtures.json`.
 */
export function withVariableInterpolation(
  client: NutanixClient,
  getVars: () => Record<string, unknown>,
): NutanixClient {
  if (client.mode !== 'mock') return client;
  const wrappedRequest = async <T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> => {
    // Reverse-interpolate the path so static fixture keys like
    // `/.../policies/mseg-{Trigram}` keep matching after the list response
    // hands the substituted extId (`mseg-CUR`) back to the caller.
    const vars = getVars();
    const lookupPath = deinterpolatePath(path, vars);
    const raw = await client.request<unknown>(method, lookupPath, body, headers);
    return interpolate(raw, vars) as T;
  };
  return {
    mode: client.mode,
    request: wrappedRequest,
    sdk: buildMockSdk(wrappedRequest),
    rest: { request: wrappedRequest },
  };
}

/**
 * For each `{Var}` placeholder fixture authors may use in URL paths, replace
 * the substituted value back to its placeholder so the static fixture key
 * keeps matching. e.g. `/.../mseg-CUR` + `vars={Trigram: 'CUR'}` →
 * `/.../mseg-{Trigram}`. Only swaps non-empty string vars; ordering is
 * longest-first so a value that's a substring of another doesn't shadow.
 *
 * Skips values that are pure digits or shorter than 2 chars: those are
 * data captures (PIN, NumberUpdates, Vlanid, Runway, …) that legitimately
 * appear in paths as version numbers (`v4.0`) or query escapes (`%24`),
 * not as fixture-author placeholders. Deinterpolating them turned
 * `v4.0/...?$limit=100` into `v{NumberUpdates}.0/...?%2{NumberUpdates}limit=100`
 * the moment a session captured `NumberUpdates="4"`, breaking every check
 * that ran after stage 29.
 */
function deinterpolatePath(path: string, vars: Record<string, unknown>): string {
  const pairs = Object.entries(vars)
    .filter((p): p is [string, string] =>
      typeof p[1] === 'string' && p[1].length >= 2 && /[A-Za-z]/.test(p[1]),
    )
    .sort((a, b) => b[1].length - a[1].length);
  let out = path;
  for (const [name, value] of pairs) {
    out = out.split(value).join(`{${name}}`);
  }
  return out;
}

function interpolate(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{(\w+)\}/g, (match, name: string) => {
      const v = vars[name];
      return v === undefined ? match : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolate(v, vars);
    }
    return out;
  }
  return value;
}

/**
 * Map from overlay-entity kind (e.g. `vm`, `image`) to the list-endpoint path
 * it should shadow. When a `<action name='deleteVM'/>` marks the entity as
 * `deleted`, subsequent GETs against this path return the list minus that
 * entity — simulating the narrative delete without mutating the fixture file.
 *
 * Prefix-matched so `?filter=...` query-string variants still pass through.
 * Hard-coded for the current pack; generalize when more entities need
 * overlay semantics.
 */
const OVERLAY_ENDPOINTS: Array<{ kind: string; pathPrefix: string }> = [
  { kind: 'vm', pathPrefix: '/api/vmm/v4.0/ahv/config/vms' },
];

export interface OverlayMutation {
  kind: string;
  logicalName: string;
  op: 'deleted';
}

/**
 * Wrap a mock client so GETs against known list endpoints drop entries the
 * caller's overlay marks as `deleted`. Live clients are pass-through — they
 * observe the real cluster, which doesn't need a client-side overlay.
 */
export function withMockOverlay(
  client: NutanixClient,
  getMutations: () => readonly OverlayMutation[],
): NutanixClient {
  if (client.mode !== 'mock') return client;
  const wrappedRequest = async <T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> => {
    const raw = await client.request<unknown>(method, path, body, headers);
    if (method.toUpperCase() !== 'GET') return raw as T;
    const endpoint = OVERLAY_ENDPOINTS.find((e) => path.startsWith(e.pathPrefix));
    if (!endpoint) return raw as T;
    const deletedNames = getMutations()
      .filter((m) => m.kind === endpoint.kind && m.op === 'deleted')
      .map((m) => m.logicalName);
    if (deletedNames.length === 0) return raw as T;
    return filterList(raw, deletedNames) as T;
  };
  return {
    mode: client.mode,
    request: wrappedRequest,
    sdk: buildMockSdk(wrappedRequest),
    rest: { request: wrappedRequest },
  };
}

/**
 * Both `{ data: [...] }` and bare-array response shapes appear across v4
 * endpoints — handle whichever the fixture ships. Anything else passes
 * through unchanged.
 */
function filterList(raw: unknown, deletedNames: string[]): unknown {
  const matches = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') return true;
    const name = (item as { name?: unknown }).name;
    return typeof name === 'string' ? !deletedNames.includes(name) : true;
  };
  if (Array.isArray(raw)) return raw.filter(matches);
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown[] }).data)) {
    const obj = raw as { data: unknown[] } & Record<string, unknown>;
    return { ...obj, data: obj.data.filter(matches) };
  }
  return raw;
}
