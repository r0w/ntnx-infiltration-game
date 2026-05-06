import type { CheckFunction } from './types';

export class CheckRegistry {
  private readonly fns = new Map<string, CheckFunction>();

  register(name: string, fn: CheckFunction): void {
    if (this.fns.has(name)) {
      throw new Error(`Check function already registered: ${name}`);
    }
    this.fns.set(name, fn);
  }

  registerAll(record: Record<string, CheckFunction>): void {
    for (const [name, fn] of Object.entries(record)) {
      this.register(name, fn);
    }
  }

  get(name: string): CheckFunction {
    const fn = this.fns.get(name);
    if (!fn) throw new Error(`Unknown check function: ${name}`);
    return fn;
  }

  has(name: string): boolean {
    return this.fns.has(name);
  }

  names(): string[] {
    return [...this.fns.keys()];
  }
}
