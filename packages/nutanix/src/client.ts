import type { Logger, NutanixClient } from '@ntnx-game/engine';
import { createMockAdapter, type MockFixtures } from './mock-adapter';
import { createSdkAdapter } from './sdk-adapter';

export interface NutanixClientConfig {
  mode: 'mock' | 'live';
  pcEndpoint?: string;
  user?: string;
  password?: string;
  fixtures?: MockFixtures | string;
  verifySsl?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  logger?: Logger;
}

/**
 * Async because the live-mode path dynamic-imports the Nutanix JS SDKs
 * (after a polyfill fire) — see sdk-adapter.ts for why. Mock mode is
 * synchronous under the hood but kept async here for a uniform signature
 * at every caller.
 */
export async function createNutanixClient(config: NutanixClientConfig): Promise<NutanixClient> {
  if (config.mode === 'mock') {
    return createMockAdapter(config.fixtures);
  }
  if (config.mode === 'live') {
    if (!config.pcEndpoint || !config.user || !config.password) {
      throw new Error(`NutanixClient in 'live' mode requires pcEndpoint + user + password`);
    }
    return createSdkAdapter({
      endpoint: config.pcEndpoint,
      user: config.user,
      password: config.password,
      verifySsl: config.verifySsl,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      retryBackoffMs: config.retryBackoffMs,
      logger: config.logger,
    });
  }
  throw new Error(`Unknown NutanixClient mode: ${String(config.mode)}`);
}
