import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Logger } from '@ntnx-game/engine';
import { createRestAdapter } from '../src/rest-adapter';
import { NutanixHttpError, NutanixTransportError } from '../src/errors';

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

type FetchImpl = (input: string, init?: unknown) => Promise<Response>;

const ORIGINAL_FETCH = globalThis.fetch;
let calls: Array<{ url: string; init: unknown }> = [];

function installFetch(impl: FetchImpl) {
  (globalThis as { fetch: FetchImpl }).fetch = async (input: string, init?: unknown) => {
    calls.push({ url: input, init });
    return impl(input, init);
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  (globalThis as { fetch: typeof ORIGINAL_FETCH }).fetch = ORIGINAL_FETCH;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

describe('createRestAdapter', () => {
  test('sends Basic auth + JSON headers and parses JSON body', async () => {
    installFetch(async () => jsonResponse(200, { ok: 1 }));
    const client = createRestAdapter({
      endpoint: 'https://pc:9440',
      user: 'admin',
      password: 's3cret',
    });
    const r = await client.request('GET', '/api/clustermgmt/v4.0/config/clusters');
    expect(r).toEqual({ ok: 1 });
    expect(calls).toHaveLength(1);
    const init = calls[0].init as { method: string; headers: Record<string, string>; tls?: unknown };
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(`Basic ${btoa('admin:s3cret')}`);
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  test('sends an Ntnx-Request-Id idempotency header, stable across retries', async () => {
    // First attempt 503 (retryable for GET), second 200: the retried request
    // must carry the SAME Ntnx-Request-Id so the server can dedupe it.
    let n = 0;
    installFetch(async () => (n++ === 0 ? jsonResponse(503, {}) : jsonResponse(200, { ok: 1 })));
    const client = createRestAdapter({
      endpoint: 'https://pc:9440',
      user: 'u',
      password: 'p',
      retryBackoffMs: 0,
    });
    await client.request('GET', '/x');
    expect(calls).toHaveLength(2);
    const id0 = (calls[0].init as { headers: Record<string, string> }).headers['Ntnx-Request-Id'];
    const id1 = (calls[1].init as { headers: Record<string, string> }).headers['Ntnx-Request-Id'];
    expect(id0).toMatch(/^[0-9a-f-]{36}$/);
    expect(id1).toBe(id0);
  });

  test('defaults to verifySsl=false (HPoC-friendly), setting tls.rejectUnauthorized=false', async () => {
    installFetch(async () => jsonResponse(200, {}));
    const client = createRestAdapter({
      endpoint: 'https://pc:9440',
      user: 'u',
      password: 'p',
    });
    await client.request('GET', '/x');
    const init = calls[0].init as { tls: { rejectUnauthorized: boolean } };
    expect(init.tls).toEqual({ rejectUnauthorized: false });
  });

  test('verifySsl=true omits the tls option so Bun uses its default trust store', async () => {
    installFetch(async () => jsonResponse(200, {}));
    const client = createRestAdapter({
      endpoint: 'https://pc:9440',
      user: 'u',
      password: 'p',
      verifySsl: true,
    });
    await client.request('GET', '/x');
    const init = calls[0].init as { tls?: unknown };
    expect(init.tls).toBeUndefined();
  });

  test('non-2xx throws NutanixHttpError with status + body + method + path', async () => {
    installFetch(async () => textResponse(401, 'bad creds'));
    const client = createRestAdapter({
      endpoint: 'https://pc:9440',
      user: 'u',
      password: 'p',
    });
    try {
      await client.request('GET', '/api/iam/v4/users');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NutanixHttpError);
      const e = err as NutanixHttpError;
      expect(e.status).toBe(401);
      expect(e.method).toBe('GET');
      expect(e.path).toBe('/api/iam/v4/users');
      expect(e.body).toBe('bad creds');
      expect(e.isRetryable()).toBe(false);
    }
  });

  test('retries GET on 5xx and returns success from retry', async () => {
    let n = 0;
    installFetch(async () => {
      n++;
      if (n < 3) return textResponse(503, 'transient');
      return jsonResponse(200, { attempt: n });
    });
    const client = createRestAdapter({
      endpoint: 'https://pc:9440',
      user: 'u',
      password: 'p',
      maxRetries: 3,
      retryBackoffMs: 1,
      logger: silentLogger,
    });
    const r = await client.request<{ attempt: number }>('GET', '/x');
    expect(r).toEqual({ attempt: 3 });
    expect(calls).toHaveLength(3);
  });

  test('does not retry POST even on 5xx (non-idempotent by default)', async () => {
    installFetch(async () => textResponse(503, 'transient'));
    const client = createRestAdapter({
      endpoint: 'https://pc:9440',
      user: 'u',
      password: 'p',
      maxRetries: 3,
      retryBackoffMs: 1,
      logger: silentLogger,
    });
    await expect(client.request('POST', '/create', {})).rejects.toBeInstanceOf(NutanixHttpError);
    expect(calls).toHaveLength(1);
  });

  test('retries on transport errors (network / timeout), wraps as NutanixTransportError', async () => {
    let n = 0;
    installFetch(async () => {
      n++;
      if (n < 3) throw new Error('ECONNRESET');
      return jsonResponse(200, { done: true });
    });
    const client = createRestAdapter({
      endpoint: 'https://pc:9440',
      user: 'u',
      password: 'p',
      maxRetries: 3,
      retryBackoffMs: 1,
      logger: silentLogger,
    });
    const r = await client.request<{ done: boolean }>('GET', '/x');
    expect(r).toEqual({ done: true });
    expect(calls).toHaveLength(3);
  });

  test('transport error after exhausted retries surfaces as NutanixTransportError', async () => {
    installFetch(async () => {
      throw new Error('boom');
    });
    const client = createRestAdapter({
      endpoint: 'https://pc:9440',
      user: 'u',
      password: 'p',
      maxRetries: 1,
      retryBackoffMs: 1,
      logger: silentLogger,
    });
    try {
      await client.request('GET', '/x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NutanixTransportError);
      const e = err as NutanixTransportError;
      expect(e.method).toBe('GET');
      expect(e.path).toBe('/x');
      expect(e.message).toContain('boom');
    }
    expect(calls).toHaveLength(2);
  });

  test('NutanixTransportError walks the cause chain to surface the syscall code (Bun fetch wraps ENETUNREACH two layers deep)', async () => {
    // Mirrors what Bun's fetch produces when VPN is down: top-level
    // "fetch failed" with a TypeError cause, whose own cause carries the
    // syscall `code`. The diagnostic field operators actually want.
    const syscallErr: Error & { code?: string } = new Error('connect ENETUNREACH 10.55.37.7:9440');
    syscallErr.code = 'ENETUNREACH';
    const causeWrapper = new Error('TypeError: fetch failed');
    (causeWrapper as { cause?: unknown }).cause = syscallErr;
    const fetchErr = new Error('fetch failed');
    (fetchErr as { cause?: unknown }).cause = causeWrapper;

    installFetch(async () => {
      throw fetchErr;
    });
    const client = createRestAdapter({
      endpoint: 'https://pc:9440',
      user: 'u',
      password: 'p',
      maxRetries: 0,
      logger: silentLogger,
    });
    try {
      await client.request('GET', '/x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NutanixTransportError);
      const e = err as NutanixTransportError;
      // Code surfaces from the deepest cause, not the wrapper.
      expect(e.code).toBe('ENETUNREACH');
      // Message embeds the actionable syscall message instead of just
      // "fetch failed", which is what the operator sees in logs.
      expect(e.message).toContain('ENETUNREACH');
    }
  });

  test('timeout aborts slow requests', async () => {
    installFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as { signal: AbortSignal }).signal;
          signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
        }),
    );
    const client = createRestAdapter({
      endpoint: 'https://pc:9440',
      user: 'u',
      password: 'p',
      timeoutMs: 20,
      maxRetries: 0,
      retryBackoffMs: 1,
      logger: silentLogger,
    });
    await expect(client.request('GET', '/slow')).rejects.toBeInstanceOf(NutanixTransportError);
  });

  test('4xx errors are not retried', async () => {
    installFetch(async () => textResponse(404, 'not found'));
    const client = createRestAdapter({
      endpoint: 'https://pc:9440',
      user: 'u',
      password: 'p',
      maxRetries: 3,
      retryBackoffMs: 1,
      logger: silentLogger,
    });
    await expect(client.request('GET', '/missing')).rejects.toBeInstanceOf(NutanixHttpError);
    expect(calls).toHaveLength(1);
  });

  test('endpoint trailing slashes are trimmed and path leading slash is optional', async () => {
    installFetch(async () => jsonResponse(200, {}));
    const client = createRestAdapter({
      endpoint: 'https://pc:9440///',
      user: 'u',
      password: 'p',
    });
    await client.request('GET', 'api/health');
    expect(calls[0].url).toBe('https://pc:9440/api/health');
  });
});
