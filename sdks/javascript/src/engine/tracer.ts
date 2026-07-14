/**
 * Trace Engine — builds and dispatches protocol-compatible events.
 *
 * Pipeline:
 *   1. receive entry from tracer.log()
 *   2. attach timestamp, spanId, scope-derived traceId
 *   3. sanitize data
 *   4. normalize layer name (FE-/BE-/X- prefix enforced)
 *   5. check scope filter
 *   6. fan out to all registered exporters
 *
 * Runtime profiles and Transport components compose this engine for users.
 */

import type { ScopeSession, TraceEntry, TraceLayer, TraceLog } from './types.js';
import {
  BUILTIN_LAYERS,
  isBuiltinLayer,
  normalizeLayer,
} from './types.js';
import { sanitizeData } from './sanitize.js';
import { currentSpan, runInSpan } from './context.js';
import { scopeController } from './scope.js';
import { ScopeSyncClient } from '../transport/control/scope-sync.js';
import type { ScopeSyncOptions } from '../transport/control/scope-sync.js';
import { consoleExporter } from '../transport/exporters/console.js';
import { MemoryExporter } from '../transport/exporters/memory.js';
import { formatTs, makeSpanId, makeTraceId, now } from './time.js';

export type TraceExporter = (log: TraceLog) => void;

/**
 * External HTTP exporters are NOT imported here. Users opt in by passing an
 * exporter callback to configure(). This keeps the engine runtime-neutral.
 *
 *   import { tracer } from 'tracelink';
 *   import { BrowserHttpExporter } from 'tracelink/browser';
 *   const exporter = new BrowserHttpExporter({ getEnabledScopes: () => tracer.getEnabledScopes() });
 *   tracer.configure({
 *     httpExporter: exporter.send.bind(exporter),
 *   });
 */
/**
 * scopeSync — opt-in "control which scopes get collected, from the outside".
 *
 * When enabled, the tracer opens the receiver's Scope control stream and
 * applies each authoritative `enabled` snapshot to its local capture gate.
 * The receiver pushes the current policy immediately and every later change.
 */
export type { ScopeSyncOptions } from '../transport/control/scope-sync.js';

export interface TracerConfig {
  /** Master switch — false makes all exporters no-op. */
  enabled?: boolean;
  /** Use the in-memory exporter (default: true). */
  memory?: boolean;
  /** Memory buffer cap */
  memoryCap?: number;
  /** HTTP exporter callback, for example `exporter.send.bind(exporter)`. */
  httpExporter?: TraceExporter;
  /** Console exporter override (advanced) */
  consoleExporter?: TraceExporter;
  /**
   * Stream a receiver's authoritative enabled Scope list into this tracer.
   * Pass `false` (or `null`) to stop a running sync.
   */
  scopeSync?: ScopeSyncOptions | false | null;
}

/**
 * Options for the outcome helpers `blocked()` / `intent()`. The `reason` is
 * folded into `data.reason` (no top-level reason field). `layer` defaults to
 * `'FE-ACTION'`; `level` defaults per helper (`blocked` → warn, `intent` → info).
 */
export interface OutcomeOptions {
  reason?: string;
  data?: Record<string, unknown>;
  layer?: TraceLayer;
  level?: TraceEntry['level'];
  scope?: string;
  userId?: string;
  parentSpanId?: string;
}

/** Minimal thenable detection — mirrors the check in context.ts. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

class Tracer {
  private memoryExporter = new MemoryExporter();
  private memoryEnabled = true;
  private consoleExporterInstance: TraceExporter = consoleExporter;
  private httpExporter: TraceExporter | null = null;
  private enabled = true;
  private activeSessions = new Map<string, ScopeSession>();
  private customExporters: TraceExporter[] = [];
  private scopeSyncClient: ScopeSyncClient | null = null;
  /**
   * Layer registry — maps an `X-*` name to a human-readable description and
   * a console color hint. Registry entries are advisory only (they show up
   * in summaries and help AI agents disambiguate); they do NOT restrict
   * which layer names can be emitted. This is by design — see
   * the protocol conformance contract.
   */
  private layerRegistry = new Map<
    string,
    { description: string; color?: string }
  >();

  configure(cfg: TracerConfig): void {
    if (cfg.enabled !== undefined) this.enabled = cfg.enabled;
    if (cfg.memory !== undefined) this.memoryEnabled = cfg.memory;
    if (cfg.memoryCap !== undefined) {
      this.memoryExporter = new MemoryExporter(cfg.memoryCap);
    }
    if (cfg.consoleExporter !== undefined) {
      this.consoleExporterInstance = cfg.consoleExporter;
    }
    if (cfg.httpExporter !== undefined) {
      this.httpExporter = cfg.httpExporter;
    }
    if ('scopeSync' in cfg) {
      this.stopScopeSync();
      if (cfg.scopeSync) this.startScopeSync(cfg.scopeSync);
    }
  }

  // ============================================================================
  // scopeSync — stream authoritative scope config from a receiver
  // ============================================================================

  private startScopeSync(opts: ScopeSyncOptions): void {
    const client = new ScopeSyncClient(opts, (enabled) => this.applyScopes(enabled));
    this.scopeSyncClient = client;
    client.start();
  }

  /** Stop Scope synchronization and close its control stream. */
  stopScopeSync(): void {
    this.scopeSyncClient?.stop();
    this.scopeSyncClient = null;
  }

  private applyScopes(enabled: string[]): void {
    if (enabled.includes('*')) {
      scopeController.enableAll();
    } else {
      scopeController.setEnabled(enabled);
    }
  }

  // ============================================================================
  // Master switch
  // ============================================================================

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ============================================================================
  // Scope session (session mode)
  // ============================================================================

  startScope(scope: string): string {
    const traceId = makeTraceId(scope);
    const recording = this.enabled && scopeController.isEnabled(scope);
    this.activeSessions.set(scope, {
      scope,
      traceId,
      startTime: now(),
      recording,
    });
    if (recording) {
      this.emit(
        {
          layer: 'FE-ACTION',
          fn: 'Tracer:startScope',
          msg: `开始追踪: ${scope}`,
          scope,
          data: { scope, traceId },
        },
        { bypassCaptureGate: true },
      );
    }
    return traceId;
  }

  endScope(scope: string): number | null {
    const session = this.activeSessions.get(scope);
    if (!session) return null;
    const duration = now() - session.startTime;
    if (session.recording) {
      this.emit(
        {
          layer: 'FE-ACTION',
          fn: 'Tracer:endScope',
          msg: `结束追踪: ${scope}`,
          scope,
          data: { scope, duration },
        },
        { bypassCaptureGate: true },
      );
    }
    this.activeSessions.delete(scope); // delete AFTER emit so getTraceId works
    return duration;
  }

  getTraceId(scope: string): string | undefined {
    return this.activeSessions.get(scope)?.traceId;
  }

  getActiveScopes(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  // ============================================================================
  // Scope filter
  // ============================================================================

  enableScope(scope: string): void {
    scopeController.enable(scope);
  }

  disableScope(scope: string): void {
    scopeController.disable(scope);
  }

  enableAllScopes(): void {
    scopeController.enableAll();
  }

  disableAllScopes(): void {
    scopeController.disableAll();
  }

  getEnabledScopes(): string[] {
    return scopeController.getConfig().enabledScopes;
  }

  // ============================================================================
  // Layer registry — for custom (X-*) layers
  // ============================================================================

  /**
   * Register a custom layer. Optional but recommended for AI agent readability.
   * See the protocol conformance contract for the namespace rules.
   *
   *   tracer.registerLayer('X-RENDER', {
   *     description: 'Three.js scene render frame',
   *     color: '#88ff88',
   *   });
   *
   * Not registering an X-* layer is allowed — the layer still emits.
   * Registration just adds metadata to `summary()` and console color hints.
   */
  registerLayer(
    name: string,
    meta: { description: string; color?: string },
  ): void {
    const normalized = normalizeLayer(name);
    if (isBuiltinLayer(normalized)) {
      // Built-in layers don't need (and reject) registration overrides.
      return;
    }
    this.layerRegistry.set(normalized, meta);
  }

  getRegisteredLayers(): Record<string, { description: string; color?: string }> {
    const result: Record<string, { description: string; color?: string }> = {};
    for (const layer of BUILTIN_LAYERS) {
      result[layer] = { description: builtinDescription(layer) };
    }
    for (const [name, meta] of this.layerRegistry) {
      result[name] = meta;
    }
    return result;
  }

  // ============================================================================
  // Log entry — the main API
  // ============================================================================

  log(entry: TraceEntry): void {
    this.emit(entry);
  }

  /**
   * Open a span scope for `fn`. Auto span context, v2.
   *
   * A fresh `spanId` is generated and the entry is emitted as a normal log so
   * the span-open is visible (that log's `spanId` = the generated span id and
   * its `parentSpanId` = the enclosing span, if any). `fn` then runs with the
   * new span installed as the active context, so any `tracer.log()` /
   * `tracer.action()` / ... inside it automatically inherits
   * `parentSpanId = <this span's spanId>` and shares the enclosing `traceId`
   * (unless the child passes an explicit `parentSpanId`/`scope`, which wins).
   *
   * Works for sync and async `fn`: if `fn()` returns a Promise the context
   * frame is held until it settles — delegated to the active ContextProvider.
   * The browser/default provider handles sync nesting and a single async
   * chain; import `tracelink/node` for async-correct context across
   * `await` and concurrent async.
   */
  span<T>(entry: TraceEntry, fn: () => T): T {
    const parent = currentSpan();
    const spanId = makeSpanId();
    const scope = entry.scope ?? parent?.scope;
    const parentSpanId = entry.parentSpanId ?? (
      parent?.recording === false ? undefined : parent?.spanId
    );
    const recording = !(
      parent?.recording === false && entry.scope === undefined
    ) && this.enabled && scopeController.isEnabled(scope);

    let traceId: string;
    if (entry.scope) {
      // Explicit scope keeps the existing session/scope-derived behavior.
      traceId = this.getTraceId(entry.scope) ?? makeTraceId(entry.scope);
    } else if (parent) {
      // No explicit scope but nested — share the enclosing trace.
      traceId = parent.traceId;
    } else {
      traceId = 'no-trace';
    }

    if (recording) {
      this.emit(entry, { spanId, traceId, bypassCaptureGate: true });
    }

    // Measure the real elapsed time around fn() and emit a "close" event
    // carrying durationMs + async, correlated by the SAME spanId/traceId. We
    // Keep the open event for live visibility and add a correlated close event.
    const start = now();
    const emitClose = (isAsync: boolean): void => {
      if (!recording) return;
      this.emit(
        { ...entry, parentSpanId },
        {
          spanId,
          traceId,
          durationMs: now() - start,
          async: isAsync,
          bypassCaptureGate: true,
        },
      );
    };

    let result: T;
    try {
      result = runInSpan({ spanId, traceId, scope, recording }, fn);
    } catch (err) {
      emitClose(false);
      throw err;
    }

    if (isThenable(result)) {
      return (result as unknown as Promise<unknown>).then(
        (value) => {
          emitClose(true);
          return value;
        },
        (err) => {
          emitClose(true);
          throw err;
        },
      ) as unknown as T;
    }

    emitClose(false);
    return result;
  }

  /**
   * Emit a `blocked` outcome — an intercepted / rejected / not-really-executed
   * call. Defaults to `level: 'warn'` and `layer: 'FE-ACTION'` (both
   * overridable). The human-readable reason goes into `data.reason` (there is
   * no top-level reason field).
   */
  blocked(fn: string, msg: string, opts: OutcomeOptions = {}): void {
    this.emitOutcome('blocked', 'warn', fn, msg, opts);
  }

  /**
   * Emit an `intent` outcome — an intent or no-op (wanted to, but didn't).
   * Defaults to `level: 'info'` and `layer: 'FE-ACTION'` (both overridable).
   * The reason goes into `data.reason`.
   */
  intent(fn: string, msg: string, opts: OutcomeOptions = {}): void {
    this.emitOutcome('intent', 'info', fn, msg, opts);
  }

  private emitOutcome(
    outcome: 'blocked' | 'intent',
    defaultLevel: 'warn' | 'info',
    fn: string,
    msg: string,
    opts: OutcomeOptions,
  ): void {
    const data =
      opts.reason !== undefined
        ? { ...(opts.data ?? {}), reason: opts.reason }
        : opts.data;
    this.emit({
      layer: opts.layer ?? 'FE-ACTION',
      fn,
      msg,
      level: opts.level ?? defaultLevel,
      outcome,
      data,
      scope: opts.scope,
      userId: opts.userId,
      parentSpanId: opts.parentSpanId,
    });
  }

  /** Convenience helpers matching the 4 FE layers. */
  action(fn: string, msg: string, data?: Record<string, unknown>): void {
    this.emit({ layer: 'FE-ACTION', fn, msg, data });
  }

  api(fn: string, msg: string, data?: Record<string, unknown>): void {
    this.emit({ layer: 'FE-API', fn, msg, data });
  }

  ws(fn: string, msg: string, data?: Record<string, unknown>): void {
    this.emit({ layer: 'FE-WS', fn, msg, data });
  }

  ui(fn: string, msg: string, data?: Record<string, unknown>): void {
    this.emit({ layer: 'FE-UI', fn, msg, data });
  }

  /** Generic layer helper — for any built-in (BE-ENTRY/BE-INTERNAL/BE-DB/BE-WS). */
  layer(
    layerName: 'BE-ENTRY' | 'BE-INTERNAL' | 'BE-DB' | 'BE-WS',
    fn: string,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    this.emit({ layer: layerName, fn, msg, data });
  }

  /**
   * Custom layer helper — pass any X-* name (or omit registration; we
   * normalize on emit). Example:
   *
   *   tracer.custom('X-RENDER', 'scene.ts:render', 'Frame drawn', { fps: 60 });
   *
   * If you call this often, registerLayer() it once for nicer metadata.
   */
  custom(
    layer: string,
    fn: string,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    this.emit({ layer, fn, msg, data });
  }

  // ============================================================================
  // Memory access (for dashboard / tracer.summary())
  // ============================================================================

  summary(): ReturnType<MemoryExporter['summary']> {
    return this.memoryExporter.summary();
  }

  allLogs(): TraceLog[] {
    return this.memoryExporter.all();
  }

  clearMemory(): void {
    this.memoryExporter.clear();
  }

  // ============================================================================
  // Custom exporters (advanced — MCP, file writers, adapters, etc.)
  // ============================================================================

  addExporter(exporter: TraceExporter): () => void {
    this.customExporters.push(exporter);
    return () => {
      const i = this.customExporters.indexOf(exporter);
      if (i >= 0) this.customExporters.splice(i, 1);
    };
  }

  // ============================================================================
  // Internal — build log + fan out
  // ============================================================================

  private emit(
    entry: TraceEntry,
    forced?: {
      spanId?: string;
      traceId?: string;
      durationMs?: number;
      async?: boolean;
      bypassCaptureGate?: boolean;
    },
  ): TraceLog | undefined {
    const bypassCaptureGate = forced?.bypassCaptureGate === true;
    if (!bypassCaptureGate && !this.enabled) return undefined;

    // Auto span context: an enclosing span (if any) supplies the default
    // parent span, scope, and trace to inherit. Explicit fields still win.
    const ctx = currentSpan();
    const scope = entry.scope ?? ctx?.scope;

    if (
      !bypassCaptureGate &&
      ctx?.recording === false &&
      entry.scope === undefined
    ) {
      return undefined;
    }

    let traceId: string;
    if (forced?.traceId !== undefined) {
      traceId = forced.traceId;
    } else if (entry.scope) {
      const sessionTraceId = this.getTraceId(entry.scope);
      traceId = sessionTraceId ?? makeTraceId(entry.scope);
    } else if (ctx) {
      traceId = ctx.traceId;
    } else {
      traceId = 'no-trace';
    }

    if (!bypassCaptureGate && !scopeController.isEnabled(scope)) return undefined;

    const log: TraceLog = {
      ts: formatTs(),
      layer: normalizeLayer(entry.layer),
      fn: entry.fn,
      msg: entry.msg,
      level: entry.level,
      outcome: entry.outcome,
      data: sanitizeData(entry.data),
      traceId,
      spanId: forced?.spanId ?? makeSpanId(),
      scope,
      userId: entry.userId,
      parentSpanId: entry.parentSpanId ?? (
        ctx?.recording === false ? undefined : ctx?.spanId
      ),
      durationMs: forced?.durationMs,
      async: forced?.async,
    };

    // Fan out — each exporter is isolated from application code.
    try {
      this.consoleExporterInstance(log);
    } catch {
      // ignore
    }
    if (this.memoryEnabled) {
      try {
        this.memoryExporter.add(log);
      } catch {
        // ignore
      }
    }
    if (this.httpExporter) {
      try {
        this.httpExporter(log);
      } catch {
        // ignore
      }
    }
    for (const exporter of this.customExporters) {
      try {
        exporter(log);
      } catch {
        // ignore
      }
    }

    return log;
  }
}

function builtinDescription(layer: string): string {
  switch (layer) {
    case 'FE-ACTION':
      return 'User clicks, form submits';
    case 'FE-API':
      return 'Outgoing HTTP request';
    case 'FE-WS':
      return 'WebSocket message';
    case 'FE-UI':
      return 'DOM/scroll/viewport check';
    case 'BE-ENTRY':
      return 'API endpoint entry';
    case 'BE-INTERNAL':
      return 'Internal helper';
    case 'BE-DB':
      return 'Database op';
    case 'BE-WS':
      return 'WebSocket push';
    default:
      return '';
  }
}

export const tracer = new Tracer();
