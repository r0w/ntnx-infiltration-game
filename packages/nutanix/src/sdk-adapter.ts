/**
 * SDK-first adapter targeting Prism Central v4. Wraps the official
 * `@nutanix-api/*-js-client` packages into a single domain-organized surface
 * (`client.sdk.iam.users`, `client.sdk.vmm.vms`, …) so checks and seeds get
 * the maintained API rather than hand-rolled REST paths.
 *
 * Non-SDK endpoints (v3 X-Play, v3 Calm, v3 projects) stay on `client.rest` —
 * the REST-over-fetch escape hatch (same transport as the legacy
 * `rest-adapter.ts`, reused here). The `request(method, path, body?)` method
 * is kept for backward compat with checks that haven't been migrated yet and
 * transparently routes to `rest.request()`.
 *
 * Boot order note: Bun evaluates static imports eagerly at module link time,
 * so a side-effect `import './sdk-polyfill'` declared before the SDK imports
 * doesn't guarantee the polyfill runs before the SDK's top-level code (which
 * constructs a default `ApiClient.instance` and reads `self.location.hostname`
 * — undefined in Bun). Workaround: polyfill inline at the top of this file
 * AND load the SDK packages via dynamic `await import()` inside
 * `createSdkAdapter`, so the polyfill has fired by the time any SDK module
 * initializes.
 */
import type { Logger, NutanixClient } from '@ntnx-game/engine';
import { createRestAdapter, type RestAdapterConfig } from './rest-adapter';
import { installSdkPolyfill } from './sdk-polyfill';

// Fire polyfill at module load (idempotent). Even though dynamic imports are
// what actually matters, applying early catches any accidental eager import
// from another module.
installSdkPolyfill();

export interface SdkAdapterConfig extends RestAdapterConfig {}

/**
 * Strongly-typed surface exposed by `client.sdk`. Typed as `any`-per-resource
 * because the SDK's `.d.ts` types are mostly `any` themselves — consumers get
 * runtime behavior and docstrings, not compile-time narrowing. Only the
 * resources the pack actually touches are listed; extend here when a new
 * check or seed needs another resource.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface NutanixSdk {
  iam: {
    users: any;
    authzPolicies: any;
    roles: any;
  };
  vmm: {
    vms: any;
    images: any;
  };
  prism: {
    categories: any;
    tasks: any;
  };
  networking: {
    subnets: any;
  };
  microseg: {
    policies: any;
  };
  datapolicies: {
    storage: any;
    protection: any;
  };
  security: {
    approvals: any;
  };
  opsmgmt: {
    reports: any;
    reportConfigs: any;
  };
}

export interface NutanixSdkClient extends NutanixClient {
  readonly sdk: NutanixSdk;
  readonly rest: {
    request<T = unknown>(
      method: string,
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ): Promise<T>;
  };
}

/**
 * Extract the entity list from an SDK response envelope. SDKs wrap the raw
 * v4 response as `{ data: <envelope>, response: <superagentResponse> }` where
 * `envelope` matches `{ data: [...], metadata, resultsTotal }`. Consumers
 * generally want `envelope.data`, so this helper double-unwraps.
 */
export function unwrapList<T>(res: unknown): T[] {
  const r = res as { data?: { data?: T[] } } | undefined;
  return r?.data?.data ?? [];
}

/** Same idea for single-entity responses (`GetFoo`, `CreateFoo`). */
export function unwrapOne<T>(res: unknown): T | undefined {
  const r = res as { data?: { data?: T } } | undefined;
  return r?.data?.data;
}

function parsePc(endpoint: string): { host: string; port: string; scheme: string } {
  // endpoint is like `https://10.55.37.7:9440` — strip scheme + port for SDK.
  const m = /^(https?):\/\/([^:/]+)(?::(\d+))?/.exec(endpoint);
  if (!m) throw new Error(`Invalid PC endpoint: ${endpoint}`);
  return { scheme: m[1] ?? 'https', host: m[2] ?? '', port: m[3] ?? '9440' };
}

function configureApiClient(c: unknown, config: SdkAdapterConfig): unknown {
  const { host, port, scheme } = parsePc(config.endpoint);
  const client = c as {
    host: string;
    port: string;
    scheme: string;
    username: unknown;
    password: unknown;
    verifySsl: boolean;
    allowVersionNegotiation: boolean;
    readTimeout: number;
    maxRetryAttempts: number;
    debug: boolean;
  };
  client.host = host;
  client.port = port;
  client.scheme = scheme;
  client.username = config.user;
  client.password = config.password;
  client.verifySsl = config.verifySsl ?? false;
  // Version negotiation adds a roundtrip per request and regresses when PC
  // reports a version the SDK doesn't know. Pin off — we pick explicit paths
  // per domain and if PC drifts, we upgrade the SDK major on purpose.
  client.allowVersionNegotiation = false;
  client.readTimeout = config.timeoutMs ?? 15000;
  client.maxRetryAttempts = config.maxRetries ?? 2;
  client.debug = false;
  return client;
}

/**
 * Builds a NutanixSdkClient that targets a real Prism Central:
 * - `sdk.*`   — SDK-typed domain APIs for v4 endpoints
 * - `rest`    — REST-over-fetch for v3 (X-Play, Calm, projects) or paths
 *               not covered by any SDK
 * - `request` — shim routing to `rest.request()`, kept so legacy checks
 *               keep compiling while migration proceeds. Prefer `sdk.*` or
 *               `rest.request()` in new code.
 *
 * Async because the SDK packages are loaded via dynamic `import()` — see
 * the boot-order note at the top of the file.
 */
export async function createSdkAdapter(
  config: SdkAdapterConfig,
): Promise<NutanixSdkClient> {
  installSdkPolyfill();
  const logger: Logger | undefined = config.logger;

  // Dynamic-import all SDKs after the polyfill is in place. Each package
  // ships its own `ApiClient` class (they don't share state) — configure
  // identically so domain-hopping checks don't see divergent retry behavior.
  const [iam, vmm, prism, networking, microseg, datapolicies, security, opsmgmt] =
    await Promise.all([
      import('@nutanix-api/iam-js-client'),
      import('@nutanix-api/vmm-js-client'),
      import('@nutanix-api/prism-js-client'),
      import('@nutanix-api/networking-js-client'),
      import('@nutanix-api/microseg-js-client'),
      import('@nutanix-api/datapolicies-js-client'),
      import('@nutanix-api/security-js-client'),
      import('@nutanix-api/opsmgmt-js-client'),
    ]);

  const iamClient = configureApiClient(new iam.ApiClient(), config);
  const vmmClient = configureApiClient(new vmm.ApiClient(), config);
  const prismClient = configureApiClient(new prism.ApiClient(), config);
  const networkingClient = configureApiClient(new networking.ApiClient(), config);
  const microsegClient = configureApiClient(new microseg.ApiClient(), config);
  const datapoliciesClient = configureApiClient(new datapolicies.ApiClient(), config);
  const securityClient = configureApiClient(new security.ApiClient(), config);
  const opsmgmtClient = configureApiClient(new opsmgmt.ApiClient(), config);

  const sdk: NutanixSdk = {
    iam: {
      users: new iam.UsersApi(iamClient),
      authzPolicies: new iam.AuthorizationPoliciesApi(iamClient),
      roles: new iam.RolesApi(iamClient),
    },
    vmm: {
      vms: new vmm.VmApi(vmmClient),
      images: new vmm.ImagesApi(vmmClient),
    },
    prism: {
      categories: new prism.CategoriesApi(prismClient),
      tasks: new prism.TasksApi(prismClient),
    },
    networking: {
      subnets: new networking.SubnetsApi(networkingClient),
    },
    microseg: {
      policies: new microseg.NetworkSecurityPoliciesApi(microsegClient),
    },
    datapolicies: {
      storage: new datapolicies.StoragePoliciesApi(datapoliciesClient),
      protection: new datapolicies.ProtectionPoliciesApi(datapoliciesClient),
    },
    security: {
      approvals: new security.ApprovalPoliciesApi(securityClient),
    },
    opsmgmt: {
      reports: new opsmgmt.ReportsApi(opsmgmtClient),
      reportConfigs: new opsmgmt.ReportConfigApi(opsmgmtClient),
    },
  };

  const rest = createRestAdapter(config);

  logger?.info('sdk adapter ready', {
    endpoint: config.endpoint,
    domains: Object.keys(sdk),
  });

  return {
    mode: 'live',
    sdk,
    rest: {
      request: (method, path, body, headers) => rest.request(method, path, body, headers),
    },
    async request<T>(
      method: string,
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ): Promise<T> {
      // Legacy shim — routes to rest for paths that haven't been migrated to
      // `sdk.*`. Keeps the old `ctx.nutanix.request()` call-sites compiling.
      return rest.request<T>(method, path, body, headers);
    },
  };
}
