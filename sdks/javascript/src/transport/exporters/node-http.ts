/**
 * Node.js HTTP exporter — POSTs each event to a TraceLink Receiver.
 *
 * Why a separate exporter for Node?
 *   Browsers have a page context: fetch('/__debug_log') resolves to the current
 *   origin automatically.  Node has no such context — every endpoint must be
 *   an absolute URL (e.g. 'http://127.0.0.1:5173/__debug_log').
 *
 * Node 18+ ships with a global `fetch`, so no extra dependencies are needed.
 * The exporter swallows all errors so it never crashes the host process.
 *
 * v0.3.0: refactored to accept getEnabledScopes callback instead of
 * importing scopeController, avoiding a reverse dependency on the Engine.
 */

import type { TraceLog } from '../../../../../protocol/types.js';
import { injectTraceHeaders } from '../propagators/http.js';

export interface NodeHttpExporterOptions {
  /** Required absolute URL, e.g. 'http://127.0.0.1:5173/__debug_log' */
  endpoint: string;
  /** Request timeout in ms (default: 2000) */
  timeoutMs?: number;
  /** Disable network entirely */
  disabled?: boolean;
  /**
   * Extra headers merged into every request.
   * Use for auth tokens, etc.  Default x-trace-id / x-debug-scopes
   * are included; extraHeaders values override them if keys collide.
   */
  extraHeaders?: Record<string, string>;
  /** Callback to read enabled scopes without coupling Transport to the Engine. */
  getEnabledScopes?: () => string[];
}

export class NodeHttpExporter {
  private endpoint: string;
  private timeoutMs: number;
  private disabled: boolean;
  private extraHeaders: Record<string, string>;
  private getEnabledScopes: () => string[];

  constructor(opts: NodeHttpExporterOptions) {
    this.endpoint = opts.endpoint;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.disabled = opts.disabled ?? false;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.getEnabledScopes = opts.getEnabledScopes ?? (() => ['*']);
  }

  send(log: TraceLog): void {
    if (this.disabled) return;
    if (typeof fetch === 'undefined') return;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const enabledScopes = this.getEnabledScopes();
      const headers = injectTraceHeaders(
        { 'Content-Type': 'application/json', ...this.extraHeaders },
        { traceId: log.traceId, spanId: log.spanId, scopes: enabledScopes },
      );
      void fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(log),
        signal: controller.signal,
      })
        .catch(() => {
          // network errors are expected in some envs — silently drop
        })
        .finally(() => {
          clearTimeout(timer);
        });
    } catch {
      // Never throw from an exporter.
    }
  }
}
