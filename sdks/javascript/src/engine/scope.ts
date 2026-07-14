/**
 * Scope control — decides whether an event should be emitted.
 *
 * Backed by an in-memory Set<string>. 'enabledScopes = ["*"]' means all.
 * Setting an empty array silences everything.
 */

import type { ScopeConfig, TraceLog } from './types.js';

class ScopeController {
  private enabledScopes: Set<string> = new Set(['*']);
  private listeners = new Set<(cfg: ScopeConfig) => void>();

  getConfig(): ScopeConfig {
    return { enabledScopes: Array.from(this.enabledScopes) };
  }

  enable(scope: string): void {
    this.enabledScopes.delete('*');
    this.enabledScopes.add(scope);
    this.notify();
  }

  disable(scope: string): void {
    this.enabledScopes.delete(scope);
    this.notify();
  }

  enableAll(): void {
    this.enabledScopes = new Set(['*']);
    this.notify();
  }

  /**
   * Replace the entire enabled-scope set in one shot. Used by scopeSync to
   * apply an authoritative list pulled from the receiver. `['*']` = all.
   */
  setEnabled(scopes: string[]): void {
    this.enabledScopes = new Set(scopes);
    this.notify();
  }

  disableAll(): void {
    this.enabledScopes = new Set();
    this.notify();
  }

  isEnabled(scope: string | undefined): boolean {
    if (this.enabledScopes.has('*')) return true;
    if (!scope) return false;
    return this.enabledScopes.has(scope);
  }

  /** Subscribe to scope changes (for dashboard sync). */
  subscribe(listener: (cfg: ScopeConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const cfg = this.getConfig();
    for (const fn of this.listeners) {
      try {
        fn(cfg);
      } catch {
        // listener errors must not break the tracer
      }
    }
  }
}

export const scopeController = new ScopeController();

/** Extract scope from a traceId like "delete-work-123456-abc". */
export function extractScope(traceId: string): string | null {
  if (!traceId || traceId === 'no-trace') return null;
  const m = traceId.match(/^([a-zA-Z-]+)-\d{6}-/);
  return m ? (m[1] ?? null) : null;
}

/** Decide if a log event should be emitted based on scope rules. */
export function shouldEmit(log: TraceLog): boolean {
  return scopeController.isEnabled(log.scope);
}
