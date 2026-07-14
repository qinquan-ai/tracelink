/** SDK-only input and state types built on the language-neutral wire contract. */

import type {
  LogLevel,
  TraceLayer,
  TraceOutcome,
} from '../../../../protocol/types.js';

export {
  BUILTIN_LAYERS,
  isBuiltinLayer,
  isCustomLayer,
  normalizeLayer,
} from '../../../../protocol/types.js';
export type {
  BuiltinLayer,
  CustomLayer,
  LogLevel,
  TraceLayer,
  TraceLog,
  TraceOutcome,
} from '../../../../protocol/types.js';

export interface TraceEntry {
  layer: TraceLayer;
  fn: string;
  msg: string;
  level?: LogLevel;
  outcome?: TraceOutcome;
  data?: Record<string, unknown>;
  scope?: string;
  userId?: string;
  parentSpanId?: string;
}

export interface ScopeConfig {
  /** Scopes to trace. `['*']` enables all; an empty list disables all. */
  enabledScopes: string[];
}

export interface ScopeSession {
  scope: string;
  traceId: string;
  startTime: number;
  recording?: boolean;
}
