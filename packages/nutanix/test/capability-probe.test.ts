import { describe, expect, test } from 'bun:test';
import type { Logger, NutanixClient } from '@ntnx-game/engine';
import { probeCapabilities } from '../src/capability-probe';
import { createMockAdapter } from '../src/mock-adapter';
import { NutanixTransportError } from '../src/errors';

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const ALL_OK = {
  'GET /api/ncm/v4.0/config/info': { data: { enabled: true } },
  'GET /api/io/v1/license': { data: { licensed: true } },
  'POST /api/nutanix/v3/blueprints/list': { entities: [{ metadata: { uuid: 'bp-1' } }] },
  'GET /api/clustermgmt/v4.0/config/clusters': {
    data: [{ extId: 'c1', config: { numberOfNodes: 4 } }],
  },
  // NodeRemove probe (tightened) calls discoverableNodeSerials, which in
  // mock mode short-circuits to this task-response endpoint. ALL_OK
  // returns 1 spare so the probe reports NodeRemove detected on the
  // happy path; tests that need "no spare" override this entry.
  'GET /api/clustermgmt/v4.2/config/task-response/mock-discover-task?taskResponseType=UNCONFIGURED_NODES': {
    data: { response: { nodeList: [{ rackableUnitSerial: 'TEST-SPARE-1' }] } },
  },
  'GET /api/calm/v3.0/features/policy': {
    spec: { feature_status: { is_enabled: true } },
  },
};

function brokenClient(): NutanixClient {
  return {
    mode: 'mock',
    async request() {
      throw new Error('network unreachable');
    },
  };
}

function mkSyscallErr(code: string): Error & { code: string } {
  const e = new Error(`connect ${code} 10.55.37.7:9440`) as Error & { code: string };
  e.code = code;
  return e;
}

describe('probeCapabilities', () => {
  test('detects all six capabilities when every endpoint responds healthily', async () => {
    const client = createMockAdapter(ALL_OK);
    const r = await probeCapabilities({ nutanix: client, logger: silentLogger });
    expect(r.flags.sort()).toEqual([
      'ApprovalPolicy',
      'CalmDSL',
      'IO',
      'MultiNode',
      'NCM',
      'NodeRemove',
    ]);
    expect(r.details).toHaveLength(6);
    for (const d of r.details) expect(d.detected).toBe(true);
  });

  test('single-node cluster does not enable NodeRemove or MultiNode', async () => {
    const client = createMockAdapter({
      ...ALL_OK,
      'GET /api/clustermgmt/v4.0/config/clusters': {
        data: [{ extId: 'c1', config: { numberOfNodes: 1 } }],
      },
    });
    const r = await probeCapabilities({ nutanix: client, logger: silentLogger });
    expect(r.flags).not.toContain('NodeRemove');
    expect(r.flags).not.toContain('MultiNode');
    const nr = r.details.find((d) => d.flag === 'NodeRemove')!;
    expect(nr.detail).toContain('1 node');
    const mn = r.details.find((d) => d.flag === 'MultiNode')!;
    expect(mn.detail).toContain('1 node');
  });

  test('explicitly is_enabled=false on policy feature is reported as not detected', async () => {
    const client = createMockAdapter({
      ...ALL_OK,
      'GET /api/calm/v3.0/features/policy': {
        spec: { feature_status: { is_enabled: false } },
      },
    });
    const r = await probeCapabilities({ nutanix: client, logger: silentLogger });
    expect(r.flags).not.toContain('ApprovalPolicy');
    const ap = r.details.find((d) => d.flag === 'ApprovalPolicy')!;
    expect(ap.detail).toContain('is_enabled=false');
  });

  test('explicitly unlicensed IO is reported as not detected', async () => {
    const client = createMockAdapter({
      ...ALL_OK,
      'GET /api/io/v1/license': { data: { licensed: false } },
    });
    const r = await probeCapabilities({ nutanix: client, logger: silentLogger });
    expect(r.flags).not.toContain('IO');
  });

  test('missing endpoints mark that capability absent without throwing', async () => {
    const client = createMockAdapter({
      'GET /api/ncm/v4.0/config/info': { data: { enabled: true } },
    });
    const r = await probeCapabilities({ nutanix: client, logger: silentLogger });
    expect(r.flags).toEqual(['NCM']);
    const io = r.details.find((d) => d.flag === 'IO')!;
    expect(io.detected).toBe(false);
    expect(io.detail).toMatch(/probe error/);
  });

  test('fully unreachable cluster yields zero capabilities, never throws', async () => {
    const r = await probeCapabilities({ nutanix: brokenClient(), logger: silentLogger });
    expect(r.flags).toEqual([]);
    expect(r.details).toHaveLength(6);
    for (const d of r.details) {
      expect(d.detected).toBe(false);
      expect(d.detail).toMatch(/probe error/);
    }
  });

  test('every probe failing with a transport error flags result.unreachable=true with the syscall code', async () => {
    // Models the "VPN down" case the operator hit: every endpoint
    // throws a NutanixTransportError carrying ENETUNREACH. Probe needs
    // to (a) keep boot alive (no throw), (b) flag .unreachable, and
    // (c) record transportCode on each detail so the boot diagnostic
    // can show the actual code instead of "fetch failed".
    const client: NutanixClient = {
      mode: 'live',
      async request(method: string, path: string) {
        throw new NutanixTransportError(method, path, mkSyscallErr('ENETUNREACH'));
      },
    };
    const r = await probeCapabilities({ nutanix: client, logger: silentLogger });
    expect(r.unreachable).toBe(true);
    expect(r.flags).toEqual([]);
    for (const d of r.details) {
      expect(d.transportError).toBe(true);
      expect(d.transportCode).toBe('ENETUNREACH');
    }
  });

  test('mixed transport+http failures do NOT flag unreachable (cluster IS responding, just missing features)', async () => {
    // 404 from a deprovisioned endpoint is normal — only flag
    // unreachable when EVERY probe failed at the transport layer.
    let n = 0;
    const client: NutanixClient = {
      mode: 'live',
      async request(method: string, path: string) {
        n++;
        if (n === 1) throw new NutanixTransportError(method, path, mkSyscallErr('ECONNREFUSED'));
        // Subsequent probes get a plain 404-style error (treated as HTTP
        // failure by the probe — endpoint not present).
        throw new Error('Nutanix GET /api/... failed: 404 Not Found');
      },
    };
    const r = await probeCapabilities({ nutanix: client, logger: silentLogger });
    expect(r.unreachable).toBe(false);
    // The one transport-error probe still gets flagged correctly.
    const transportCount = r.details.filter((d) => d.transportError).length;
    expect(transportCount).toBe(1);
  });

  test('node count reads cluster nodes array when numeric field absent', async () => {
    const client = createMockAdapter({
      ...ALL_OK,
      'GET /api/clustermgmt/v4.0/config/clusters': {
        data: [
          {
            extId: 'c1',
            nodes: { nodeList: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }] },
          },
        ],
      },
    });
    const r = await probeCapabilities({ nutanix: client, logger: silentLogger });
    expect(r.flags).toContain('NodeRemove');
    expect(r.flags).toContain('MultiNode');
    const nr = r.details.find((d) => d.flag === 'NodeRemove')!;
    expect(nr.detail).toContain('nodes=3');
  });

  test('multi-node cluster with no discoverable spare does NOT enable NodeRemove (but keeps MultiNode)', async () => {
    // Full-chassis case (e.g. 10.38.66.7 in `other` mode without BP node
    // shrink): 4 nodes is enough for live-migrate (MultiNode), but
    // expand-cluster (NodeRemove) requires a spare to attach.
    const client = createMockAdapter({
      ...ALL_OK,
      'GET /api/clustermgmt/v4.2/config/task-response/mock-discover-task?taskResponseType=UNCONFIGURED_NODES': {
        data: { response: { nodeList: [] } },
      },
    });
    const r = await probeCapabilities({ nutanix: client, logger: silentLogger });
    expect(r.flags).not.toContain('NodeRemove');
    expect(r.flags).toContain('MultiNode');
    const nr = r.details.find((d) => d.flag === 'NodeRemove')!;
    expect(nr.detail).toContain('discoverable spares=0');
  });
});
