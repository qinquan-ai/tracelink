# TraceLink

English | [简体中文](./README.zh-CN.md)

TraceLink is a local, dev-time tracing toolkit for reconstructing how a real
request, workflow, or AI-agent run moved through an application.

It ships:

- JavaScript and Python SDKs that produce the same `TraceLog` contract.
- A language-neutral protocol with JSON Schema and golden fixtures.
- One local Receiver for ingest, NDJSON persistence, SSE streaming, and Scope control.
- An embedded Dashboard with logs, a PixiJS live call graph, an SVG call-chain map, and a timeline.
- An AI Agent Skill for instrumenting and inspecting a trace.

Tracing is fail-safe by design: an exporter, control stream, or Dashboard failure
must not change application behavior.

## Architecture

```text
Application code
  -> language SDK
     -> Engine: span lifecycle, IDs, context, Scope gate, sanitization
     -> Runtime: browser stack, Node AsyncLocalStorage, Python ContextVar
     -> Transport: Exporters, HTTP Propagator, Scope control client
     -> Extensions: FastAPI adapter, DOM click instrumentation
  -> TraceLink Protocol
  -> Receiver
  -> Dashboard
```

There is no cross-language executable "Core" that Go, Rust, Python, and
JavaScript all import. Each language SDK implements context correctly with its
own runtime primitive. The reusable cross-language part is the Protocol plus the
single Receiver and Dashboard. An unsupported language can start with a small
HTTP exporter, then add an idiomatic context engine when automatic parent/child
spans are needed.

See [Architecture](./docs/architecture.md) for the directory model and platform
coverage.

## Install Packages

```bash
npm install tracelink
pip install tracelink
pip install "tracelink[fastapi]"   # optional FastAPI/Starlette extension
```

The npm package provides the JavaScript SDK, Receiver, and Dashboard. The PyPI
package provides the Python SDK. Neither package installs the optional AI Agent
Skill into an agent's skill directory.

## Install The AI Agent Skill

Install the repository's `tracelink` skill separately with the
[Skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add qinquan-ai/tracelink --skill tracelink
```

The CLI detects supported AI agents and either selects or prompts for the
installation target. Installation is project-local by default; pass `--global`
to make the skill available across projects. npm and pip never copy the skill
into an agent-specific directory automatically.

## Start The Dashboard

```bash
npx tracelink dashboard
npx tracelink dashboard --port 6000 --no-open
```

The default URL is `http://127.0.0.1:5174/__debug_log/ui`. Port `5174` is
configurable, but TraceLink never silently selects another port: every SDK and
the Dashboard must point at the same Receiver. `--force` only restarts another
identified TraceLink Receiver; it never kills an unrelated process.

## JavaScript

For Node, import the complete runtime profile so `AsyncLocalStorage` is installed:

```typescript
import { NodeHttpExporter, tracer } from "tracelink/node";

const exporter = new NodeHttpExporter({
  endpoint: "http://127.0.0.1:5174/__debug_log",
  getEnabledScopes: () => tracer.getEnabledScopes(),
});
tracer.addExporter(exporter.send.bind(exporter));

await tracer.span({
  layer: "BE-ENTRY",
  fn: "order.ts:createOrder",
  msg: "create order",
  scope: "create-order",
}, async () => {
  tracer.layer("BE-DB", "orderRepo.ts:insert", "insert order");
});
```

Browser applications use `BrowserHttpExporter` from `tracelink/browser`.
Vue, React, Svelte, Astro, and plain browser code use the same browser runtime;
framework-specific packages are not required for explicit tracing.

## Python

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

Python uses `contextvars.ContextVar`, so nested calls, `await`, and concurrent
asyncio tasks retain the correct parent. A newly created OS thread still needs
explicit context propagation.

## Cross-Service Context

Telemetry export and application-request propagation are separate operations.
Exporters send `TraceLog` events to the Receiver. Propagators put the active
context on a business HTTP request:

```typescript
import { createTraceHeaders } from "tracelink";

await fetch("/api/orders", { headers: createTraceHeaders() });
```

```python
from tracelink import TraceMiddleware, create_trace_headers

app.add_middleware(TraceMiddleware)
requests.get(url, headers=create_trace_headers())
```

The lightweight headers are `x-trace-id`, `x-parent-span-id`, and
`x-debug-scopes`. TraceLink does not patch global `fetch` or every HTTP client;
propagation is explicit unless a framework extension performs it.

## Scope Control

The Receiver owns the authoritative enabled Scope list. SDKs connect to the
Receiver's Scope SSE stream, receive the current policy immediately, and apply
later updates at the event source. This is push-based, not a two-second poll.

## Package Entry Points

| Import | Purpose |
|---|---|
| `tracelink` | Runtime-neutral Engine API, protocol helpers, memory exporter |
| `tracelink/browser` | Browser runtime, `BrowserHttpExporter`, DOM instrumentation |
| `tracelink/node` | Node runtime, `NodeHttpExporter`, `AsyncLocalStorage` context |
| `tracelink/receiver/http` | Standalone `node:http` Receiver |
| `tracelink/receiver/vite` | Vite development Receiver host |
| `tracelink/protocol/trace-log.schema.json` | Published wire schema |

Subpath exports are a public package map; they do not need to mirror the source
directory path.

## Trace Data

The Receiver writes:

```text
.tracelink/trace.ndjson   # one TraceLog JSON object per line
.tracelink/trace.log      # human-readable multi-line output
.tracelink/scopes.json    # persisted Scope catalog and enabled policy
```

💡 **Multi-Process & Cross-Service Debugging Configuration**:
* **What is "Multi-Process"?** It encompasses **all participants in the same business transaction flow**. For example, "frontend browser (JS SDK) + backend API (Python SDK)", or gateway, order-service, and user-service in a microservices system.
* **Single-Process Script Debugging**: Python enables its local `FileExporter` by default, writing events directly to `.tracelink/`. This is suitable for isolated script debugging where running a Receiver is unnecessary.
* **Multi-Process / Frontend + Backend Debugging**: You must initialize the Python SDK with **`file_enabled=False`** to disable local file writing, and configure the **`HttpExporter`** instead.
  * *Reason*: If each service writes to the directory independently, it causes duplicate entries by conflicting with the Receiver. **Multiple processes merge into a single, unified call-chain trace in the Dashboard only when their HTTP Exporters target the same central Receiver.**

⚠️ **Multi-Project Isolation & Port Conflicts**:
* A single Receiver instance only manages **one** local working directory at a time (defaulting to `.tracelink/` relative to where it was launched).
* If you develop two unrelated projects (e.g. `Project A` and `Project B`) simultaneously, to prevent their call graphs from mixing:
  1. You should run their Receivers on separate ports.
  2. For example, run Project A's Receiver on `5174` (writing to `ProjectA/.tracelink/`) and Project B's Receiver on `5176` (writing to `ProjectB/.tracelink/`).
  3. Update each project's client SDK configs to target their respective Receiver ports.



## Verification

```bash
npm run verify            # JS source/dist/tarball + Python tests/lint/wheel
```

The sibling Dashboard repository owns the full release pipeline:

```bash
cd ../debug_board
npm run verify:release
```

## Documentation

- [Architecture and platform coverage](./docs/architecture.md)
- [Detailed usage](./docs/usage.md)
- [Testing and release gates](./docs/testing.md)
- [Protocol and SDK conformance](./protocol/CONFORMANCE.md)
- [AI Agent Skill](./skills/tracelink/SKILL.md)
- [Cross-language AI-agent example](./examples/ai-agent/README.md)
- [Python SDK guide](./sdks/python/README.md)

## Security

The Receiver binds to `127.0.0.1` by default, has no authentication, and is for
local development only. Do not expose it to an untrusted network or ship it as
a production observability backend.

## License

MIT
