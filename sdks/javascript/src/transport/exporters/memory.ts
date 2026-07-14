/**
 * Memory exporter — stores events in a bounded ring buffer for in-page queries
 * (used by tracer.summary() and the dashboard).
 *
 * Default cap: 1000 events. Older events are dropped on overflow.
 */

import type { TraceLog } from '../../engine/types.js';

const DEFAULT_CAP = 1000;

export class MemoryExporter {
  private buffer: TraceLog[] = [];
  private cap: number;

  constructor(cap = DEFAULT_CAP) {
    this.cap = cap;
  }

  add(log: TraceLog): void {
    this.buffer.push(log);
    if (this.buffer.length > this.cap) {
      this.buffer.shift();
    }
  }

  all(): TraceLog[] {
    return this.buffer.slice();
  }

  byScope(scope: string): TraceLog[] {
    return this.buffer.filter((l) => l.scope === scope);
  }

  summary(): { total: number; byLayer: Record<string, number>; byScope: Record<string, number> } {
    const byLayer: Record<string, number> = {};
    const byScope: Record<string, number> = {};
    for (const l of this.buffer) {
      byLayer[l.layer] = (byLayer[l.layer] ?? 0) + 1;
      if (l.scope) {
        byScope[l.scope] = (byScope[l.scope] ?? 0) + 1;
      }
    }
    return { total: this.buffer.length, byLayer, byScope };
  }

  clear(): void {
    this.buffer = [];
  }
}
