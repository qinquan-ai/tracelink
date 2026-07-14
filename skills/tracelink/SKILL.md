---
name: tracelink
description: Add or inspect TraceLink dev-time tracing for requests, workflows, and AI-agent runs. Use when instrumenting spans, debugging real call chains, connecting JavaScript or Python SDKs to the local Receiver/Dashboard, propagating trace context across HTTP, controlling Scope collection, or implementing a TraceLink SDK/exporter in another language.
---

# TraceLink

Use TraceLink to observe what actually executed. Keep instrumentation explicit,
searchable, fail-safe, and disabled in production.

## Workflow

1. Identify the application runtimes and one authoritative Receiver endpoint.
2. Start the Receiver/Dashboard if needed: `npx tracelink dashboard`.
3. Select the complete SDK runtime profile:
   - Browser: `tracelink/browser`
   - Node: `tracelink/node`
   - Python: `tracelink`
4. Register an HTTP Exporter that targets the Receiver. In Python, pass
   `file_enabled=False` when a Receiver in the same project owns `.tracelink/`.
5. Add spans at meaningful boundaries: user action, request entry, service call,
   database operation, tool call, guardrail, or background task.
6. Propagate context on business HTTP requests when crossing processes.
7. Reproduce once, then inspect by `scope`, `traceId`, and `parentSpanId`.
8. Run the host project's existing tests/build; tracing failures must not alter behavior.

## JavaScript

Node:

```typescript
import { NodeHttpExporter, tracer } from 'tracelink/node';

const exporter = new NodeHttpExporter({
  endpoint: 'http://127.0.0.1:5174/__debug_log',
  getEnabledScopes: () => tracer.getEnabledScopes(),
});
tracer.addExporter(exporter.send.bind(exporter));
```

Browser:

```typescript
import { BrowserHttpExporter, tracer } from 'tracelink/browser';

const exporter = new BrowserHttpExporter();
tracer.addExporter(exporter.send.bind(exporter));
```

Trace a boundary:

```typescript
await tracer.span({
  layer: 'BE-ENTRY',
  fn: 'orders.ts:create',
  msg: 'create order',
  scope: 'create-order',
}, createOrder);
```

Import `tracelink/node` for concurrent async Node work; it installs
`AsyncLocalStorage`. Do not claim the browser stack provider gives equivalent
arbitrary Promise-concurrency isolation.

## Cross-Service HTTP

```typescript
import { createTraceHeaders } from 'tracelink';

fetch('/api/orders', { headers: createTraceHeaders() });
```

Use Python `create_trace_headers()` for outgoing calls and `TraceMiddleware` for
incoming FastAPI/Starlette requests. These carry `x-trace-id`,
`x-parent-span-id`, and `x-debug-scopes`. Do not claim TraceLink globally patches
fetch/Axios/Requests.

## Scope Control

Configure the SDK against `/__debug_log/scopes`. It uses an SSE control stream:
the Receiver sends the current policy immediately and pushes later changes.
Do not implement periodic polling unless a target runtime cannot consume SSE.

## Boundaries

- The language SDK owns context and parent determination.
- The Protocol is language-neutral.
- The Receiver stores/streams events and owns Scope policy.
- The Dashboard visualizes Receiver data.
- `Sender` is only a protocol role; concrete output components are Exporters.
- The Receiver cannot infer parents from event arrival order.
- An unsupported language may begin with a minimal HTTP exporter, but automatic
  nesting requires that language's native context mechanism.

## References

- Read [references/api.md](references/api.md) for JavaScript/Python APIs.
- Read [references/sdk.md](references/sdk.md) for runtime selection and new-language SDK work.
- Read [references/wire-schema.md](references/wire-schema.md) for event and propagation semantics.
- Read [references/dashboard.md](references/dashboard.md) for Receiver endpoints and troubleshooting.
