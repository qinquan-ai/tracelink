# Changelog

## Initial Public Release

- Canonical `tracer` singleton and `Tracer` class.
- Local NDJSON and human-readable trace files.
- Scope filtering and session helpers.
- Optional Receiver-controlled Scope synchronization over a fail-safe daemon SSE client.
- Request-local `traceId` and Scope propagation through FastAPI/Starlette middleware.
- Explicit empty Scope arrays disable collection for that request.
- `contextvars` isolation across nested calls, `await`, and concurrent asyncio tasks.
- Span open/close events with `durationMs` and `async`.
- Span capture decisions remain consistent when Scope configuration changes mid-flight.
- `blocked` and `intent` outcomes with `data.reason`.
- Non-blocking, fail-safe HTTP exporter for the shared TraceLink Receiver.
- Optional FastAPI/Starlette middleware.
- PEP 561 inline typing through `py.typed`; Python 3.10 or newer.
- Shared `TraceLog` schema and protocol conformance with the JavaScript SDK.
