/** Build application-request headers from the active JavaScript SDK context. */

import { currentSpan } from '../../engine/context.js';
import { tracer } from '../../engine/tracer.js';
import {
  injectTraceHeaders,
  type TraceHeaders,
} from './http.js';

export interface CurrentTraceHeadersOptions {
  headers?: TraceHeaders;
  /** Resolve a trace from an active Scope session when no span is active. */
  scope?: string;
  traceId?: string;
  parentSpanId?: string;
  scopes?: readonly string[];
}

/**
 * Explicit helper for business HTTP calls. It does not patch global `fetch`.
 *
 * `fetch(url, { headers: createTraceHeaders() })`
 */
export function createTraceHeaders(
  options: CurrentTraceHeadersOptions = {},
): TraceHeaders {
  const span = currentSpan();
  const sessionTraceId = options.scope ? tracer.getTraceId(options.scope) : undefined;
  const traceId =
    options.traceId ?? sessionTraceId ?? span?.traceId;
  const canInheritSpan =
    span !== undefined &&
    (options.traceId === undefined || options.traceId === span.traceId) &&
    (options.scope === undefined || options.scope === span.scope);

  return injectTraceHeaders(options.headers, {
    traceId,
    spanId: options.parentSpanId ?? (canInheritSpan ? span.spanId : undefined),
    scopes: options.scopes ?? tracer.getEnabledScopes(),
  });
}
