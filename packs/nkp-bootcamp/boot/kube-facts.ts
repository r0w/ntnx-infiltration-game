import type { KubeClient, Logger } from '@ntnx-game/engine';

/**
 * Ingress addresses read off the fleet at boot, so the bootcamp's instructions
 * can name them instead of asking the learner to substitute a placeholder.
 *
 * The published bootcamp has to be generic: it is one document for every lab,
 * so it writes `<ingress_lb_ip>` and tells the reader to look the value up. A
 * running game holds a kubeconfig, so it can simply say the address. That is
 * the one place this pack deliberately says more than its source.
 *
 * Failure is not fatal and not silent: an unresolved address falls back to the
 * bootcamp's own placeholder, so the step still reads exactly like the
 * published lab rather than rendering a hole such as `wordpress42..sslip.io`.
 */
export interface KubeFacts {
  /** Traefik on the management cluster — the NKP UI address, ends in .15/.16. */
  MgmtIngressIP: string;
  /** Traefik on workload01, where the learner's own apps answer. */
  Workload1IngressIP: string;
}

/** What the bootcamp itself writes where the value is unknown. */
export const INGRESS_PLACEHOLDER = '<ingress_lb_ip>';
const PLACEHOLDER = INGRESS_PLACEHOLDER;

/**
 * The address a cluster's ingress answers on: the first LoadBalancer IP an
 * Ingress reports, falling back to the Traefik service itself for a cluster
 * whose ingresses are not admitted yet.
 */
async function ingressIp(kube: KubeClient, cluster?: string): Promise<string | null> {
  const lbIp = (o: unknown): string | undefined =>
    (o as { status?: { loadBalancer?: { ingress?: Array<{ ip?: string }> } } } | undefined)
      ?.status?.loadBalancer?.ingress?.[0]?.ip;

  const ingresses = await kube.list({
    group: 'networking.k8s.io', version: 'v1', plural: 'ingresses', cluster,
  });
  for (const ing of ingresses) {
    const ip = lbIp(ing);
    if (ip) return ip;
  }

  const services = await kube.list({ version: 'v1', plural: 'services', cluster });
  for (const svc of services) {
    const name = (svc as { metadata?: { name?: string } }).metadata?.name ?? '';
    if (!name.includes('traefik')) continue;
    const ip = lbIp(svc);
    if (ip) return ip;
  }
  return null;
}

/**
 * Resolve both addresses. Never throws: a fleet that cannot answer leaves the
 * placeholders in place and says so in the log, because a wrong address in a
 * lab instruction is worse than the generic wording.
 */
export async function probeKubeFacts(
  kube: KubeClient,
  logger: Logger,
  workloadCluster = 'workload01',
): Promise<KubeFacts> {
  const read = async (cluster: string | undefined, what: string): Promise<string> => {
    try {
      const ip = await ingressIp(kube, cluster);
      if (ip) return ip;
      logger.warn('kube facts: no ingress address found', { cluster: what });
    } catch (err) {
      logger.warn('kube facts: ingress probe failed', { cluster: what, err: String(err) });
    }
    return PLACEHOLDER;
  };

  const [mgmt, workload] = await Promise.all([
    read(undefined, 'management'),
    read(workloadCluster, workloadCluster),
  ]);
  return { MgmtIngressIP: mgmt, Workload1IngressIP: workload };
}

/**
 * The Kommander console URL the game links to.
 *
 * The console answers on the management cluster's ingress, which we have just
 * read off the fleet — so there is nothing for an operator to type unless they
 * want a different address (a DNS name, a different route). An explicit value
 * always wins; an unresolved address leaves the placeholder, because a link to
 * `https://<ingress_lb_ip>/…` is at least honest about not knowing.
 */
export function kommanderDashboardUrl(facts: KubeFacts, configured?: string): string {
  const given = (configured ?? '').trim();
  if (given) return given;
  if (facts.MgmtIngressIP === PLACEHOLDER) return 'https://your-nkp-console/dkp/kommander/dashboard';
  return `https://${facts.MgmtIngressIP}/dkp/kommander/dashboard`;
}
