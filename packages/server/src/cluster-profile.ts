import type { ClusterProfile, Logger } from '@ntnx-game/engine';

export interface ResolveInput {
  explicit: ClusterProfile | undefined;
  logger: Logger;
}

/**
 * The blueprint launch dialog is the source of truth: the operator picks
 * `CLUSTER_PROFILE` ('hpoc' or 'other') at launch, and the BP install passes
 * it through as the container's env var. So this resolver is intentionally
 * thin: trust the explicit value when present, fall back to 'other' (the
 * fail-safe — destructive stages stay filtered).
 */
export function resolveClusterProfile({ explicit, logger }: ResolveInput): ClusterProfile {
  if (explicit) {
    logger.info('cluster profile from env', { profile: explicit });
    return explicit;
  }
  logger.warn(
    'CLUSTER_PROFILE not set — defaulting to other (destructive stages filtered). ' +
      'Set CLUSTER_PROFILE=hpoc when launching the blueprint on a reserved lab cluster.',
  );
  return 'other';
}
