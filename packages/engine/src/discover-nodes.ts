import type { Logger, NutanixClient } from './types';

/**
 * Returns the rackable-unit serial of every node currently discoverable on
 * the chassis but NOT yet part of the cluster — i.e. the candidate set for
 * stage 28 (`expand-cluster`). Matches the legacy Python's `dev` branch
 * (`ntnx-escape-game/functions.py:getNewNodeSerial`, commit e37ef0d) which
 * the old TS port did not pick up — the port used `/rackable-units` which
 * returns the chassis inventory (active nodes included), causing CheckNewNode
 * to validate too loosely (a player typing the running node's serial would
 * pass, which is wrong: that node isn't an expand candidate).
 *
 * Live flow (3 hops, mirrors the Python):
 *   1. POST `/api/clustermgmt/v4.0.b2/.../$actions/discover-unconfigured-nodes`
 *      — fires a discovery task on the cluster, returns its `extId`.
 *   2. Poll `/api/prism/v4.2/config/tasks/{ext_id}` every 5 s up to 3 min
 *      until `status === 'SUCCEEDED'`. `FAILED|CANCELED` → throw.
 *   3. GET `/api/clustermgmt/v4.2/config/task-response/{short_id}
 *          ?taskResponseType=UNCONFIGURED_NODES`
 *      — `data.response.nodeList[].rackableUnitSerial` is the answer.
 *
 * Mock short-circuit: a single GET to a fixed task-response key. Saves the
 * fixture from having to encode the task-poll dance.
 */
export async function discoverableNodeSerials(
  nutanix: NutanixClient,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<string[]> {
  if (nutanix.mode === 'mock') {
    const res = await nutanix.request<DiscoverTaskResponse>(
      'GET',
      `/api/clustermgmt/v4.2/config/task-response/mock-discover-task?taskResponseType=UNCONFIGURED_NODES`,
    );
    return extractSerials(res);
  }

  const clusters = await nutanix.request<{ data?: Array<{ extId?: string }> }>(
    'GET',
    '/api/clustermgmt/v4.0/config/clusters',
  );
  const clusterUuid = clusters.data?.[0]?.extId;
  if (!clusterUuid) throw new Error('discoverableNodeSerials: no cluster UUID');

  const discoverResp = await nutanix.request<{ data?: { extId?: string } }>(
    'POST',
    `/api/clustermgmt/v4.0.b2/config/clusters/${clusterUuid}/$actions/discover-unconfigured-nodes`,
    { timeout: 60, isManualDiscovery: false, addressType: 'IPV4' },
  );
  const taskExtId = discoverResp.data?.extId;
  if (!taskExtId) {
    throw new Error('discoverableNodeSerials: discover task returned no extId');
  }

  await pollTask(nutanix, taskExtId, logger);

  // `task-response` is keyed by the short trailing component of the extId
  // (Python: `task_ext_id.split(":")[-1]`). The full extId pattern is e.g.
  // `ZXJnb24...:7f8c2e10-...`.
  const shortId = taskExtId.split(':').pop() ?? taskExtId;
  const respResp = await nutanix.request<DiscoverTaskResponse>(
    'GET',
    `/api/clustermgmt/v4.2/config/task-response/${shortId}?taskResponseType=UNCONFIGURED_NODES`,
  );
  return extractSerials(respResp);
}

interface DiscoverTaskResponse {
  data?: {
    response?: {
      nodeList?: Array<{ rackableUnitSerial?: string }>;
    };
  };
}

function extractSerials(res: DiscoverTaskResponse | undefined): string[] {
  const list = res?.data?.response?.nodeList ?? [];
  const out: string[] = [];
  for (const n of list) {
    const s = n.rackableUnitSerial;
    if (typeof s === 'string' && s.trim().length > 0) out.push(s.trim());
  }
  return out;
}

const POLL_INTERVAL_MS = 5_000;
const POLL_DEADLINE_MS = 3 * 60 * 1_000;

async function pollTask(
  nutanix: NutanixClient,
  taskExtId: string,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<void> {
  const taskPath = `/api/prism/v4.2/config/tasks/${taskExtId}`;
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await nutanix.request<{ data?: { status?: string } }>('GET', taskPath);
      lastStatus = res?.data?.status;
      if (lastStatus === 'SUCCEEDED') return;
      if (lastStatus === 'FAILED' || lastStatus === 'CANCELED' || lastStatus === 'CANCELLED') {
        throw new Error(`discover task ${lastStatus}`);
      }
    } catch (err) {
      // Transient HTTP/transport hiccup mid-poll — keep going until deadline.
      // Throw-from-status above is intentional and re-thrown by the outer.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('discover task ')) throw err;
      logger?.debug?.('discover task poll error, retrying', { err: msg.slice(0, 150) });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`discover task timed out after ${POLL_DEADLINE_MS / 1000} s (last status: ${lastStatus ?? 'none'})`);
}
