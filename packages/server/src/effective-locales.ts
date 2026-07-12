import type { Locale } from '@ntnx-game/engine';
import type { ClusterConfigQueries } from './db/queries';

/** cluster_config key holding the operator's per-locale enable overrides
 *  for WIP languages in `live` mode. Value: array of locale codes. */
export const WIP_LOCALES_ENABLED_KEY = 'wip_locales_enabled';

/**
 * Filter a pack's `supportedLocales` down to what end users should see in
 * the current environment. WIP locales are:
 *   - always visible in `mock` / `test` (for translators + QA), and
 *   - hidden in `live` unless the operator explicitly enabled the code
 *     from `/admin` (persisted in cluster_config).
 * Non-WIP locales are never filtered.
 */
export function effectiveSupportedLocales(
  supported: readonly Locale[],
  wip: readonly Locale[] | undefined,
  mode: 'mock' | 'test' | 'live',
  cfg: ClusterConfigQueries,
): Locale[] {
  const wipSet = new Set(wip ?? []);
  if (wipSet.size === 0 || mode !== 'live') return [...supported];
  const enabled = new Set(readEnabledWipLocales(cfg));
  return supported.filter((l) => !wipSet.has(l) || enabled.has(l));
}

/** Read the persisted operator override — always an array of locale codes. */
export function readEnabledWipLocales(cfg: ClusterConfigQueries): Locale[] {
  const v = cfg.get<unknown>(WIP_LOCALES_ENABLED_KEY);
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string');
}

/** Persist a new enabled set (dedup + sort for stable storage). */
export function writeEnabledWipLocales(
  cfg: ClusterConfigQueries,
  codes: readonly Locale[],
): void {
  const uniq = Array.from(new Set(codes)).sort();
  cfg.set(WIP_LOCALES_ENABLED_KEY, uniq, 'admin');
}
