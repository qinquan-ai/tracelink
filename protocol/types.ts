/**
 * TypeScript mirror of the language-neutral TraceLink wire contract.
 *
 * JSON Schema under `protocol/schema/` is the authoritative portable format.
 * This module exists so the JavaScript SDK and Receiver can share wire types
 * without depending on one another.
 */

export const BUILTIN_LAYERS = [
  'FE-ACTION',
  'FE-API',
  'FE-WS',
  'FE-UI',
  'BE-ENTRY',
  'BE-INTERNAL',
  'BE-DB',
  'BE-WS',
] as const;

export type BuiltinLayer = (typeof BUILTIN_LAYERS)[number];
export type CustomLayer = `X-${string}`;
export type TraceLayer = BuiltinLayer | CustomLayer | string;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type TraceOutcome = 'call' | 'blocked' | 'intent';

export interface TraceLog {
  /** Local time formatted as `[HH:mm:ss.SSS]`. */
  ts: string;
  layer: TraceLayer;
  fn: string;
  msg: string;
  level?: LogLevel;
  outcome?: TraceOutcome;
  data: Record<string, unknown>;
  traceId: string;
  spanId: string;
  scope?: string;
  userId?: string;
  parentSpanId?: string;
  durationMs?: number;
  async?: boolean;
}

export function isBuiltinLayer(layer: string): layer is BuiltinLayer {
  return (BUILTIN_LAYERS as readonly string[]).includes(layer);
}

export function isCustomLayer(layer: string): layer is CustomLayer {
  return layer.startsWith('X-');
}

export function normalizeLayer(input: string): string {
  if (!input) return 'FE-ACTION';
  const trimmed = input.trim();
  if (
    trimmed.startsWith('FE-') ||
    trimmed.startsWith('BE-') ||
    trimmed.startsWith('X-')
  ) {
    return trimmed;
  }
  return `X-${trimmed}`;
}
