# TraceLink Architecture

English | [简体中文](./architecture.zh-CN.md)

## 1. Four Product Components

```text
SDK -> Protocol -> Receiver -> Dashboard
```

| Component | Responsibility | Shared across languages |
|---|---|---|
| SDK | Understand spans, parent-child relationships, concurrent context, and capture controls inside the application process | No; each language implements its own SDK |
| Protocol | Define `TraceLog`, headers, Scope control, and Receiver APIs | Yes |
| Receiver | Ingest events, write files, stream over SSE, and persist Scope policy | Yes; implemented once |
| Dashboard | Render logs, the live call graph, the call-chain map, and the timeline | Yes; implemented once |



## 2. SDK Responsibilities

| Directory | Question it answers |
|---|---|
| `engine/` | When does a span start and end? How are IDs generated, parents inherited, and capture decisions made? |
| `runtime/` | Where is the current context stored, and how is it isolated across synchronous calls, `await`, and concurrent tasks? |
| `transport/exporters/` | Where does a completed `TraceLog` go: memory, console, file, or Receiver? |
| `transport/propagators/` | How do business HTTP headers convert to and from TraceContext? |
| `transport/control/` | How does the SDK receive Receiver-pushed Scope policy? |
| `extensions/frameworks/` | When should a framework lifecycle extract, install, and restore context, for example in FastAPI middleware? |
| `extensions/instrumentations/` | How can a specific behavior be observed automatically, for example a browser DOM click? |

A Runtime is not a Framework Extension. A Runtime provides the general context
container. An Extension knows when a framework request enters and exits, then
uses the Runtime at those boundaries.

## 3. Repository Layout

```text
protocol/
  schema/
  fixtures/
  CONFORMANCE.md
sdks/
  javascript/
    src/
      engine/
      runtime/{browser,node}/
      transport/{exporters,propagators,control}/
      extensions/{frameworks,instrumentations}/
    tests/
  python/
    src/tracelink/
      engine/
      runtime/
      transport/{exporters,propagators,control}/
      extensions/{frameworks,instrumentations}/
    tests/
receiver/
  service/
  hosts/{http,vite}/
  tests/
dashboard/
cli/
skills/
```

The JavaScript SDK, Receiver, CLI, and embedded Dashboard are still published
as one npm package. Source directories do not determine public import paths;
`package.json#exports` maps them to stable entries such as
`tracelink/browser`, `tracelink/node`, and `tracelink/receiver/http`. The Python
SDK is published separately to PyPI but follows the same Protocol.

## 4. Why the Receiver Cannot Infer Parents

The Receiver observes network arrival order, not the application's real call
stack. Async tasks, concurrent requests, buffering, and network jitter all make
"arrived first" different from "is the parent." The application process must
resolve the parent while it still owns the call context, then write it as
`parentSpanId` or propagate it to the next process through
`x-parent-span-id`.

A minimal integration for a new language only needs to construct and POST a
`TraceLog`, but that provides manual relationships only. Automatic span nesting
also requires an Engine and Runtime based on the language's concurrency context
primitive, such as Go `context.Context`, Java/Kotlin coroutine context, .NET
`AsyncLocal<T>`, or Rust task-local storage.

## 5. Platform Coverage

| Scenario | Current coverage |
|---|---|
| React / Vue / Svelte / Astro / plain web pages | Use the JavaScript browser Runtime directly |
| Node / Express / Nest / Electron main process | JavaScript Node Runtime is available; automatic framework integrations require individual Extensions |
| Python / FastAPI / Starlette | Python SDK plus FastAPI Extension |
| Electron renderer | JavaScript browser Runtime |
| Tauri frontend | JavaScript browser Runtime; the Rust backend needs a Rust SDK or a hand-written minimal Exporter |
| React Native / Capacitor / Ionic | The ability to run JavaScript is not proof of support; network and runtime behavior must be verified |
| Native Android / native iOS / Flutter / Go / Rust / Java backend | Protocol and Receiver/Dashboard are reusable; no language SDK is provided yet |
| WeChat and similar mini programs | Do not assume standard DOM, `fetch`, or package-system support; a dedicated Runtime/Exporter is required |

TraceLink must not describe "can run JavaScript" as "supported." A platform is
supported only after its runtime, network APIs, context isolation, and build
artifacts have been verified.

## 6. Test Ownership

Tests follow the boundary they verify instead of accumulating at the repository
root. JavaScript Engine, Runtime, Exporter, and Propagator tests live under
`sdks/javascript/tests/`; Receiver route, persistence, SSE, and port-lifecycle
tests live under `receiver/tests/`; Python SDK tests live under
`sdks/python/tests/`. Root scripts orchestrate cross-package release checks. See
[Testing](./testing.md).
