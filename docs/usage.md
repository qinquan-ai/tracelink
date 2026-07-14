# TraceLink Usage

English | [简体中文](./usage.zh-CN.md)

This page covers integration only. See [Architecture](./architecture.md) for
responsibilities and repository layout, and [Protocol](../protocol/CONFORMANCE.md)
for the wire contract.

## 1. Start the Receiver and Dashboard

```bash
npx tracelink dashboard
npx tracelink dashboard --port 6000 --no-open
```

The default entry is `http://127.0.0.1:5174/__debug_log/ui`. Port `5174` is a
default, not a fixed identity. After changing it, every Exporter and Dashboard
must point to the same Receiver. TraceLink never silently searches for the next
free port, which prevents two disconnected data sources from being created.

A Vite project can also host the Receiver in its development server:

```typescript
import { defineConfig } from 'vite';
import { debugLogPlugin } from 'tracelink/receiver/vite';

export default defineConfig({ plugins: [debugLogPlugin()] });
```

## 2. JavaScript SDK

### 2.1 Node

Import the complete Runtime Profile from `tracelink/node`. This entry installs
`AsyncLocalStorage`, keeping concurrent async-chain contexts isolated.

```typescript
import { NodeHttpExporter, tracer } from 'tracelink/node';

const exporter = new NodeHttpExporter({
  endpoint: 'http://127.0.0.1:5174/__debug_log',
  getEnabledScopes: () => tracer.getEnabledScopes(),
});
tracer.addExporter(exporter.send.bind(exporter));

await tracer.span({
  layer: 'BE-ENTRY',
  fn: 'orders.ts:create',
  msg: 'create order',
  scope: 'create-order',
}, async () => {
  tracer.layer('BE-DB', 'orderRepo.ts:insert', 'insert order');
});
```

### 2.2 Browser

```typescript
import { BrowserHttpExporter, tracer } from 'tracelink/browser';

const exporter = new BrowserHttpExporter({
  endpoint: '/__debug_log',
  getEnabledScopes: () => tracer.getEnabledScopes(),
});
tracer.addExporter(exporter.send.bind(exporter));
```

The browser's default `StackContextProvider` supports synchronous nesting and a
single async chain, but it cannot guarantee context isolation across arbitrary
concurrent Promise chains on one page. Node uses ALS; equivalent browser
guarantees require a future Async Context standard or a framework-level
Extension.

### 2.3 Spans and ordinary events

```typescript
tracer.log({
  layer: 'FE-ACTION',
  fn: 'CheckoutButton:onClick',
  msg: 'checkout clicked',
  scope: 'checkout',
  data: { cartSize: 3 },
});

await tracer.span({
  layer: 'FE-API',
  fn: 'checkoutApi:create',
  msg: 'POST /orders',
  scope: 'checkout',
}, submitOrder);
```

`span()` emits an open event immediately, then a close event with the same
`spanId` when the function finishes. The close event carries `durationMs` and
`async`. Internal events inherit the `traceId` and write the active span to
`parentSpanId`.

## 3. Python SDK

```bash
pip install tracelink
pip install "tracelink[fastapi]"
```

```python
from tracelink import tracer

exporter = tracer.configure(
    http_endpoint="http://127.0.0.1:5174/__debug_log",
    scope_sync_endpoint="http://127.0.0.1:5174/__debug_log/scopes",
    file_enabled=False,
)

async def create_order():
    tracer.db("order_repo.py:insert", "insert order", scope="create-order")

await tracer.span(
    "BE-ENTRY",
    "orders.py:create_order",
    "create order",
    create_order,
    scope="create-order",
)

exporter.flush(timeout=5.0)
```

`configure(http_endpoint=...)` returns the background `HttpExporter`. Its
`send()` method only enqueues work; network failures and full queues remain
fail-safe. Only short-lived scripts need to call `flush()` before exit.

You can also register a custom Exporter:

```python
from tracelink import HttpExporter, tracer

off = tracer.add_exporter(HttpExporter())
off()
```

### Exporter Modes and Selection

The Python SDK supports two output modes:

- **Offline file output (enabled by default):** `FileExporter` writes
  `.tracelink/trace.ndjson` and `.tracelink/trace.log`. A Receiver started from
  the same resolved project root can read `trace.ndjson` and replay it to the
  Dashboard.
- **Live HTTP output:** `HttpExporter` sends events to a running Receiver. Use
  this mode for frontend/backend or multi-service development.

When a Receiver in the same project owns `.tracelink/`, pass
`file_enabled=False`. Otherwise the Python SDK and Receiver can append the same
events to the same files and produce duplicate rows.


## 4. Cross-Service Propagation

An Exporter sends observed events to the Receiver. A Propagator sends business
request context to the next service. These are separate operations.

Outgoing JavaScript request:

```typescript
import { createTraceHeaders } from 'tracelink';

await fetch('/api/orders', {
  method: 'POST',
  headers: createTraceHeaders({ headers: { 'Content-Type': 'application/json' } }),
});
```

Outgoing Python request:

```python
from tracelink import create_trace_headers

requests.get(url, headers=create_trace_headers())
```

Incoming FastAPI request:

```python
from fastapi import FastAPI
from tracelink import TraceMiddleware

app = FastAPI()
app.add_middleware(TraceMiddleware)
```

Header meanings:

| Header | Meaning |
|---|---|
| `x-trace-id` | One trace shared across processes |
| `x-parent-span-id` | The caller's active span, which becomes the parent of the called service's first event |
| `x-debug-scopes` | JSON array containing the current capture Scope policy |

TraceLink does not globally patch `fetch`, Axios, Requests, or arbitrary
framework clients. Explicit helpers are searchable, can be disabled, and do
not change third-party request behavior. Future framework Extensions may call
the same Propagator automatically at well-defined boundaries.

## 5. Scope Capture Control

JavaScript:

```typescript
tracer.configure({
  scopeSync: { endpoint: 'http://127.0.0.1:5174/__debug_log/scopes' },
});
```

Python:

```python
tracer.configure(
    scope_sync_endpoint="http://127.0.0.1:5174/__debug_log/scopes",
)
```

The SDK connects to the `/scopes/stream` SSE endpoint. It receives the current
policy immediately, then receives pushes only when the policy changes. On
disconnect it retains the last policy and reconnects without fixed polling.

## 6. Dashboard Views and Data Actions

| Action | Exact Semantics |
|---|---|
| Clear screen | Only updates the log table's view cutoff. Does not delete Receiver history, clear Dashboard memory, or reset the call graphs. |
| Redraw | Creates a graph-only data cutoff at the current row, resetting both the live graph and the call-chain map. Does not delete Receiver history. |
| Clear history | Invokes DELETE `/__debug_log` to delete Receiver history files and clear all Dashboard logs and graph caches. |
| Fit to screen | Adjusts only the canvas camera view. |
| Reset default layout | Clears manual node positions in the call-chain map. |
| Export SVG | Exports the current call-chain map layout and visibility state. |

### Graph Views Description
- **Live graph**: Continuously updates nodes, edges, heat, and the timeline within the current graph window.
- **Call-chain map**: Accumulates traces within the current graph window and merges them into a stable skeleton based on invocation paths. Stable trace ordering uses immutable trace start time, never latest-event time.

> ℹ️ **Note**: The Receiver only ingests, persists, and streams events; it does not maintain graph layout. All graph layouts and accumulated caches belong to the Dashboard frontend.

## 7. Layer, Scope, and Outcome

- `layer` describes the technical position: `FE-ACTION`, `FE-API`, `BE-ENTRY`, `BE-DB`, and others.
- `scope` describes the business boundary: `checkout`, `delete-work`, or `agent-run`.
- `outcome` describes the result: missing means `call`; explicit values include `blocked` and `intent`.
- Reasons for `blocked` / `intent` live in `data.reason`; there is no top-level `reason`.
- Custom layers use `X-*`, for example `X-AI-INFERENCE`.

## 8. Minimal Integration for a New Language

A minimal implementation only needs to:

1. Construct a `TraceLog` that follows the JSON Schema.
2. POST one JSON object to `/__debug_log`.
3. Use a short timeout and never let failures alter application behavior.

This provides logs and manual relationships, but it cannot understand a
concurrent call stack automatically. A complete SDK also needs a native
Engine/Runtime to maintain `traceId`, `spanId`, and `parentSpanId`. Never infer
parent-child relationships in the Receiver from arrival order.

## 9. Production

TraceLink is a local development tool. Production builds should disable SDK
capture, omit the Receiver, and never expose the `127.0.0.1` Receiver to an
untrusted network. Exporter instances that send to remote systems must handle
authentication, privacy, rate limiting, and delivery guarantees independently.
