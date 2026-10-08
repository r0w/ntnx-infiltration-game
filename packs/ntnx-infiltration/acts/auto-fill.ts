import type { AutoFillContext, CheckContext } from '@ntnx-game/engine';
import { discoverableNodeSerials } from '../checks/helpers';

/**
 * Auto-fill: read off the cluster the answer a player would normally type.
 *
 * Only ever offered in `mock` and `test` — a live demo in front of a room must
 * not skip a step. These live here rather than in the server because each one
 * names a variable and a stage of *this* game, and has to stay aligned with the
 * check that judges the same value: stage 28's serial comes from the same query
 * as CheckNewNode, and stage 29 stores any newly settled count before CheckUpdates reads it.
 */

/** Live lookup for stage 28 — first DISCOVERABLE (unconfigured) node serial.
 *  Same data source as CheckNewNode so auto-fill ↔ validation stay aligned. */
async function lookupNodeSerial(ctx: CheckContext): Promise<string | null> {
  try {
    const discoverable = await discoverableNodeSerials(ctx.nutanix, ctx.logger);
    return discoverable[0] ?? null;
  } catch {
    return null;
  }
}

/** Stage 29 reuses the cached count, retrying a missing boot reading without starting inventory. */
async function lookupNumberUpdates(ctx: AutoFillContext): Promise<string | null> {
  const cached = ctx.clusterConfig?.lcmAvailableUpdates;
  if (typeof cached === 'number') return String(cached);
  if (ctx.nutanix.mode === 'mock') return '0';
  const count = await ctx.probes.lcmAvailableUpdates();
  if (count === null) return null;
  const stored = await ctx.storeClusterFact({
    key: 'lcm_available_updates', value: count, write: 'refresh',
  });
  return typeof stored === 'number' ? String(stored) : null;
}

/** Live lookup for stage 31 — query OldPC's v3/groups runway endpoint. */
async function lookupRunway(ctx: CheckContext): Promise<string | null> {
  // Mock short-circuit: the OldPC lookup is a raw fetch (different host
  // than the main PC, can't go through the mock-adapter fixtures). Return
  // a canned value so mock auto-play can walk stage 31 — CheckRunway
  // accepts any positive integer in its format-only fallback path when
  // OldPC env vars aren't wired.
  if (ctx.nutanix.mode === 'mock') return '120';
  const oldPc = ctx.vars.get('OldPC');
  const user = ctx.vars.get('OldPCUsername');
  const pwd = ctx.vars.get('OldPCPassword');
  if (typeof oldPc !== 'string' || !oldPc || typeof user !== 'string' || typeof pwd !== 'string') {
    return null;
  }
  try {
    // Same scheme/port handling as CheckRunway: env may be a bare host
    // ('10.55.82.39') or a full URL. Detect by leading scheme.
    const stripped = oldPc.replace(/\/+$/, '');
    const base = /^https?:\/\//.test(stripped) ? stripped : `https://${stripped}:9440`;
    const now = Date.now();
    const res = await fetch(`${base}/api/nutanix/v3/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${btoa(`${user}:${pwd}`)}`,
      },
      body: JSON.stringify({
        entity_type: 'cluster',
        group_member_attributes: [{ attribute: 'capacity.runway' }],
        query_name: 'prism:RunwayInfoQueryModel',
        interval_start_ms: now - 3 * 86400 * 1000,
        interval_end_ms: now,
        downsampling_interval: 86400,
      }),
      tls: { rejectUnauthorized: false },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      group_results?: Array<{
        entity_results?: Array<{
          data?: Array<{ name?: string; values?: Array<{ values?: unknown[] }> }>;
        }>;
      }>;
    };
    const entry = body?.group_results?.[0]?.entity_results?.[0]?.data?.find(
      (d) => d.name === 'capacity.runway',
    );
    const v = entry?.values?.[0]?.values?.[0];
    return v != null ? String(v) : null;
  } catch {
    return null;
  }
}

export const autoFill = {
  NodeSerial: lookupNodeSerial,
  NumberUpdates: lookupNumberUpdates,
  Runway: lookupRunway,
};
