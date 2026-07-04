import type { Logger, NutanixClient } from '@ntnx-game/engine';

/**
 * Live (non-cached) probe of Prism Central product enablement, exposed
 * to the operator via `/admin` Cluster tab. Currently surfaces just the
 * Intelligent Operations state — there is no public Nutanix API to
 * *enable* IOps (the v4 Domain Manager Products PUT hard-rejects with
 * PRI-55201, no v3 equivalent works either), so the operator has to
 * click in Prism UI Settings → Intelligent Operations. The point of
 * this probe is to spare them from having to remember which screen
 * shows the current state.
 *
 * Read-only: every call hits the live PC, no DB caching. The endpoint
 * is admin-gated and called only when the operator opens the Cluster
 * tab — frequency is low enough that caching adds no value and would
 * confuse "did my click in Prism UI take effect yet?".
 *
 * In `mock` mode this is a no-op (`state: null`): mock fixtures don't
 * model IOps, and the test suite shouldn't hit a real PC.
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
    const dmRes = await nutanix.request<{ data?: Array<{ extId?: string }> }>(
      'GET',
      '/api/prism/v4.2/config/domain-managers',
    );
    const pcExtId = dmRes?.data?.[0]?.extId;
    if (!pcExtId) {
      return { state: null, enableUrl, error: 'no domain-manager listed' };
    }
    const prodRes = await nutanix.request<{
      data?: Array<{ name?: string; enablementState?: string }>;
    }>(
      'GET',
      `/api/prism/v4.2/management/domain-managers/${pcExtId}/products?$limit=100`,
    );
    const product = (prodRes?.data ?? []).find((p) => p.name === 'INTELLIGENT_OPERATIONS');
    if (!product) {
      return { state: null, enableUrl, error: 'product not in PC portfolio' };
    }
    const raw = product.enablementState;
    const state: IntelligentOpsState | null =
      raw === 'ENABLED' || raw === 'DISABLED' ? raw : raw ? 'UNKNOWN' : null;
    return { state, enableUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('intelligent-ops probe failed', { err: msg });
    return { state: null, enableUrl, error: msg };
  }
}
