/**
 * Nutanix JS SDKs (`@nutanix-api/*-js-client`) are generated from Swagger and
 * assume a browser runtime — their ApiClient constructor reads
 * `self.location.hostname` and `self.location.protocol` to seed defaults.
 * Bun exposes `self` (alias for globalThis) but not `self.location`, so the
 * SDK crashes at construction time with `TypeError: undefined is not an
 * object (evaluating 'self.location.hostname')`.
 *
 * This module installs the minimum shim so the SDK can construct without
 * reading real browser globals. Actual host/scheme are explicitly set on each
 * ApiClient instance (see sdk-adapter.ts), the shim values are never used.
 *
 * Import this once, before any `@nutanix-api/*-js-client` module. Idempotent —
 * safe to re-import if something else forgets.
 */
export function installSdkPolyfill(): void {
  const g = globalThis as typeof globalThis & {
    self?: unknown;
  };
  if (!g.self) g.self = g;
  const s = g.self as { location?: unknown };
  if (!s.location) {
    s.location = {
      hostname: 'localhost',
      protocol: 'https:',
      href: 'https://localhost/',
    };
  }
}

// Apply on import so the polyfill is in place before any SDK module is loaded
// (SDKs ship their own side-effectful top-level code that touches self).
installSdkPolyfill();
