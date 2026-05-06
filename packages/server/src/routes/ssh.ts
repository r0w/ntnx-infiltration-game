import { Hono } from 'hono';
import { spawn } from 'node:child_process';
import net from 'node:net';

// Backs the /ssh sandbox terminal with REAL reachability probes — the
// frontend is a standalone tool that takes a whitelisted command and
// needs truthful results. Two primitives:
//
//   POST /api/ssh/ping  — `spawn('ping', ['-c', '4', target])`, output
//                         streamed back as an array of lines. No shell,
//                         so no injection — target is argv[1..n], not
//                         parsed by /bin/sh. Still validated before we
//                         hand it off, as defense-in-depth.
//
//   POST /api/ssh/tcp   — `net.createConnection({host, port: 22})` with
//                         a tight timeout. Succeeds if TCP:22 is open;
//                         for the /ssh command, that's "reachable enough"
//                         — we don't negotiate the SSH protocol, we only
//                         confirm the socket opens.
//
// This endpoint is agnostic of game sessions and stages — there's no
// auth, no session lookup, no pack wiring. Whatever /ssh ships in its
// whitelist, this route just probes.
//
// Input validation: targets must be an IPv4 literal (octets ≤ 255) or a
// conservative hostname shape (no leading dash → can't be mistaken for
// a ping/ssh arg flag; `A-Za-z0-9._-`; ≤ 253 chars). Anything else is a
// 400 — prevents both shell shenanigans and argv-injection attacks on
// the underlying binaries.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// Conservative hostname pattern: labels of [A-Za-z0-9-] joined by dots,
// no leading/trailing dash (would look like a CLI flag).
const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

const PING_TIMEOUT_MS = 8_000;
const TCP_TIMEOUT_MS = 4_000;
const TCP_PORT_SSH = 22;

function isValidTarget(t: string): boolean {
  if (t.length === 0 || t.length > 253) return false;
  if (t.startsWith('-')) return false;
  const ipMatch = IPV4_RE.exec(t);
  if (ipMatch) return ipMatch.slice(1, 5).every((o) => Number(o) <= 255);
  return HOSTNAME_RE.test(t);
}

export function buildSshRoutes(): Hono {
  const router = new Hono();

  router.post('/ping', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { target?: unknown } | null;
    const target = typeof body?.target === 'string' ? body.target.trim() : '';
    if (!isValidTarget(target)) {
      return c.json({ error: 'invalid target' }, 400);
    }
    const result = await runPing(target);
    return c.json(result);
  });

  router.post('/tcp', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { target?: unknown; port?: unknown } | null;
    const target = typeof body?.target === 'string' ? body.target.trim() : '';
    const port = typeof body?.port === 'number' && Number.isInteger(body.port) && body.port > 0 && body.port < 65_536
      ? body.port
      : TCP_PORT_SSH;
    if (!isValidTarget(target)) {
      return c.json({ error: 'invalid target' }, 400);
    }
    const result = await probeTcp(target, port);
    return c.json(result);
  });

  return router;
}

interface PingResult {
  ok: boolean;
  target: string;
  exitCode: number | null;
  output: string[];
  durationMs: number;
  error?: string;
}

function runPing(target: string): Promise<PingResult> {
  // `-c 4` on POSIX, `-n 4` on Windows. We assume POSIX here (bun
  // typically ships in a linux container during events); the win32
  // branch is a courtesy for dev machines.
  const isWin = process.platform === 'win32';
  const args = isWin
    ? ['-n', '4', '-w', '1000', target]
    : ['-c', '4', '-W', '2', target];
  return new Promise((resolve) => {
    const started = Date.now();
    const lines: string[] = [];
    let done = false;
    const child = spawn('ping', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const settle = (result: Omit<PingResult, 'target' | 'durationMs'>) => {
      if (done) return;
      done = true;
      resolve({ ...result, target, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({
        ok: false,
        exitCode: null,
        output: lines,
        error: 'ping timed out',
      });
    }, PING_TIMEOUT_MS);
    const absorb = (buf: Buffer) => {
      // Buffer incomplete lines across chunks; ping usually writes whole
      // lines but we can't rely on it.
      const text = buf.toString('utf8');
      const parts = text.split(/\r?\n/);
      for (const p of parts) if (p) lines.push(p);
    };
    child.stdout.on('data', absorb);
    child.stderr.on('data', absorb);
    child.on('error', (err) => {
      clearTimeout(timer);
      settle({ ok: false, exitCode: null, output: lines, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      settle({ ok: code === 0, exitCode: code, output: lines });
    });
  });
}

interface TcpResult {
  ok: boolean;
  target: string;
  port: number;
  ip?: string;
  durationMs: number;
  error?: string;
}

function probeTcp(target: string, port: number): Promise<TcpResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const socket = net.createConnection({ host: target, port, timeout: TCP_TIMEOUT_MS });
    const settle = (result: Omit<TcpResult, 'target' | 'port' | 'durationMs'>) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ ...result, target, port, durationMs: Date.now() - started });
    };
    socket.once('connect', () => {
      // Capture the resolved peer IP — Node sets `remoteAddress` after
      // connect — so the frontend can show it in the banner.
      const ip = socket.remoteAddress ?? undefined;
      settle({ ok: true, ip });
    });
    socket.once('timeout', () => settle({ ok: false, error: 'connection timed out' }));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      // Normalise a couple of common error codes into user-friendly labels.
      const label =
        err.code === 'ECONNREFUSED' ? 'connection refused'
        : err.code === 'ENOTFOUND' ? 'name or service not known'
        : err.code === 'EHOSTUNREACH' ? 'no route to host'
        : err.code === 'ETIMEDOUT' ? 'connection timed out'
        : err.message;
      settle({ ok: false, error: label });
    });
  });
}
