import type { ActFunction, CleanupFunction } from './types';

/**
 * Registry of per-stage **act** handlers — functions that perform the
 * cluster-side step the player would do via Prism Central GUI (create
 * user, create VM, attach category, …). Auto-play fires the registered
 * act for the stage that's awaiting input, then submits "Ok" so the
 * stage's check finds the resource it expects. Paired with {@link
 * CleanupRegistry} — each act should have a matching cleanup that
 * destroys what it created, keeping the HPoC tidy between runs.
 *
 * Parallel concept (do not confuse) — {@link ActionRegistry} (singular
 * `Action`) handles `<action name='X'/>` tags **embedded in stage
 * narrative locales**: those are narrative-fired side-effects (mock
 * overlay flips, recovery-point creation, etc.). Acts here are
 * stage-bound and fired by auto-play / cleanup harnesses, not by the
 * narrative.
 */
export class ActRegistry {
  private readonly handlers = new Map<string, ActFunction>();

  register(stageName: string, fn: ActFunction): void {
    this.handlers.set(stageName, fn);
  }

  get(stageName: string): ActFunction | undefined {
    return this.handlers.get(stageName);
  }

  has(stageName: string): boolean {
    return this.handlers.has(stageName);
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }
}

/**
 * Registry of per-stage cleanup handlers. A cleanup undoes what its matching
 * act created (or what a live player created). Safe to call without a
 * prior act — handlers should be idempotent and treat "already gone" as
 * success. Fired by the bulk-cleanup admin endpoint after an event.
 */
export class CleanupRegistry {
  private readonly handlers = new Map<string, CleanupFunction>();

  register(stageName: string, fn: CleanupFunction): void {
    this.handlers.set(stageName, fn);
  }

  get(stageName: string): CleanupFunction | undefined {
    return this.handlers.get(stageName);
  }

  has(stageName: string): boolean {
    return this.handlers.has(stageName);
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }
}
