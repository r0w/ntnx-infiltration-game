import type { PackBootContext } from '@ntnx-game/engine';
import { kommanderDashboardUrl, probeKubeFacts } from './kube-facts';

/**
 * Boot hooks for the NKP Fundamentals bootcamp.
 *
 * The bootcamp is written generically — `<ingress_lb_ip>`, "your NKP console" —
 * because one document serves every lab. A running game holds a kubeconfig, so
 * it reads the real addresses off the fleet once at boot and the steps name
 * them. Everything here degrades to the published wording rather than throwing:
 * a game that cannot reach the fleet must still start and still read correctly.
 */
export async function variables(ctx: PackBootContext): Promise<Record<string, unknown>> {
  const { transports, env, logger } = ctx;
  const configured = env.NKP_DASHBOARD_URL;
  if (!transports.kube) {
    // No fleet to ask: keep the bootcamp's own generic wording.
    return {
      DashboardUrl: configured || 'https://your-nkp-console/dkp/kommander/dashboard',
    };
  }
  const facts = await probeKubeFacts(transports.kube, logger);
  const DashboardUrl = kommanderDashboardUrl(facts, configured);
  logger.info('kube facts resolved', {
    mgmt: facts.MgmtIngressIP,
    workload01: facts.Workload1IngressIP,
    dashboard: DashboardUrl,
  });
  return { ...facts, DashboardUrl };
}

/**
 * `/api/act/cleanup-all/user01`, `/01` and `/1` all mean learner 01.
 *
 * The operator endpoints build a context from a path segment rather than a
 * played session, so nothing has captured `UserNum` yet — and it has to be the
 * normalised form, because the mock fixtures are keyed `user{UserNum}` and
 * would otherwise resolve to `useruser01`. Anything that does not look like a
 * learner number is left alone: on this pack that is an operator typo, and
 * seeding a bad value would quietly act on the wrong namespace.
 */
export function identityFromPath(segment: string): Record<string, unknown> {
  const raw = segment.trim().toLowerCase().replace(/^user/, '');
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 99 || !/^\d{1,2}$/.test(raw)) return {};
  return { UserNum: String(n).padStart(2, '0') };
}
