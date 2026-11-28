import type { Logger, NutanixClient } from '@ntnx-game/engine';

/**
 * Read-only IOps status for the admin Cluster tab, using the same product
 * endpoint as Prism's IOps screen. The generic product portfolio can report
 * a stale enablement state. Activation remains an operator action in Prism.
 * Mock mode never queries the cluster; live status is not cached.
 */
export type IntelligentOpsState = 'ENABLED' | 'DISABLED' | 'UNKNOWN';

export interface IntelligentOpsProbeResult {
  /** State as reported by PC. `null` when mock mode or probe errored. */
  state: IntelligentOpsState | null;
  /** Deep link to the Prism UI activation page, or `null` in mock mode /
   *  when the PC endpoint isn't configured. */
  enableUrl: string | null;
  /** Probe error surfaced to the UI when state is null. */
  error?: string;
}

export interface ClusterStatusProbeDeps {
  nutanix: NutanixClient;
  /** Configured PC endpoint (e.g. `https://10.8.16.7:9440`). Used as-is
   *  to build the activation deep-link; pass `undefined` if unset and
   *  the probe will return enableUrl=null. */
  pcEndpoint: string | undefined;
  logger: Logger;
}

const ENABLE_PATH = '/dm/settings/prism_ops';

function buildEnableUrl(pcEndpoint: string | undefined): string | null {
  if (!pcEndpoint) return null;
  // Trim trailing slash so we don't end up with `…:9440//dm/…`.
  return pcEndpoint.replace(/\/+$/, '') + ENABLE_PATH;
}

export interface SoftwareVersionRow {
  /** Component label ("Prism Central", "AOS", "Files", …). */
  component: string;
  version: string;
  /** Cluster / PC name when the source reports one. */
  location?: string;
  /** `pc` = v3 clusters list (always available), `lcm` = LCM inventory. */
  source: 'pc' | 'lcm';
}

export interface SoftwareVersionsProbeResult {
  rows: SoftwareVersionRow[];
  /** Set when no source could answer. */
  error?: string;
}

/**
 * What the target actually runs — the generic "AOS + PC Demo - Latest" RX
 * workload is managed elsewhere, so versions drift vs OPERATOR.md.
 * PC + AOS come from the v3 clusters list; the rest (Files, AHV, NCC, …)
 * from the LCM inventory when one has run.
 */
export async function probeSoftwareVersions(
  deps: Pick<ClusterStatusProbeDeps, 'nutanix' | 'logger'>,
): Promise<SoftwareVersionsProbeResult> {
  const { nutanix, logger } = deps;
  if (nutanix.mode === 'mock') return { rows: [] };

  const rows: SoftwareVersionRow[] = [];
  const errors: string[] = [];

  try {
    const res = await nutanix.request<{
      entities?: Array<{
        status?: {
          name?: string;
          resources?: {
            config?: { build?: { version?: string }; service_list?: string[] };
          };
        };
      }>;
    }>('POST', '/api/nutanix/v3/clusters/list', { kind: 'cluster', length: 50 });
    for (const e of res?.entities ?? []) {
      const cfg = e?.status?.resources?.config;
      const version = cfg?.build?.version;
      if (!version) continue;
      const isPc = (cfg?.service_list ?? []).includes('PRISM_CENTRAL');
      const name = e?.status?.name;
      rows.push({
        component: isPc ? 'Prism Central' : 'AOS',
        version,
        // v3 reports the PC cluster as "Unnamed" — noise, drop it.
        location: name && name !== 'Unnamed' ? name : undefined,
        source: 'pc',
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('versions probe: clusters list failed', { err: msg });
    errors.push(msg);
  }

  try {
    const entities = await fetchLcmInventory(nutanix);
    // PC/AOS already covered by the clusters list — skip their LCM twins.
    const covered = new Set(
      rows.map((r) => (r.component === 'Prism Central' ? 'pc' : r.component.toLowerCase())),
    );
    const seen = new Set<string>();
    const lcmRows: SoftwareVersionRow[] = [];
    for (const e of entities) {
      if (e.entityType !== 'SOFTWARE' || !e.entityModel || !e.entityVersion) continue;
      if (covered.has(e.entityModel.toLowerCase())) continue;
      const key = `${e.entityModel}|${e.entityVersion}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lcmRows.push({
        component: e.entityModel,
        version: e.entityVersion,
        location: e.locationInfo?.locationName,
        source: 'lcm',
      });
    }
    lcmRows.sort((a, b) => a.component.localeCompare(b.component));
    rows.push(...lcmRows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('versions probe: LCM inventory failed', { err: msg });
    errors.push(msg);
  }

  return rows.length === 0 && errors.length > 0
    ? { rows, error: errors.join(' · ') }
    : { rows };
}

interface LcmInventoryEntity {
  entityType?: string;
  entityModel?: string;
  entityVersion?: string;
  locationInfo?: { locationName?: string };
}

/** Paginated LCM entities, v4.2 then v4.0 (older PCs). */
async function fetchLcmInventory(nutanix: NutanixClient): Promise<LcmInventoryEntity[]> {
  let lastErr: unknown;
  for (const v of ['v4.2', 'v4.0']) {
    try {
      const all: LcmInventoryEntity[] = [];
      for (let page = 0; page < 100; page++) {
        const res = await nutanix.request<{ data?: LcmInventoryEntity[] }>(
          'GET',
          `/api/lifecycle/${v}/resources/entities?$limit=100&$page=${page}`,
        );
        const batch = res?.data;
        if (!Array.isArray(batch)) {
          if (page === 0) throw new Error('no data field');
          break;
        }
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function probeIntelligentOps(
  deps: ClusterStatusProbeDeps,
): Promise<IntelligentOpsProbeResult> {
  const { nutanix, pcEndpoint, logger } = deps;

  if (nutanix.mode === 'mock') {
    return { state: null, enableUrl: null };
  }

  const enableUrl = buildEnableUrl(pcEndpoint);

  try {
    const response = await nutanix.request<{ data?: { isEnabled?: unknown } }>(
      'GET',
      '/api/prism/v4.2/resource-manager/products/prismops',
    );
    const enabled = response?.data?.isEnabled;
    if (typeof enabled !== 'boolean') {
      return { state: null, enableUrl, error: 'IOps status response has no boolean data.isEnabled' };
    }
    return { state: enabled ? 'ENABLED' : 'DISABLED', enableUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('intelligent-ops probe failed', { err: msg });
    return { state: null, enableUrl, error: msg };
  }
}

/**
 * Name of the first PE cluster (e.g. `DM3-POC004`) — seeds the {CLUSTER}
 * variable of the participant emails (VDI accounts are named
 * `<cluster>-User<seat>` and their password matches the cluster name on
 * HPoC). null in mock mode or when the probe fails.
 */
export async function probeClusterName(
  deps: Pick<ClusterStatusProbeDeps, 'nutanix' | 'logger'>,
): Promise<string | null> {
  const { nutanix, logger } = deps;
  if (nutanix.mode === 'mock') return null;
  try {
    const res = await nutanix.request<{
      entities?: Array<{
        status?: {
          name?: string;
          resources?: { config?: { service_list?: string[] } };
        };
      }>;
    }>('POST', '/api/nutanix/v3/clusters/list', { kind: 'cluster', length: 50 });
    for (const e of res?.entities ?? []) {
      const isPc = (e?.status?.resources?.config?.service_list ?? []).includes('PRISM_CENTRAL');
      const name = e?.status?.name;
      if (!isPc && name && name !== 'Unnamed') return name;
    }
    return null;
  } catch (err) {
    logger.warn('cluster name probe failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
