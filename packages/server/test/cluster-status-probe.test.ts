import { describe, expect, test } from 'bun:test';
import type { NutanixClient } from '@ntnx-game/engine';
import { probeIntelligentOps } from '../src/cluster-status-probe';

const path = '/api/prism/v4.2/resource-manager/products/prismops';
const logger = { debug() {}, info() {}, warn() {}, error() {} };
function harness(response: unknown, mode: 'mock' | 'live' = 'live') {
  const calls: Array<{ method: string; path: string }> = [];
  const nutanix: NutanixClient = {
    mode,
    async request<T>(method: string, url: string): Promise<T> {
      calls.push({ method, path: url });
      if (response instanceof Error) throw response;
      // Reproduce the conflict: the old portfolio would report DISABLED.
      if (url === '/api/prism/v4.2/config/domain-managers') return { data: [{ extId: 'pc' }] } as T;
      if (url.includes('/products?')) return { data: [{ name: 'INTELLIGENT_OPERATIONS', enablementState: 'DISABLED' }] } as T;
      if (url !== path || method !== 'GET') throw new Error('unexpected request');
      return response as T;
    },
  };
  return { calls, deps: { nutanix, pcEndpoint: 'https://pc.example:9440/', logger } };
}

describe('Intelligent Operations status', () => {
  test('uses enabled IOps status even when the generic portfolio says disabled', async () => {
    const { calls, deps } = harness({ data: { isEnabled: true } });
    expect(await probeIntelligentOps(deps)).toEqual({ state: 'ENABLED', enableUrl: 'https://pc.example:9440/dm/settings/prism_ops' });
    expect(calls).toEqual([{ method: 'GET', path }]);
  });
  test('reads the disabled payload observed on PC 7.5.1.8', async () => {
    const { calls, deps } = harness({ data: { isEnabled: false, details: { message: 'kFeaturesDisabled', status: 'HEALTHY' } } });
    expect((await probeIntelligentOps(deps)).state).toBe('DISABLED');
    expect(calls).toEqual([{ method: 'GET', path }]);
  });
  test('missing or non-boolean status is unknown, never coerced to disabled or enabled', async () => {
    for (const response of [null, {}, { data: null }, { data: {} }, { data: { isEnabled: 'false' } }, { data: { isEnabled: 0 } }]) {
      const { calls, deps } = harness(response);
      const result = await probeIntelligentOps(deps);
      expect(result.state).toBeNull();
      expect(result.error).toContain('data.isEnabled');
      expect(calls).toEqual([{ method: 'GET', path }]);
    }
  });
  test('errors do not fall back to the unreliable portfolio', async () => {
    for (const message of ['404 Not Found', '403 Forbidden', 'connection timed out']) {
      const { calls, deps } = harness(new Error(message));
      expect(await probeIntelligentOps(deps)).toEqual({ state: null, enableUrl: 'https://pc.example:9440/dm/settings/prism_ops', error: message });
      expect(calls).toEqual([{ method: 'GET', path }]);
    }
  });
  test('mock mode never contacts a cluster', async () => {
    const { calls, deps } = harness(new Error('must not query'), 'mock');
    expect(await probeIntelligentOps(deps)).toEqual({ state: null, enableUrl: null });
    expect(calls).toHaveLength(0);
  });
  test('does not cache the previous live value', async () => {
    const response = { data: { isEnabled: false } };
    const { calls, deps } = harness(response);
    expect((await probeIntelligentOps(deps)).state).toBe('DISABLED');
    response.data.isEnabled = true;
    expect((await probeIntelligentOps(deps)).state).toBe('ENABLED');
    expect(calls).toHaveLength(2);
  });
  test('omits the activation link when no endpoint is configured', async () => {
    const { deps } = harness({ data: { isEnabled: true } });
    expect((await probeIntelligentOps({ ...deps, pcEndpoint: undefined })).enableUrl).toBeNull();
  });
});
