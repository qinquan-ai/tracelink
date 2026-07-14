# API Reference

## JavaScript

| API | Purpose |
|---|---|
| `tracer.log(entry)` | Emit one event |
| `tracer.span(entry, fn)` | Emit paired open/close events and run `fn` in context |
| `tracer.blocked(fn, msg, options)` | Emit `outcome:'blocked'` with `data.reason` |
| `tracer.intent(fn, msg, options)` | Emit `outcome:'intent'` with `data.reason` |
| `tracer.addExporter(fn)` | Register a fail-safe `(TraceLog) => void` exporter |
| `tracer.configure({ httpExporter, scopeSync })` | Configure replaceable HTTP output and Scope control |
| `tracer.enableScope(name)` / `disableScope(name)` | Change local Scope gate |
| `tracer.enableAllScopes()` / `disableAllScopes()` | Enable or disable every Scope |
| `createTraceHeaders(options?)` | Build business-request propagation headers |
| `extractTraceContext(headers)` | Decode propagation headers |

Entries require `layer`, `fn`, and `msg`; optional fields include `data`,
`scope`, `level`, `outcome`, `userId`, and `parentSpanId`.

Package entries:

| Import | Key exports |
|---|---|
| `tracelink` | `tracer`, protocol helpers, context utilities, `MemoryExporter` |
| `tracelink/browser` | `BrowserHttpExporter`, DOM click instrumentation |
| `tracelink/node` | `NodeHttpExporter`, ALS context |
| `tracelink/receiver/http` | `startReceiverServer`, `createReceiverHandler` |
| `tracelink/receiver/vite` | `debugLogPlugin` |

## Python

| API | Purpose |
|---|---|
| `tracer.entry/internal/db/ws(...)` | Emit built-in backend layers |
| `tracer.span(layer, fn, msg, func, ...)` | Paired span lifecycle |
| `tracer.add_exporter(exporter)` | Register an exporter; returns unsubscribe |
| `tracer.configure(...)` | Configure HTTP exporter and Scope SSE control |
| `HttpExporter` | Bounded background HTTP export |
| `FileExporter` | Optional local NDJSON and readable-text output |
| `create_trace_headers()` | Build outgoing business-request headers |
| `TraceMiddleware` | FastAPI/Starlette incoming context extension |

`tracer.configure(http_endpoint=...)` returns the `HttpExporter`; call
`flush()` only for short-lived scripts. Startup enablement follows
`TRACELINK_ENABLED`, then `DEBUG`/`DEV` unless `enabled=` is passed.

Python enables `FileExporter` by default. Pass `file_enabled=False` when a
Receiver in the same project owns `.tracelink/`; otherwise both can write the
same files and produce duplicate rows. `TraceMiddleware` installs propagated
context but does not create application spans; instrument route or service
boundaries explicitly.
