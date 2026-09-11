import type { NutanixClient } from '@ntnx-game/engine';
import type { NutanixCheckSdk } from '@ntnx-game/nutanix';

export function checkSdk(client: NutanixClient): NutanixCheckSdk {
  return client.sdk as NutanixCheckSdk;
}

/** Read every SDK page; never turn malformed responses into an empty inventory. */
export async function listAllSdk<T>(
  fetchPage: (params: { $limit: number; $page: number }) => Promise<unknown>,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 0; page < 200; page++) {
    const response = await fetchPage({ $limit: 100, $page: page });
    const envelope = (response as { data?: { data?: unknown; metadata?: { totalAvailableResults?: number } } })?.data;
    if (envelope?.data == null && envelope?.metadata?.totalAvailableResults === 0) return all;
    if (!Array.isArray(envelope?.data)) throw new Error('Invalid SDK list response');
    const chunk = envelope.data as T[];
    all.push(...chunk);
    const total = envelope.metadata?.totalAvailableResults;
    if (chunk.length < 100 || (typeof total === 'number' && all.length >= total)) return all;
  }
  throw new Error('SDK inventory exceeded 200 pages');
}
