export interface NutanixHttpErrorInit {
  status: number;
  method: string;
  path: string;
  body: string;
  cause?: unknown;
}

export class NutanixHttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: string;

  constructor(init: NutanixHttpErrorInit) {
    super(`Nutanix ${init.method} ${init.path} failed: ${init.status} ${truncate(init.body, 200)}`);
    this.name = 'NutanixHttpError';
    this.status = init.status;
    this.method = init.method;
    this.path = init.path;
    this.body = init.body;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }

  isRetryable(): boolean {
    return this.status >= 500 && this.status < 600;
  }
}

export class NutanixTransportError extends Error {
  readonly method: string;
  readonly path: string;
  /**
   * Lowest-level syscall code surfaced by walking the cause chain
   * (`ENETUNREACH` / `ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN` / etc.).
   * Bun's fetch wraps the syscall error two layers deep: the top-level
   * `Error` says only "fetch failed", the actionable code lives on
   * `cause.cause.code`. Hoisting it here so logs and the act-current
   * 500 response can render something more useful than "fetch failed".
   * `undefined` when the cause didn't carry a code (e.g. abort/timeout).
   */
  readonly code?: string;

  constructor(method: string, path: string, cause: unknown) {
    const root = findRootCause(cause);
    const code = extractCode(root);
    const rootMsg = root instanceof Error ? root.message : String(root);
    const codeSuffix = code && !rootMsg.includes(code) ? ` [${code}]` : '';
    super(`Nutanix ${method} ${path} transport error: ${truncate(rootMsg, 200)}${codeSuffix}`);
    this.name = 'NutanixTransportError';
    this.method = method;
    this.path = path;
    if (code !== undefined) this.code = code;
    (this as { cause?: unknown }).cause = cause;
  }

  isRetryable(): boolean {
    return true;
  }
}

function findRootCause(err: unknown): unknown {
  let cur = err;
  // Bound the walk; `cause` chains in the wild rarely exceed 2-3 hops.
  for (let i = 0; i < 5; i++) {
    if (!(cur instanceof Error)) return cur;
    const next = (cur as { cause?: unknown }).cause;
    if (next === undefined || next === null) return cur;
    cur = next;
  }
  return cur;
}

function extractCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
