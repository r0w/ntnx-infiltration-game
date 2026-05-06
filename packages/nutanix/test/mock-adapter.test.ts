import { describe, expect, test } from 'bun:test';
import {
  createMockAdapter,
  withMockOverlay,
  withVariableInterpolation,
} from '../src/mock-adapter';

describe('createMockAdapter', () => {
  test('returns fixture response for matched method+path', async () => {
    const client = createMockAdapter({
      'GET /api/v4/users': { users: [{ id: 'u1' }] },
    });
    const r = await client.request('GET', '/api/v4/users');
    expect(r).toEqual({ users: [{ id: 'u1' }] });
  });

  test('throws helpful error when no fixture matches', async () => {
    const client = createMockAdapter({});
    await expect(client.request('GET', '/missing')).rejects.toThrow(/No mock fixture/);
  });

  test('case-normalises method', async () => {
    const client = createMockAdapter({ 'POST /foo': { ok: true } });
    const r = await client.request('post', '/foo');
    expect(r).toEqual({ ok: true });
  });

  test('mode is mock', () => {
    expect(createMockAdapter().mode).toBe('mock');
  });
});

describe('withMockOverlay', () => {
  test('filters a deleted vm out of the list endpoint', async () => {
    const client = createMockAdapter({
      'GET /api/vmm/v4.0/ahv/config/vms': {
        data: [
          { extId: 'a', name: 'ABC-vm' },
          { extId: 'b', name: 'XYZ-vm' },
        ],
      },
    });
    const wrapped = withMockOverlay(client, () => [
      { kind: 'vm', logicalName: 'ABC-vm', op: 'deleted' },
    ]);
    const r = (await wrapped.request('GET', '/api/vmm/v4.0/ahv/config/vms')) as {
      data: Array<{ name: string }>;
    };
    expect(r.data.map((v) => v.name)).toEqual(['XYZ-vm']);
  });

  test('passes through when no mutations apply', async () => {
    const client = createMockAdapter({
      'GET /api/vmm/v4.0/ahv/config/vms': { data: [{ name: 'ABC-vm' }] },
    });
    const wrapped = withMockOverlay(client, () => []);
    const r = (await wrapped.request('GET', '/api/vmm/v4.0/ahv/config/vms')) as {
      data: Array<{ name: string }>;
    };
    expect(r.data.map((v) => v.name)).toEqual(['ABC-vm']);
  });

  test('does not filter unrelated endpoints', async () => {
    const client = createMockAdapter({
      'GET /api/iam/v4.0/authn/users': {
        data: [{ name: 'ABC-vm' }, { name: 'XYZ' }],
      },
    });
    const wrapped = withMockOverlay(client, () => [
      { kind: 'vm', logicalName: 'ABC-vm', op: 'deleted' },
    ]);
    const r = (await wrapped.request('GET', '/api/iam/v4.0/authn/users')) as {
      data: Array<{ name: string }>;
    };
    expect(r.data.map((v) => v.name)).toEqual(['ABC-vm', 'XYZ']);
  });

  test('non-GET methods are unaffected', async () => {
    const client = createMockAdapter({
      'POST /api/vmm/v4.0/ahv/config/vms': { ok: true },
    });
    const wrapped = withMockOverlay(client, () => [
      { kind: 'vm', logicalName: 'ABC-vm', op: 'deleted' },
    ]);
    const r = await wrapped.request('POST', '/api/vmm/v4.0/ahv/config/vms');
    expect(r).toEqual({ ok: true });
  });

  test('live adapter is returned as-is (no-op wrapper)', () => {
    const live = { mode: 'live' as const, async request() { return {}; } };
    const wrapped = withMockOverlay(live, () => []);
    expect(wrapped).toBe(live);
  });
});

describe('withVariableInterpolation', () => {
  test('interpolates {Var} in response strings', async () => {
    const client = createMockAdapter({
      'GET /api/iam/v4.0/authn/users': {
        data: [{ extId: 'u1', username: '{Trigram}-adm' }],
      },
    });
    const wrapped = withVariableInterpolation(client, () => ({ Trigram: 'cur' }));
    const r = (await wrapped.request('GET', '/api/iam/v4.0/authn/users')) as {
      data: Array<{ username: string }>;
    };
    expect(r.data[0]!.username).toBe('cur-adm');
  });

  test('reverse-interpolates {Var} in path so by-id fixtures keep matching', async () => {
    const client = createMockAdapter({
      'GET /api/microseg/v4.0/config/policies/mseg-{Trigram}': {
        data: { extId: 'mseg-{Trigram}', name: '{Trigram}-mseg-policy' },
      },
    });
    const wrapped = withVariableInterpolation(client, () => ({ Trigram: 'cur' }));
    const r = (await wrapped.request(
      'GET',
      '/api/microseg/v4.0/config/policies/mseg-cur',
    )) as { data: { extId: string; name: string } };
    expect(r.data).toEqual({ extId: 'mseg-cur', name: 'cur-mseg-policy' });
  });

  test('live adapter is returned as-is (no-op wrapper)', () => {
    const live = { mode: 'live' as const, async request() { return {}; } };
    const wrapped = withVariableInterpolation(live, () => ({ Trigram: 'cur' }));
    expect(wrapped).toBe(live);
  });

  test('numeric/short var values do not corrupt path version segments', async () => {
    const client = createMockAdapter({
      'GET /api/networking/v4.0/config/vpcs': { data: [{ name: 'cur-vpc' }] },
    });
    // Vars captured by earlier stages (NumberUpdates="4", PIN="1234",
    // Vlanid="91") used to be substituted back into v4.0 / %24limit /
    // ?$page etc., breaking every fixture that ran after the capture.
    const wrapped = withVariableInterpolation(client, () => ({
      Trigram: 'cur',
      NumberUpdates: '4',
      PIN: '1234',
      Vlanid: '91',
    }));
    const r = (await wrapped.request(
      'GET',
      '/api/networking/v4.0/config/vpcs?$limit=100&$page=0',
    )) as { data: Array<{ name: string }> };
    expect(r.data[0]!.name).toBe('cur-vpc');
  });
});
