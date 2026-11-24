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

/** Example input for stage 31 in test/mock; no cluster comparison is required. */
async function lookupRunway(): Promise<string> {
  return '120';
}

export const autoFill = {
  NodeSerial: lookupNodeSerial,
  NumberUpdates: lookupNumberUpdates,
  Runway: lookupRunway,
};
