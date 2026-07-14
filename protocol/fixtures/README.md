# Golden fixtures

Reference `TraceLog` NDJSON samples for SDK/protocol conformance (see
[`../CONFORMANCE.md`](../CONFORMANCE.md)). A conformant SDK must be able to
both **emit** events of this shape and **consume** (round-trip) these lines
without loss. Each line is exactly one JSON object; each file is valid NDJSON.

| File | What it demonstrates |
|------|----------------------|
| `plain-call.ndjson` | A single top-level event (no parent). Minimal required fields plus an optional `level`. |
| `nested-span.ndjson` | Auto span nesting: a `BE-ENTRY` parent (`spanId:"2"`) with two children (`BE-DB`, `BE-WS`) that carry `parentSpanId:"2"`, all under one `traceId` / `scope`. |
| `blocked-outcome.ndjson` | The `outcome:"blocked"` field with a human-readable `data.reason` and `level:"warn"`. Consumers without `outcome` support must treat it as a normal event. |
| `span-duration.ndjson` | A span's **open + close** pair sharing one `spanId` (`"2"`). The close event (second line) carries `durationMs` and `async:true`; the open event carries neither. |

Notes:

- Keys are camelCase on the wire in **all** languages (Python emits camelCase
  even though its call surface is snake_case).
- `ts` is local wall-clock `[HH:mm:ss.SSS]`. `spanId` identifies a span and
  `parentSpanId` carries topology; neither should be treated as a global event
  clock under concurrent execution.
- `outcome` is an optional field; its absence means `call`. The outcome reason is
  carried as `data.reason` — there is no top-level `reason` field.
- A span emits two events with the **same `spanId`** (open then close); the close
  event is the one carrying `durationMs` (+ `async`). See `../CONFORMANCE.md` §3.2.
