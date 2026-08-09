import { describe, expect, test } from 'bun:test';
import { INGRESS_PLACEHOLDER, kommanderDashboardUrl, probeKubeFacts } from '../src/kube-facts';
import type { KubeClient } from '@ntnx-game/engine';

/**
 * The published bootcamp writes `<ingress_lb_ip>` because one document serves
 * every lab. A running game knows the address, so it says it — and when it
 * cannot, it must fall back to that same placeholder rather than render a hole
 * into the middle of a hostname.
 */

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const ingress = (ip: string) => ({
  metadata: { name: 'x' },
  status: { loadBalancer: { ingress: [{ ip }] } },
});
const traefik = (ip: string) => ({
  metadata: { name: 'kommander-traefik' },
  status: { loadBalancer: { ingress: [{ ip }] } },
});

function kubeOf(byCluster: Record<string, { ingresses?: unknown[]; services?: unknown[] }>): KubeClient {
  return {
    list: async (ref: { plural: string; cluster?: string }) => {
      const key = ref.cluster ?? 'management';
      const bucket = byCluster[key] ?? {};
      return (ref.plural === 'ingresses' ? bucket.ingresses : bucket.services) ?? [];
    },
  } as unknown as KubeClient;
}

describe('kube facts', () => {
  test('reads each cluster its own ingress address', async () => {
    const facts = await probeKubeFacts(
      kubeOf({ management: { ingresses: [ingress('10.0.0.16')] }, workload01: { ingresses: [ingress('10.0.0.19')] } }),
      silent,
    );
    expect(facts).toEqual({ MgmtIngressIP: '10.0.0.16', Workload1IngressIP: '10.0.0.19' });
  });

  test('falls back to the Traefik service when no ingress is admitted yet', async () => {
    const facts = await probeKubeFacts(
      kubeOf({ management: { ingresses: [], services: [traefik('10.0.0.16')] }, workload01: { ingresses: [ingress('10.0.0.19')] } }),
      silent,
    );
    expect(facts.MgmtIngressIP).toBe('10.0.0.16');
  });

  test('an unreadable cluster keeps the bootcamp placeholder', async () => {
    const facts = await probeKubeFacts(
      { list: async () => { throw new Error('unreachable'); } } as unknown as KubeClient,
      silent,
    );
    expect(facts.MgmtIngressIP).toBe('<ingress_lb_ip>');
    expect(facts.Workload1IngressIP).toBe('<ingress_lb_ip>');
  });

  test('an empty fleet keeps the placeholder rather than an empty string', async () => {
    const facts = await probeKubeFacts(kubeOf({}), silent);
    expect(facts.Workload1IngressIP).toBe('<ingress_lb_ip>');
  });
});

// The Kommander console answers on the management ingress, which the probe above
// already knows — so the launch screen should not have to ask for it twice.
describe('kommander console url', () => {
  test('is built from the management ingress the fleet reported', () => {
    const url = kommanderDashboardUrl({ MgmtIngressIP: '10.54.93.15', Workload1IngressIP: '10.54.93.18' });
    expect(url).toBe('https://10.54.93.15/dkp/kommander/dashboard');
  });

  test('an operator-pinned address always wins', () => {
    const url = kommanderDashboardUrl(
      { MgmtIngressIP: '10.54.93.15', Workload1IngressIP: '10.54.93.18' },
      'https://nkp.lab.example/dkp/kommander/dashboard',
    );
    expect(url).toBe('https://nkp.lab.example/dkp/kommander/dashboard');
  });

  test('an unreadable fleet falls back rather than linking to the placeholder', () => {
    const url = kommanderDashboardUrl(
      { MgmtIngressIP: INGRESS_PLACEHOLDER, Workload1IngressIP: INGRESS_PLACEHOLDER },
      '  ',
    );
    expect(url).toBe('https://your-nkp-console/dkp/kommander/dashboard');
  });
});
