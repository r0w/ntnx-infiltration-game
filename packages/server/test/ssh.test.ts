import { describe, expect, test } from 'bun:test';
import { buildSshRoutes } from '../src/routes/ssh';

async function post(router: ReturnType<typeof buildSshRoutes>, path: string, body: unknown) {
  return router.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/ssh/ping', () => {
  const router = buildSshRoutes();

  test('missing target → 400', async () => {
    const res = await post(router, '/ping', {});
    expect(res.status).toBe(400);
  });

  test('empty target → 400', async () => {
    const res = await post(router, '/ping', { target: '   ' });
    expect(res.status).toBe(400);
  });

  test('shell metacharacters → 400 (defence-in-depth)', async () => {
    const res = await post(router, '/ping', { target: 'foo;rm -rf /' });
    expect(res.status).toBe(400);
  });

  test('leading dash rejected (argv-injection guard)', async () => {
    // `-f` would be a flood-ping flag if passed through; rejecting
    // dash-prefixed targets closes that door even though spawn() doesn't
    // use a shell.
    const res = await post(router, '/ping', { target: '-f' });
    expect(res.status).toBe(400);
  });

  test('octet > 255 rejected', async () => {
    const res = await post(router, '/ping', { target: '999.1.2.3' });
    expect(res.status).toBe(400);
  });

  test('loopback IPv4 is accepted and returns ok shape', async () => {
    // `ping 127.0.0.1` should succeed on any reasonable CI/dev host.
    // We don't assert `ok: true` here (CI containers sometimes lack the
    // ping binary or CAP_NET_RAW), just that the endpoint returns the
    // documented shape without 4xx-ing.
    const res = await post(router, '/ping', { target: '127.0.0.1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      target: string;
      output: string[];
      durationMs: number;
    };
    expect(body.target).toBe('127.0.0.1');
    expect(Array.isArray(body.output)).toBe(true);
    expect(typeof body.durationMs).toBe('number');
  });
});

describe('POST /api/ssh/tcp', () => {
  const router = buildSshRoutes();

  test('missing target → 400', async () => {
    const res = await post(router, '/tcp', {});
    expect(res.status).toBe(400);
  });

  test('bad hostname → 400', async () => {
    const res = await post(router, '/tcp', { target: 'foo bar' });
    expect(res.status).toBe(400);
  });

  test('port out of range → falls back to 22, not a 400', async () => {
    const res = await post(router, '/tcp', { target: '127.0.0.1', port: 70000 });
    // Invalid port silently falls back to 22 — documented behaviour; the
    // endpoint exists to probe SSH reachability, not to be a general
    // port-scanner.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { port: number };
    expect(body.port).toBe(22);
  });

  test('unroutable IP returns { ok: false } with an error label', async () => {
    // 203.0.113.x is TEST-NET-3 (RFC 5737) — reserved for documentation,
    // guaranteed not to be globally routable. Connect should fail with
    // timeout or no-route error depending on the host's network stack.
    const res = await post(router, '/tcp', { target: '203.0.113.1', port: 22 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      target: string;
      error?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  }, 10_000); // allow TCP timeout to elapse
});
