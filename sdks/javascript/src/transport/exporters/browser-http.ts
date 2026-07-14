/**
 * Browser HTTP exporter — POSTs each event to a TraceLink Receiver.
 * which writes to .tracelink/trace.ndjson and .tracelink/trace.log.
 *
 * Why not write directly from the browser? Browsers can't write to
 * arbitrary filesystem paths. We need the dev server as a proxy.
 *
 * v0.3.0: refactored to accept getEnabledScopes callback instead of
 * importing scopeController, avoiding a reverse dependency on the Engine.
 */

import type { TraceLog } from '../../../../../protocol/types.js';
import { injectTraceHeaders } from '../propagators/http.js';

export interface BrowserHttpExporterOptions {
  /** Override the default endpoint (default: '/__debug_log') */
  endpoint?: string;
  /** Disable network entirely (e.g. in tests) */
  disabled?: boolean;
  /** Callback to read enabled scopes without coupling Transport to the Engine. */
  getEnabledScopes?: () => string[];
}

export class BrowserHttpExporter {
  private endpoint: string;
  private disabled: boolean;
  private getEnabledScopes: () => string[];

  constructor(opts: BrowserHttpExporterOptions = {}) {
    this.endpoint = opts.endpoint ?? '/__debug_log';
    this.disabled = opts.disabled ?? false;
    this.getEnabledScopes = opts.getEnabledScopes ?? (() => ['*']);
  }

  send(log: TraceLog): void {
    if (this.disabled) return;
    if (typeof fetch === 'undefined') return;
    try {
      const enabledScopes = this.getEnabledScopes();
      void fetch(this.endpoint, {
        method: 'POST',
        headers: injectTraceHeaders(
          { 'Content-Type': 'application/json' },
          { traceId: log.traceId, spanId: log.spanId, scopes: enabledScopes },
        ),
        body: JSON.stringify(log),
      }).catch(() => {
        // network errors are expected in some envs — silently drop
      });
    } catch {
      // Never throw from an exporter.
    }
  }
}
