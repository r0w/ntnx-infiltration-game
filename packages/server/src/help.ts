import type { ClusterConfigQueries } from './db/queries';

/** cluster_config key holding the operator's global help switch (boolean). */
export const HELP_ENABLED_KEY = 'help_enabled';

/** Global flag. Step-by-step help is OFF until the operator turns it on. */
export function readHelpEnabledGlobally(cfg: ClusterConfigQueries): boolean {
  return cfg.get<unknown>(HELP_ENABLED_KEY) === true;
}

export function writeHelpEnabledGlobally(cfg: ClusterConfigQueries, enabled: boolean): void {
  cfg.set(HELP_ENABLED_KEY, enabled, 'admin');
}

/**
 * Effective flag for one session: the player-level value wins over the global
 * flag, in both directions (forced on while the global flag is off, and
 * forced off while it is on). `null` = the player follows the global flag.
 */
export function resolveHelpEnabled(override: boolean | null, globalEnabled: boolean): boolean {
  return override ?? globalEnabled;
}
