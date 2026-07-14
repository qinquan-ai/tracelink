/** Encode and decode TraceLink context on application HTTP requests. */

export const TRACE_ID_HEADER = 'x-trace-id';
export const PARENT_SPAN_ID_HEADER = 'x-parent-span-id';
export const SCOPES_HEADER = 'x-debug-scopes';

export interface PropagatedTraceContext {
  traceId?: string;
  parentSpanId?: string;
  scopes?: string[];
}

export interface TraceHeaderContext {
  traceId?: string;
  /** The active span becomes the remote side's parent span. */
  spanId?: string;
  scopes?: readonly string[];
}

export type TraceHeaders = Record<string, string>;

type HeaderReader =
  | { get(name: string): string | null }
  | Record<string, string | undefined>;

function hasHeaderGetter(
  headers: HeaderReader,
): headers is { get(name: string): string | null } {
  return typeof (headers as { get?: unknown }).get === 'function';
}

function readHeader(headers: HeaderReader, name: string): string | undefined {
  if (hasHeaderGetter(headers)) {
    return headers.get(name)?.trim() || undefined;
  }
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name,
  );
  return key ? headers[key]?.trim() || undefined : undefined;
}

function hasHeader(headers: TraceHeaders, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

export function parseScopesHeader(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    return Array.from(
      new Set(parsed.map(String).map((scope) => scope.trim()).filter(Boolean)),
    );
  } catch {
    return undefined;
  }
}

export function extractTraceContext(headers: HeaderReader): PropagatedTraceContext {
  return {
    traceId: readHeader(headers, TRACE_ID_HEADER),
    parentSpanId: readHeader(headers, PARENT_SPAN_ID_HEADER),
    scopes: parseScopesHeader(readHeader(headers, SCOPES_HEADER)),
  };
}

/**
 * Add propagation headers without overwriting caller-supplied headers.
 * Header-name matching is case-insensitive, as required by HTTP.
 */
export function injectTraceHeaders(
  headers: TraceHeaders = {},
  context: TraceHeaderContext = {},
): TraceHeaders {
  const result = { ...headers };
  if (context.traceId && !hasHeader(result, TRACE_ID_HEADER)) {
    result[TRACE_ID_HEADER] = context.traceId;
  }
  if (context.spanId && !hasHeader(result, PARENT_SPAN_ID_HEADER)) {
    result[PARENT_SPAN_ID_HEADER] = context.spanId;
  }
  if (context.scopes !== undefined && !hasHeader(result, SCOPES_HEADER)) {
    result[SCOPES_HEADER] = JSON.stringify(
      Array.from(new Set(context.scopes.map(String).map((scope) => scope.trim()).filter(Boolean))),
    );
  }
  return result;
}
