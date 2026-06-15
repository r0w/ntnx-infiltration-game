import type { Logger } from '@ntnx-game/engine';
import { NutanixHttpError, NutanixTransportError } from './errors';

export interface RestAdapterConfig {
  endpoint: string;
  user: string;
  password: string;
  /** Verify the Prism Central TLS certificate. HPoC deploys usually need `false`. */
  verifySsl?: boolean;
  /** Per-request abort timeout in ms (includes retries). Default 15000. */
  timeoutMs?: number;
  /** Retry attempts on 5xx or transport errors for idempotent methods. Default 2. */
  maxRetries?: number;
  /** Initial backoff between retries in ms. Doubles each retry. Default 300. */
  retryBackoffMs?: number;
  /** Optional logger for request-level debug lines. */
  logger?: Logger;
}

type FetchInit = Parameters<typeof fetch>[1] & {
  tls?: { rejectUnauthorized?: boolean };
};

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The slim `{ mode, request }` surface this adapter exposes — less than a
 * full `NutanixClient` because it intentionally doesn't carry `sdk` or
 * `rest` (those only make sense on the composite client built by
 * `sdk-adapter.ts`). Used internally by `createSdkAdapter` to back the
 * `rest` escape-hatch, and directly by tests that only exercise REST.
 */
export interface RestClient {
  readonly mode: 'live';
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

/**
 * REST-over-fetch adapter targeting Prism Central v4. Handles self-signed TLS
 * (HPoC default), per-request timeouts, and retries on transient 5xx / network
 * errors for idempotent methods. Used as the transport layer behind
 * `createSdkAdapter`'s `rest.request()` escape-hatch — seeds/checks that
 * need to reach v3 endpoints (X-Play, Calm, projects) or any path outside
 * the SDK surface route through here. Also used standalone by the
 * capability probe.
 */
export function createRestAdapter(config: RestAdapterConfig): RestClient {
  const base = config.endpoint.replace(/\/+$/, '');
  const auth = `Basic ${btoa(`${config.user}:${config.password}`)}`;
  const verifySsl = config.verifySsl ?? false;
  const timeoutMs = config.timeoutMs ?? 15000;
  const maxRetries = Math.max(0, config.maxRetries ?? 2);
  const backoffMs = Math.max(0, config.retryBackoffMs ?? 300);
  const log = config.logger;

  return {
    mode: 'live',
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const m = method.toUpperCase();
      const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
      const retryable = IDEMPOTENT_METHODS.has(m);
      const maxAttempts = retryable ? maxRetries + 1 : 1;
      // Idempotency token required by v4 write endpoints (e.g. dataprotection
      // recovery-points 400s without it). Generated once per request() so a
      // retried call reuses the same id and the server dedupes it.
      const requestId = crypto.randomUUID();

      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const start = Date.now();
        try {
          const res = await fetchWithTimeout(url, buildInit(m, body, auth, verifySsl, requestId), timeoutMs);
          const ct = res.headers.get('content-type') ?? '';

          if (!res.ok) {
            const text = await res.text();
            const err = new NutanixHttpError({ status: res.status, method: m, path, body: text });
            log?.debug('nutanix response non-2xx', {
              method: m,
              path,
              status: res.status,
              durationMs: Date.now() - start,
              attempt,
            });
            if (attempt < maxAttempts && err.isRetryable()) {
              lastErr = err;
              await sleep(backoff(attempt, backoffMs));
              continue;
            }
            throw err;
          }

          log?.debug('nutanix response ok', {
            method: m,
            path,
            status: res.status,
            durationMs: Date.now() - start,
            attempt,
          });

          if (ct.includes('application/json')) return (await res.json()) as T;
          return (await res.text()) as unknown as T;
        } catch (err) {
          if (err instanceof NutanixHttpError) throw err;
          const transport = new NutanixTransportError(m, path, err);
          log?.debug('nutanix transport error', {
            method: m,
            path,
            err: transport.message,
            attempt,
          });
          if (attempt < maxAttempts) {
            lastErr = transport;
            await sleep(backoff(attempt, backoffMs));
            continue;
          }
          throw transport;
        }
      }

      throw lastErr ?? new Error('unreachable: rest-adapter retry loop exited without resolution');
    },
  };
}

function buildInit(
  method: string,
  body: unknown,
  auth: string,
  verifySsl: boolean,
  requestId: string,
): FetchInit {
  const init: FetchInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: auth,
      'Ntnx-Request-Id': requestId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  if (!verifySsl) {
    init.tls = { rejectUnauthorized: false };
  }
  return init;
}

async function fetchWithTimeout(url: string, init: FetchInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoff(attempt: number, baseMs: number): number {
  return baseMs * 2 ** (attempt - 1);
}
