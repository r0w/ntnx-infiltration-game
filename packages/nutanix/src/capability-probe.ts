import type { CapabilityProbeDetail, CapabilityFlag, Logger, NutanixClient } from '@ntnx-game/engine';
import { discoverableNodeSerials } from '@ntnx-game/engine';
import { NutanixTransportError } from './errors';

export type { CapabilityProbeDetail };

export interface CapabilityProbeResult {
  flags: CapabilityFlag[];
  details: CapabilityProbeDetail[];
  /**
   * True when EVERY probe failed at the transport layer — strong
   * signal that the PC isn't reachable (VPN down, wrong PC_ENDPOINT,
   * firewall, PC down). Always false in mock mode (mock adapter
   * never throws transport errors).
   */
  unreachable: boolean;
}

export interface CapabilityProbeDeps {
  nutanix: NutanixClient;
  logger: Logger;
}

type SingleProbe = {
  flag: CapabilityFlag;
  method: string;
  path: string;
  interpret: (body: unknown) => { detected: boolean; detail: string };
  /**
   * Optional override that runs a multi-call sequence instead of the
   * default single {method, path} request. When set, the probe runner
   * calls this instead of `nutanix.request(method, path)` + `interpret`.
   * `method`/`path` are still reported for telemetry. Used by NodeRemove
   * which needs the async discover-unconfigured-nodes flow (POST + task
   * poll + GET response).
   */
  customRun?: (nutanix: NutanixClient, logger: Logger) => Promise<{ detected: boolean; detail: string }>;
};

const PROBES: SingleProbe[] = [
  {
    flag: 'NCM',
    method: 'GET',
    path: '/api/ncm/v4.0/config/info',
    interpret: (body) => ({
      detected: isObject(body),
      detail: isObject(body) ? 'NCM info endpoint responded' : `unexpected body: ${typeOf(body)}`,
    }),
  },
  {
    flag: 'IO',
    method: 'GET',
    path: '/api/io/v1/license',
    interpret: (body) => {
      const licensed = readBool(body, ['data', 'licensed']) ?? readBool(body, ['licensed']);
      if (licensed === true) return { detected: true, detail: 'IO license active' };
      if (licensed === false) return { detected: false, detail: 'IO responded but not licensed' };
      return { detected: isObject(body), detail: 'IO endpoint responded (license flag absent)' };
    },
  },
  {
    flag: 'CalmDSL',
    method: 'POST',
    path: '/api/nutanix/v3/blueprints/list',
    interpret: (body) => {
      const entities = readArray(body, ['entities']);
      if (entities) return { detected: true, detail: `blueprints list returned ${entities.length} entries` };
      return { detected: isObject(body), detail: 'blueprints list responded' };
    },
  },
  {
    // NodeRemove gates stage 28 (`expand-cluster`). Two criteria must
    // hold to allow it:
    //   1. cluster has ≥2 nodes (otherwise no peer to expand FROM)
    //   2. ≥1 rackmounted-but-unconfigured node is discoverable
    //      (otherwise there's nothing to add — the player would submit
    //      a serial that CheckNewNode would reject).
    // Criterion 2 catches the full-chassis case (current 4-node cluster
    // with no spare slot, e.g. 10.38.66.7 in `other` mode where the BP
    // never freed a slot via Remove 4th host) — the previous probe wrongly
    // said detected=true on those because it only counted nodes.
    //
    // `customRun` (instead of the default single-call shape) is needed
    // because criterion 2 requires the async discover-unconfigured-nodes
    // task (POST + poll + GET response). `discoverableNodeSerials` from
    // engine already implements the dance with a mock short-circuit, so
    // we just intersect its result with the node-count check.
    flag: 'NodeRemove',
    method: 'CUSTOM',
    path: 'clusters + discover-unconfigured-nodes',
    interpret: () => ({ detected: false, detail: 'unreached — customRun should fire' }),
    customRun: async (nutanix, logger) => {
      const clusters = await nutanix.request<unknown>('GET', '/api/clustermgmt/v4.0/config/clusters');
      const list = readArray(clusters, ['data']) ?? readArray(clusters, ['entities']);
      if (!list || list.length === 0) {
        return { detected: false, detail: 'cluster list empty or missing' };
      }
      const maxNodes = list.reduce<number>((acc, c) => Math.max(acc, readNodeCount(c)), 0);
      if (maxNodes < 2) {
        return { detected: false, detail: `largest cluster has ${maxNodes} node — below the ≥2 floor for expand-cluster` };
      }
      let spares: string[];
      try {
        spares = await discoverableNodeSerials(nutanix, logger);
      } catch (err) {
        // Discover endpoint or task poll failed (timeout, PC version
        // skew, etc.). Fall back to the coarse ≥2-nodes signal — the
        // in-game CheckNewNode will catch a player-submitted serial
        // that doesn't match anyway. Better to allow the stage to run
        // than to filter it on a transient API error.
        const msg = err instanceof Error ? err.message : String(err);
        return {
          detected: maxNodes >= 2,
          detail: `nodes=${maxNodes}; discover failed (${truncate(msg, 100)}) — falling back to nodeCount-only`,
        };
      }
      return {
        detected: maxNodes >= 2 && spares.length >= 1,
        detail: `nodes=${maxNodes}, discoverable spares=${spares.length}`,
      };
    },
  },
  {
    // MultiNode = cluster has ≥2 nodes. Used by live-migrate-vm and other
    // stages that need a peer host but DON'T need a spare chassis slot.
    // Distinct from NodeRemove (which adds the spare requirement) so
    // multi-node-but-full-chassis clusters can still play live-migration.
    flag: 'MultiNode',
    method: 'GET',
    path: '/api/clustermgmt/v4.0/config/clusters',
    interpret: (body) => {
      const clusters = readArray(body, ['data']) ?? readArray(body, ['entities']);
      if (!clusters) return { detected: false, detail: 'cluster list empty or missing' };
      const maxNodes = clusters.reduce<number>((acc, c) => Math.max(acc, readNodeCount(c)), 0);
      return {
        detected: maxNodes >= 2,
        detail: `largest cluster has ${maxNodes} node${maxNodes === 1 ? '' : 's'}`,
      };
    },
  },
  {
    // Calm policy engine activation state. Same endpoint the BP's
    // activate_policy_engine.py PUTs against; we just read it. `is_enabled`
    // in `spec.feature_status` is the operator-set value (sticky); the
    // `status.feature_status` mirror lags during a deploy. We trust `spec`
    // here — if the operator (or the BP) flipped it on, the stage should be
    // allowed even if the Policy VM is still bootstrapping (the in-game
    // check has its own retry logic).
    flag: 'ApprovalPolicy',
    method: 'GET',
    path: '/api/calm/v3.0/features/policy',
    interpret: (body) => {
      const enabled =
        readBool(body, ['spec', 'feature_status', 'is_enabled']) ??
        readBool(body, ['status', 'feature_status', 'is_enabled']);
      if (enabled === true) return { detected: true, detail: 'policy engine is_enabled=true' };
      if (enabled === false) return { detected: false, detail: 'policy engine is_enabled=false' };
      return { detected: false, detail: 'policy feature endpoint did not surface is_enabled' };
    },
  },
];

export async function probeCapabilities(deps: CapabilityProbeDeps): Promise<CapabilityProbeResult> {
  const { nutanix, logger } = deps;
  const details = await Promise.all(PROBES.map((p) => runProbe(p, nutanix, logger)));
  const flags = details.filter((d) => d.detected).map((d) => d.flag);
  // "Unreachable" = every probe hit a transport error. Mixed results
  // (some 404s, some transport) mean the cluster IS responding, just
  // doesn't have all features — treat as reachable.
  const unreachable = details.length > 0 && details.every((d) => d.transportError);
  // Tight info line — just the activated flags. Failure detail goes
  // out via per-probe warns (transport) / debugs (HTTP), so the info
  // log doesn't need to re-embed 4 × ~500-char 404 bodies.
  logger.info('capability probe complete', { mode: nutanix.mode, flags });
  // Full details kept at debug for troubleshooting.
  logger.debug('capability probe details', {
    unreachable,
    probed: details.map((d) => ({ flag: d.flag, detected: d.detected, detail: d.detail })),
  });
  return { flags, details, unreachable };
}

async function runProbe(
  probe: SingleProbe,
  nutanix: NutanixClient,
  logger: Logger,
): Promise<CapabilityProbeDetail> {
  const start = Date.now();
  const body = probe.method === 'POST' ? {} : undefined;
  try {
    const { detected, detail } = probe.customRun
      ? await probe.customRun(nutanix, logger)
      : probe.interpret(await nutanix.request(probe.method, probe.path, body));
    return {
      flag: probe.flag,
      detected,
      method: probe.method,
      path: probe.path,
      detail,
      durationMs: Date.now() - start,
      transportError: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTransport = err instanceof NutanixTransportError;
    const transportCode = isTransport ? err.code : undefined;
    // Transport errors (VPN down, DNS fail, refused) are louder than
    // HTTP errors (404 = endpoint not deployed on this PC, normal).
    if (isTransport) {
      logger.warn('cannot reach Prism Central', {
        flag: probe.flag,
        path: probe.path,
        code: transportCode,
      });
    } else {
      logger.debug('capability probe failed (treating as not-detected)', {
        flag: probe.flag,
        path: probe.path,
        err: message,
      });
    }
    return {
      flag: probe.flag,
      detected: false,
      method: probe.method,
      path: probe.path,
      detail: `probe error: ${truncate(message, 200)}`,
      durationMs: Date.now() - start,
      transportError: isTransport,
      transportCode,
    };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function readBool(body: unknown, path: string[]): boolean | undefined {
  const val = readPath(body, path);
  return typeof val === 'boolean' ? val : undefined;
}

function readArray(body: unknown, path: string[]): unknown[] | undefined {
  const val = readPath(body, path);
  return Array.isArray(val) ? val : undefined;
}

function readPath(body: unknown, path: string[]): unknown {
  let cur: unknown = body;
  for (const key of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function readNodeCount(cluster: unknown): number {
  if (!isObject(cluster)) return 0;
  const candidates: unknown[] = [
    readPath(cluster, ['nodes', 'numberOfNodes']),
    readPath(cluster, ['numberOfNodes']),
    readPath(cluster, ['nodeCount']),
    readPath(cluster, ['config', 'numberOfNodes']),
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  const nodes = readArray(cluster, ['nodes', 'nodeList']) ?? readArray(cluster, ['nodes']);
  if (nodes) return nodes.length;
  return 0;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
