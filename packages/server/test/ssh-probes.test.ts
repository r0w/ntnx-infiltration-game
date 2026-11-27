import { describe, expect, test } from 'bun:test';
import { probeInvocation, probeTcp, runProcess, validHeadUrl, validTarget } from '../src/ssh-probes';
import { buildSshRoutes } from '../src/routes/ssh';

const signal = () => new AbortController().signal;
const post = (app: ReturnType<typeof buildSshRoutes>, path: string, body: unknown) => app.request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('probe validation', () => {
  test('accepts IPv4, IPv6 and DNS names without accepting options or malformed literals', () => {
    for (const target of ['127.0.0.1', '::1', '2001:db8::42', '::ffff:192.0.2.1', 'fe80::1%eth0', 'lab.example', 'lab.example.']) expect(validTarget(target)).toBe(true);
    for (const target of ['-f', '999.1.2.3', '2001:::1', 'host;id', 'host\nfoo', 'a b', '$(id)', '[::1]', '']) expect(validTarget(target)).toBe(false);
  });
  test('HEAD accepts only HTTP(S) without credentials or argument injection', () => {
    for (const url of ['http://127.0.0.1:8080/', 'https://[::1]:9440/', 'https://lab.example/path?q=hello']) expect(validHeadUrl(url)).toBe(true);
    for (const url of ['file:///etc/passwd', 'ftp://lab.example', 'http://user:pass@localhost', '--config /tmp/file', 'https://host/\nfoo', 'http://[::gg]/']) expect(validHeadUrl(url)).toBe(false);
  });
  test('uses platform IPv6 tools and fixed curl arguments', () => {
    expect(probeInvocation('ping', '::1', 'linux')).toEqual(['ping', ['-6', '-c', '4', '::1']]);
    expect(probeInvocation('ping', '::1', 'darwin')[0]).toBe('ping6');
    expect(probeInvocation('traceroute', '::1', 'darwin')[0]).toBe('traceroute6');
    const [binary, args] = probeInvocation('head', 'https://[::1]/');
    expect(binary).toBe('curl');
    expect(args[0]).toBe('--disable');
    expect(args.slice(-2)).toEqual(['--', 'https://[::1]/']);
    expect(args).not.toContain('--location');
  });
});

describe('probe lifecycle', () => {
  test('keeps partial output chunks on one line', async () => {
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write('first');setTimeout(()=>process.stdout.write(' second\\n'),20)"], signal());
    expect(result.ok).toBe(true);
    expect(result.output).toEqual(['first second']);
  });
  test('cancelling kills and reaps the child process', async () => {
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ['-e', 'console.log(process.pid);setInterval(()=>{},1000)'], controller.signal);
    await Bun.sleep(200);
    controller.abort();
    const result = await pending;
    expect(result.error).toBe('cancelled');
    expect(result.durationMs).toBeLessThan(2000);
    const pid = Number(result.output[0]);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });
  test('timeout terminates a stalled child', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], signal(), 50);
    expect(result.error).toBe('probe timed out');
    expect(result.ok).toBe(false);
  });
  test('output is bounded and missing tools report failure', async () => {
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000))"], signal());
    expect(result.error).toBe('output limit reached');
    expect(result.output.join('').length).toBeLessThanOrEqual(65536);
    const missing = await runProcess('/nonexistent/nig-probe', [], signal());
    expect(missing.ok).toBe(false);
    expect(missing.error).toBeTruthy();
  });
  test('pre-cancelled TCP and process probes never start', async () => {
    const controller = new AbortController(); controller.abort();
    expect((await probeTcp('::1', 22, controller.signal)).error).toBe('cancelled');
    expect((await runProcess('/nonexistent/nig-probe', [], controller.signal)).error).toBe('cancelled');
  });
});

describe('probe routes', () => {
  test('rejects invalid targets for every new command', async () => {
    const app = buildSshRoutes();
    for (const path of ['/nslookup', '/traceroute', '/head']) {
      expect((await post(app, path, { target: '-f' })).status).toBe(400);
    }
  });
  test('an early cancellation covers all commands including IPv6', async () => {
    const app = buildSshRoutes();
    for (const path of ['/ping', '/tcp', '/nslookup', '/traceroute', '/head']) {
      const requestId = crypto.randomUUID();
      expect((await post(app, '/cancel', { requestId })).status).toBe(200);
      const response = await post(app, path, { requestId, target: path === '/head' ? 'http://[::1]/' : '::1' });
      expect(response.status).toBe(200);
      expect((await response.json()).error).toBe('cancelled');
    }
  });
  test('cancels a running ping using its request ID', async () => {
    const app = buildSshRoutes();
    const requestId = crypto.randomUUID();
    const pending = post(app, '/ping', { requestId, target: '127.0.0.1' });
    await Bun.sleep(150);
    await post(app, '/cancel', { requestId });
    const result = await (await pending).json();
    expect(result.ok).toBe(false);
    // A host without ping may fail before cancellation; the process lifecycle is tested above.
    expect(result.error).toBeTruthy();
    expect(result.durationMs).toBeLessThan(2000);
  });
  test('curl really sends HEAD, preserves headers and does not follow redirects', async () => {
    const methods: string[] = [];
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
      methods.push(req.method);
      return new Response(null, { status: 302, headers: { Location: '/elsewhere', 'X-NIG-Probe': 'verified' } });
    } });
    try {
      const app = buildSshRoutes();
      const result = await (await post(app, '/head', { target: `http://127.0.0.1:${server.port}/` })).json();
      expect(result.ok).toBe(true);
      expect(methods).toEqual(['HEAD']);
      expect(result.output.join('\n')).toContain('302');
      expect(result.output.join('\n').toLowerCase()).toContain('x-nig-probe: verified');
    } finally { server.stop(true); }
  });
});
