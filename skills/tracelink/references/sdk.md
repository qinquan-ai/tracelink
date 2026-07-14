# SDK And Runtime Selection

## Existing SDKs

- Browser JavaScript: explicit spans and `BrowserHttpExporter`.
- Node JavaScript: same Engine plus `AsyncLocalStorage` runtime and
  `NodeHttpExporter`.
- Python: `ContextVar` runtime, local/HTTP Exporters, Scope SSE control, and an
  optional FastAPI/Starlette Extension.

Frontend frameworks such as React, Vue, Svelte, and Astro do not need separate
SDKs for explicit tracing. A framework Extension is only needed when TraceLink
must hook framework lifecycle automatically.

## New Language

Start with the protocol assets in `protocol/`:

1. Implement the `TraceLog` JSON Schema with camelCase wire keys.
2. Sanitize data and normalize layers before export.
3. POST one event to `/__debug_log` using a bounded, fail-safe Exporter.
4. Implement span open/close with stable `traceId` and `spanId`.
5. Use the language's native task/request context for automatic parents.
6. Implement HTTP Propagator headers and Scope SSE control.
7. Round-trip all golden fixtures.

A minimal exporter is useful but does not provide automatic context awareness.
Do not move parent inference into the Receiver.

Typical context primitives:

- Go: `context.Context`
- Java/Kotlin: request/coroutine context
- .NET: `AsyncLocal<T>`
- Rust: task-local context
- Swift/Kotlin mobile: platform coroutine/task context
