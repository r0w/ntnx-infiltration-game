import type { Variables } from './types';

export type VariableChangeListener = (
  name: string,
  value: unknown,
  capturedAtStage: string,
) => void;

export class VariableStore implements Variables {
  private readonly data = new Map<string, { value: unknown; capturedAtStage: string }>();
  private listener: VariableChangeListener;

  constructor(initial: Record<string, unknown> = {}, listener: VariableChangeListener = () => {}) {
    this.listener = listener;
    for (const [name, value] of Object.entries(initial)) {
      this.data.set(name, { value, capturedAtStage: 'initial' });
    }
  }

  get(name: string): unknown {
    return this.data.get(name)?.value;
  }

  has(name: string): boolean {
    return this.data.has(name);
  }

  set(name: string, value: unknown, capturedAtStage: string): void {
    this.data.set(name, { value, capturedAtStage });
    this.listener(name, value, capturedAtStage);
  }

  delete(name: string): void {
    this.data.delete(name);
  }

  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, { value }] of this.data) {
      out[name] = value;
    }
    return out;
  }
}
