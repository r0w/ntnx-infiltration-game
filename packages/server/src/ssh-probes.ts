import { spawn } from 'node:child_process';
import net from 'node:net';

const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;

export function validTarget(target: string): boolean {
  if (!target || target.length > 253) return false;
  if (net.isIP(target)) return true;
  // Malformed numeric addresses must not fall through as hostnames.
  if (/^[\d.]+$/.test(target)) return false;
  return HOSTNAME_RE.test(target);
}

export function validHeadUrl(value: string): boolean {
  if (value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password
      && validTarget(url.hostname.replace(/^\[|\]$/g, ''));
  } catch { return false; }
}

export type ProbeCommand = 'ping' | 'nslookup' | 'traceroute' | 'head';

export function probeInvocation(command: ProbeCommand, target: string, platform = process.platform): [string, string[]] {
  const ipv6 = net.isIP(target) === 6;
  switch (command) {
    case 'ping':
      if (platform === 'win32') return ['ping', ['-n', '4', '-w', '1000', target]];
      return [ipv6 && platform === 'darwin' ? 'ping6' : 'ping', [
        ...(ipv6 && platform !== 'darwin' ? ['-6'] : []), '-c', '4', target,
      ]];
    case 'nslookup': return ['nslookup', [target]];
    case 'traceroute':
      if (platform === 'win32') return ['tracert', ['-d', '-h', '12', '-w', '1000', target]];
      return [ipv6 && platform === 'darwin' ? 'traceroute6' : 'traceroute', [
        ...(ipv6 && platform !== 'darwin' ? ['-6'] : []), '-n', '-m', '12', '-q', '1', '-w', '1', target,
      ]];
    // Ignore curlrc/proxy environment; allow only HEAD over HTTP(S), no redirects.
    case 'head': return ['curl', ['--disable', '--head', '--silent', '--show-error',
      '--connect-timeout', '4', '--max-time', '8', '--proto', '=http,https', '--noproxy', '*', '--', target]];
  }
}

export interface ProcessResult {
  ok: boolean;
  exitCode: number | null;
  output: string[];
  durationMs: number;
  error?: string;
}

/** Drain bounded output and wait for the child to exit after cancellation. */
export function runProcess(command: string, args: string[], signal: AbortSignal, timeoutMs = 10_000): Promise<ProcessResult> {
  const started = Date.now();
  if (signal.aborted) return Promise.resolve({ ok: false, exitCode: null, output: [], durationMs: 0, error: 'cancelled' });
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const buffers: Buffer[] = [];
    let bytes = 0;
    let error: string | undefined;
    let settled = false;
    const stop = (reason: string) => {
      error ??= reason;
      child.kill('SIGKILL');
    };
    const onAbort = () => stop('cancelled');
    const timer = setTimeout(() => stop('probe timed out'), timeoutMs);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ ok: exitCode === 0 && !error, exitCode,
        output: Buffer.concat(buffers).toString('utf8').split(/\r?\n/).filter(Boolean),
        durationMs: Date.now() - started, ...(error ? { error } : {}),
      });
    };
    const absorb = (chunk: Buffer) => {
      const remaining = 64 * 1024 - bytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        buffers.push(kept);
        bytes += kept.length;
      }
      if (chunk.length > remaining) stop('output limit reached');
    };
    child.stdout.on('data', absorb);
    child.stderr.on('data', absorb);
    child.once('error', err => { error ??= err.message; finish(null); });
    child.once('close', finish);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function probeTcp(target: string, port: number, signal: AbortSignal) {
  return new Promise<{ ok: boolean; target: string; port: number; ip?: string; durationMs: number; error?: string }>(resolve => {
    const started = Date.now();
    if (signal.aborted) { resolve({ ok: false, target, port, durationMs: 0, error: 'cancelled' }); return; }
    const socket = net.createConnection({ host: target, port });
    let done = false;
    const settle = (result: { ok: boolean; ip?: string; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve({ ...result, target, port, durationMs: Date.now() - started });
    };
    const onAbort = () => settle({ ok: false, error: 'cancelled' });
    // Wall-clock timeout also bounds DNS resolution before a socket exists.
    const timer = setTimeout(() => settle({ ok: false, error: 'connection timed out' }), 4_000);
    socket.once('connect', () => settle({ ok: true, ip: socket.remoteAddress }));
    socket.once('error', (err: NodeJS.ErrnoException) => settle({ ok: false, error:
      err.code === 'ECONNREFUSED' ? 'connection refused'
      : err.code === 'ENOTFOUND' ? 'name or service not known'
      : err.code === 'EHOSTUNREACH' ? 'no route to host'
      : err.code === 'ETIMEDOUT' ? 'connection timed out' : err.message,
    }));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
