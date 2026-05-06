import type { Logger } from '@ntnx-game/engine';

const fmt = (level: string, msg: string, data?: unknown) => {
  const base = `[${new Date().toISOString()}] ${level} ${msg}`;
  if (data === undefined) return base;
  try {
    return `${base} ${JSON.stringify(data)}`;
  } catch {
    return `${base} ${String(data)}`;
  }
};

// LOG_LEVEL filters by severity. Default `info` hides DEBUG noise
// (per-request response logs, capability-probe-failed traces). Set
// `LOG_LEVEL=debug` when troubleshooting transport / SDK calls.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type LevelName = keyof typeof LEVELS;
const envLevel = (process.env.LOG_LEVEL ?? '').trim().toLowerCase();
const threshold: number =
  envLevel in LEVELS ? LEVELS[envLevel as LevelName] : LEVELS.info;
const noop = () => {};

export const consoleLogger: Logger = {
  debug: threshold <= LEVELS.debug ? (m, d) => console.debug(fmt('DEBUG', m, d)) : noop,
  info: threshold <= LEVELS.info ? (m, d) => console.info(fmt('INFO', m, d)) : noop,
  warn: threshold <= LEVELS.warn ? (m, d) => console.warn(fmt('WARN', m, d)) : noop,
  error: threshold <= LEVELS.error ? (m, d) => console.error(fmt('ERROR', m, d)) : noop,
};
