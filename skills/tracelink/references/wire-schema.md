# Wire Schema

The authority is `protocol/schema/trace-log.schema.json`; examples live in
`protocol/fixtures/`.

Required: `ts`, `layer`, `fn`, `msg`, `data`, `traceId`, `spanId`.

Optional: `scope`, `level`, `outcome`, `userId`, `parentSpanId`, `durationMs`,
`async`.

Rules:

- Wire keys are camelCase in every language.
- Missing `outcome` means `call`.
- A blocked/intent reason is `data.reason`, never top-level `reason`.
- Span open and close share `traceId` and `spanId`; close carries
  `durationMs` and `async`.
- Explicit `parentSpanId` wins over ambient context.
- `ts` is display time, not a distributed ordering clock.

Application HTTP propagation uses:

- `x-trace-id`
- `x-parent-span-id`
- `x-debug-scopes` as a JSON string array

An explicit empty Scope array is valid and means collect none. Missing or
malformed Scope headers mean no request-local override.
