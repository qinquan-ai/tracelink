# TraceLink Python SDK

English | [简体中文](https://github.com/qinquan-ai/tracelink/blob/main/sdks/python/README.zh-CN.md)

The Python SDK builds protocol-compatible spans, keeps async context with
`contextvars`, writes optional local files, exports events to the shared
TraceLink Receiver, and integrates incoming FastAPI/Starlette requests.

It does not ship a Python Receiver, Dashboard, or CLI. Start those from the npm
package with `npx tracelink dashboard`.

## Install

```bash
pip install tracelink
pip install "tracelink[fastapi]"
```

## Optional AI Agent Skill

The PyPI package provides the Python SDK but does not install the repository's
AI Agent Skill. Install that separately with the
[Skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add qinquan-ai/tracelink --skill tracelink
```

The CLI detects supported AI agents and either selects or prompts for the
installation target. Installation is project-local by default; pass `--global`
to make the skill available across projects.

## Trace And Export

```python
from tracelink import tracer

exporter = tracer.configure(
    enabled=True,
    http_endpoint="http://127.0.0.1:5174/__debug_log",
    scope_sync_endpoint="http://127.0.0.1:5174/__debug_log/scopes",
    file_enabled=False,
)

async def load_order():
    tracer.db("orders.py:load", "load order", scope="checkout")

await tracer.span(
    "BE-ENTRY",
    "routes.py:checkout",
    "checkout",
    load_order,
    scope="checkout",
)

exporter.flush(timeout=5.0)
```

Without `enabled=True`, startup follows `TRACELINK_ENABLED`, then the `DEBUG` or
`DEV` environment variables. `TRACELINK_SCOPES` initializes the local Scope
policy (`*` or a comma-separated list).

## Custom Exporter

```python
from tracelink import HttpExporter, tracer

off = tracer.add_exporter(HttpExporter())
off()
```

`HttpExporter` uses a bounded background queue and standard-library HTTP. Its
network failures never escape into application code. `FileExporter` writes
`.tracelink/trace.ndjson` and `.tracelink/trace.log` locally. It is enabled by
default; set `file_enabled=False` when a Receiver in the same project owns those
files, otherwise the SDK and Receiver can write duplicate rows.

## FastAPI

```python
from fastapi import FastAPI
from tracelink import TraceMiddleware

app = FastAPI()
app.add_middleware(TraceMiddleware)
```

The Extension extracts `x-trace-id`, `x-parent-span-id`, and `x-debug-scopes`,
installs request-local context, and restores the previous values after the
request. The caller's active span becomes the backend entry's parent. Middleware
does not create application spans; instrument route or service boundaries
explicitly.

## Outgoing HTTP

```python
from tracelink import create_trace_headers

requests.get(url, headers=create_trace_headers())
```

The helper is explicit and client-agnostic; TraceLink does not patch Requests,
HTTPX, or aiohttp globally.

## Context Guarantees

`ContextVar` preserves nested calls, `await`, and concurrent asyncio tasks.
Fresh OS threads do not automatically inherit context; copy or pass it
explicitly when creating a thread.

## Development

From the repository root:

```bash
npm run verify:python
```

This runs pytest, Ruff, strict mypy, builds an isolated wheel, installs it into
a temporary directory, and imports the installed artifact.
