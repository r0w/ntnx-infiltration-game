import type { ActionFunction } from './types';

/**
 * Registry of server-side action handlers referenced by `<action name='foo'/>`
 * tags in stage messages. Parallel to {@link CheckRegistry} — the pack declares
 * its action functions in a module resolved at boot, and the session-service
 * dispatches them when a stage renders.
 */
export class ActionRegistry {
  private readonly handlers = new Map<string, ActionFunction>();

  register(name: string, fn: ActionFunction): void {
    this.handlers.set(name, fn);
  }

  get(name: string): ActionFunction | undefined {
    return this.handlers.get(name);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }
}
