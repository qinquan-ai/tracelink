/**
 * Public entry — what users import as `import { tracer } from 'tracelink'`.
 *
 * Runtime-neutral tracing exports. Complete Browser and Node profiles are in
 * separate subpaths:
 *   - tracelink/browser : BrowserHttpExporter, installAutoClick
 *   - tracelink/node    : NodeHttpExporter
 * Receiver hosts live under tracelink/receiver/*.
 */

export { tracer } from './engine/tracer.js';
export type { TraceExporter, TracerConfig, ScopeSyncOptions } from './engine/tracer.js';

export { scopeController } from './engine/scope.js';
export type { ScopeConfig } from './engine/types.js';

export {
  BUILTIN_LAYERS,
  isBuiltinLayer,
  isCustomLayer,
  normalizeLayer,
} from './engine/types.js';
export type {
  BuiltinLayer,
  CustomLayer,
  TraceLayer,
  TraceLog,
  TraceEntry,
  TraceOutcome,
  LogLevel,
  ScopeSession,
} from './engine/types.js';

export {
  StackContextProvider,
  setContextProvider,
  currentSpan,
  runInSpan,
} from './engine/context.js';
export type { SpanContext, ContextProvider } from './engine/context.js';

export { MemoryExporter } from './transport/exporters/memory.js';

export {
  PARENT_SPAN_ID_HEADER,
  SCOPES_HEADER,
  TRACE_ID_HEADER,
  extractTraceContext,
  injectTraceHeaders,
  parseScopesHeader,
} from './transport/propagators/http.js';
export type {
  PropagatedTraceContext,
  TraceHeaderContext,
  TraceHeaders,
} from './transport/propagators/http.js';
export { createTraceHeaders } from './transport/propagators/current-http.js';
export type { CurrentTraceHeadersOptions } from './transport/propagators/current-http.js';

export { sanitize, sanitizeData } from './engine/sanitize.js';
export { formatTs, makeTraceId, makeSpanId, now } from './engine/time.js';
export {
  TRACE_PROTOCOL_COMPATIBLE_VERSIONS,
  TRACE_PROTOCOL_VERSION,
  isTraceProtocolCompatible,
} from '../../../protocol/version.js';
