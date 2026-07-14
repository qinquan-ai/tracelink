# TraceLink Protocol And SDK Conformance

This document is the normative, language-neutral contract between a language
SDK, the Receiver, and the Dashboard. `MUST`, `SHOULD`, and `MAY` use their
RFC 2119 meanings.

Authoritative machine-readable assets:

- [`schema/trace-log.schema.json`](./schema/trace-log.schema.json)
- [`schema/scope-policy.schema.json`](./schema/scope-policy.schema.json)
- [`fixtures/`](./fixtures/)

The TypeScript file `protocol/types.ts` mirrors the schema for the JavaScript
implementation; it is not the cross-language source of truth.

## 1. Roles

- **Language SDK**: builds events inside an application process. Its Engine
  owns span semantics; Runtime owns ambient context; Transport contains
  Exporters, Propagators, and the Scope control client.
- **Sender**: protocol role for anything that sends a valid event. It is not a
  separate source-code layer. A full SDK and a hand-written HTTP client are both
  senders from the Receiver's perspective.
- **Receiver**: accepts protocol data, persists and streams it, and owns the
  authoritative Scope policy. It never infers application call stacks.
- **Dashboard**: consumes Receiver APIs and renders observed runtime data.

## 2. TraceLog

Each event is one JSON object. Field names are camelCase in every language.

Required fields:

| Field | Type | Meaning |
|---|---|---|
| `ts` | string | Local display time `[HH:mm:ss.SSS]`; not a distributed clock |
| `layer` | string | Built-in `FE-*` / `BE-*`, or custom `X-*` |
| `fn` | string | Searchable function identity, conventionally `file:function` |
| `msg` | string | Short description |
| `data` | object | Sanitized JSON-compatible payload; use `{}` when empty |
| `traceId` | string | One observed execution chain across processes |
| `spanId` | string | Identity of this span/event within its producer |

Optional fields:

| Field | Type | Meaning |
|---|---|---|
| `scope` | string | Business collection range such as `checkout` |
| `level` | enum | `debug`, `info`, `warn`, or `error` |
| `outcome` | enum | `call`, `blocked`, or `intent`; missing means `call` |
| `userId` | string | Optional application user identity |
| `parentSpanId` | string | Parent determined by the producer's ambient context |
| `durationMs` | number | Span-close elapsed wall-clock milliseconds |
| `async` | boolean | Whether the traced operation settled asynchronously |

An outcome reason MUST be stored in `data.reason`; implementations MUST NOT
introduce a top-level `reason` field.

### 2.1 Sanitization

An SDK MUST bound string length, collection size, and nesting depth before data
leaves the process. Exporter failures MUST NOT escape into application code.
The reference Receiver sanitizes `data` again as a defensive boundary, but an
SDK MUST NOT rely on Receiver-side cleanup.

### 2.2 Layer normalization

The reference SDKs trim the layer, preserve `FE-*`, `BE-*`, and `X-*`, prefix
other non-empty values with `X-`, and use `FE-ACTION` only as a last-resort
empty fallback.

## 3. Span Semantics

### 3.1 Ambient context

1. Opening a span creates `{ traceId, spanId, scope?, recording }`.
2. Work inside that span MUST observe it as ambient context.
3. A nested event inherits the active `traceId` and uses the active `spanId` as
   `parentSpanId`, unless an explicit parent overrides it.
4. Closing or leaving a span MUST restore the exact previous context.
5. Concurrent tasks MUST not read one another's active span.

Implementations must use the language's native mechanism: Node
`AsyncLocalStorage`, Python `ContextVar`, Go `context.Context`, .NET
`AsyncLocal<T>`, or an equivalent coroutine/task-local facility. A runtime that
cannot guarantee ambient isolation MUST document the limitation and support
explicit IDs.

### 3.2 Open and close events

`span(fn)` emits an open event immediately, executes `fn` with the new context,
then emits a close event. Open and close share `traceId` and `spanId`; only the
close carries `durationMs` and `async`. Both carry the same `parentSpanId`.

The recording decision is fixed when a span starts. A recorded open MUST still
receive its close if Scope policy changes mid-flight. A suppressed open MUST not
emit a late close if collection becomes enabled later.

### 3.3 Why the Receiver cannot infer parents

Network arrival order is not call order. Concurrent tasks, buffering, retries,
and scheduling can reorder events. Parentage MUST be captured while the producer
still owns the execution context and serialized as `parentSpanId` or propagated
to the next process.

## 4. HTTP Context Propagation

Application-request propagation is separate from telemetry export.

| Header | Value |
|---|---|
| `x-trace-id` | active trace ID |
| `x-parent-span-id` | caller's active span ID; becomes the remote parent |
| `x-debug-scopes` | JSON string array containing the current Scope policy |

A Propagator SHOULD preserve caller-supplied headers and compare names
case-insensitively. `[]` is a meaningful Scope policy that disables all scopes;
it MUST remain distinguishable from a missing or invalid header.

Framework Extensions decide when to extract, install, and restore this context.
For example, the FastAPI Extension extracts headers at request entry, installs
request-local `ContextVar` values, and restores their tokens in `finally`.

TraceLink's reference SDKs provide explicit header helpers. They do not globally
patch every HTTP client. Automatic propagation MAY be added by a bounded,
documented framework instrumentation.

## 5. Event Export

### 5.1 Ingest request

- Method: `POST`
- Path: `/__debug_log`
- Content-Type: `application/json`
- Body: one schema-valid `TraceLog` object
- Success: `204 No Content`

An Exporter SHOULD also attach the context headers in §4. The request body is
authoritative for the event itself; headers exist for correlation/interoperation.

### 5.2 Fail-safe requirement

Export MUST be non-blocking for the traced hot path and MUST swallow network,
timeout, DNS, and response failures. A bounded queue MAY drop events when full;
it MUST NOT grow without limit or block application execution. Aggressive
automatic retries are not conformant for the default dev-time exporter.

## 6. Scope Control

The Receiver owns `{ enabled, known }`:

- `enabled`: authoritative collection policy; `['*']` means all, `[]` means none.
- `known`: persisted catalog of Scope names observed by that Receiver.

The control stream is `GET /__debug_log/scopes/stream` using SSE. It immediately
emits the current `enabled` snapshot and emits again only when policy changes.
SDKs apply the policy at the event source. On disconnect they retain the last
policy and reconnect; fixed-interval polling is not required.

## 7. Receiver API

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/__debug_log` | ingest one event |
| `GET` | `/__debug_log` | read NDJSON history |
| `DELETE` | `/__debug_log` | delete NDJSON and readable history |
| `GET` | `/__debug_log/stream` | replay and live event SSE |
| `GET` | `/__debug_log/scopes` | read `{ enabled, known }` |
| `POST` | `/__debug_log/scopes` | replace enabled policy |
| `DELETE` | `/__debug_log/scopes` | reset to `{ enabled:['*'], known:[] }` |
| `GET` | `/__debug_log/scopes/stream` | Scope policy SSE |
| `GET` | `/__debug_log/ui` | embedded Dashboard |

Every owned response carries `x-tracelink-receiver: <protocol-version>` and CORS
headers. Allowed request headers include `content-type`, `x-trace-id`,
`x-parent-span-id`, and `x-debug-scopes`.

The standalone host defaults to `127.0.0.1:5174`. The endpoint is configurable.
It MUST NOT silently select a new port because SDKs and Dashboard would diverge.

## 8. Conformance Checklist

An SDK implementation is conformant when it:

- emits schema-valid camelCase `TraceLog` objects;
- sanitizes bounded data and normalizes layers;
- maintains correct nested and concurrent ambient context;
- implements paired span open/close events;
- exports without affecting application behavior;
- injects/extracts the context headers when application propagation is used;
- applies Receiver Scope policy at the event source;
- round-trips every golden fixture without semantic loss.

## 9. Security

The reference Receiver is local development infrastructure: bind to loopback,
do not expose it publicly, and do not ship it as a production observability
backend. It intentionally has no authentication, rate limiting, or hardened
multi-tenant storage.
