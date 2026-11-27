import { Hono } from 'hono';
import { probeInvocation, probeTcp, runProcess, validHeadUrl, validTarget, type ProbeCommand } from '../ssh-probes';

const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function buildSshRoutes() {
  const router = new Hono();
  const jobs = new Map<string, AbortController>();
  // Remember an early cancel if it overtakes the probe request on the network.
  const cancelled = new Map<string, number>();
  const pruneCancelled = () => {
    for (const [id, until] of cancelled) if (until < Date.now()) cancelled.delete(id);
  };

  router.post('/cancel', async c => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) return c.json({ error: 'invalid request id' }, 400);
    pruneCancelled();
    const job = jobs.get(body.requestId);
    if (job) job.abort();
    else if (cancelled.size < 256) cancelled.set(body.requestId, Date.now() + 30_000);
    else return c.json({ error: 'too many cancellations' }, 429);
    return c.json({ ok: true });
  });

  for (const command of ['ping', 'tcp', 'nslookup', 'traceroute', 'head'] as const) {
    router.post(`/${command}`, async c => {
      const body = await c.req.json().catch(() => null);
      const target = typeof body?.target === 'string' ? body.target.trim() : '';
      if (!(command === 'head' ? validHeadUrl(target) : validTarget(target))) return c.json({ error: 'invalid target' }, 400);
      const id = body?.requestId ?? crypto.randomUUID();
      if (typeof id !== 'string' || !REQUEST_ID.test(id)) return c.json({ error: 'invalid request id' }, 400);
      if (jobs.has(id)) return c.json({ error: 'request already running' }, 409);
      if (jobs.size >= 64) return c.json({ error: 'too many probes' }, 429);
      const controller = new AbortController();
      pruneCancelled();
      if (cancelled.delete(id)) controller.abort();
      jobs.set(id, controller);
      const onAbort = () => controller.abort();
      c.req.raw.signal.addEventListener('abort', onAbort, { once: true });
      if (c.req.raw.signal.aborted) controller.abort();
      try {
        if (command === 'tcp') {
          const port = Number.isInteger(body?.port) && body.port > 0 && body.port < 65_536 ? body.port : 22;
          return c.json(await probeTcp(target, port, controller.signal));
        }
        const [binary, args] = probeInvocation(command as ProbeCommand, target);
        const result = await runProcess(binary, args, controller.signal, command === 'traceroute' ? 15_000 : 10_000);
        return c.json({ ...result, target });
      } finally {
        jobs.delete(id);
        c.req.raw.signal.removeEventListener('abort', onAbort);
      }
    });
  }
  return router;
}
