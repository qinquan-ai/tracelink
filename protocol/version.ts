/**
 * TraceLink wire-protocol generation.
 *
 * Increment only for wire-incompatible changes. Product releases that keep the
 * same HTTP headers, endpoints, SSE frames, and TraceLog schema retain this
 * value even when the package version changes.
 */
export const TRACE_PROTOCOL_VERSION = '1';

/** Historical header values that implement protocol generation 1. */
export const TRACE_PROTOCOL_COMPATIBLE_VERSIONS = ['1', '0.5.0', '0.4.0'] as const;

export function isTraceProtocolCompatible(version: string): boolean {
  return (TRACE_PROTOCOL_COMPATIBLE_VERSIONS as readonly string[]).includes(version);
}
