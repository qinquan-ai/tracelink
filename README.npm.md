# tracelink

[简体中文文档](https://github.com/qinquan-ai/tracelink/blob/main/README.zh-CN.md)

Local dev-time tracing for real requests and application workflows. TraceLink
uses explicit instrumentation to reconstruct actual call paths. The npm package
contains the JavaScript SDK, language-neutral protocol assets, local Receiver,
CLI, and embedded Dashboard.

## Install And Run

```bash
npm install tracelink
npx tracelink dashboard
```

## Optional Coding-Assistant Skill

The npm package does not copy the repository's coding-assistant Skill into an
agent-specific directory. Install it separately with the
[Skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add qinquan-ai/tracelink --skill tracelink
```

The CLI detects supported AI agents and either selects or prompts for the
installation target. Installation is project-local by default; pass `--global`
to make the skill available across projects.

The Skill helps a coding assistant add TraceLink instrumentation and analyze
existing debug data. It does not add an AI-agent runtime or agent-specific
tracing semantics to TraceLink.

## Node

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
  scope: 'checkout',
}, async () => {
  tracer.custom('X-CACHE', 'cache.ts:get', 'read cart cache');
});
```

Importing `tracelink/node` installs `AsyncLocalStorage`, preserving span context
across `await` and concurrent async chains.

## Browser

```typescript
import { BrowserHttpExporter, tracer } from 'tracelink/browser';

const exporter = new BrowserHttpExporter();
tracer.addExporter(exporter.send.bind(exporter));
```

## Business HTTP Propagation

```typescript
import { createTraceHeaders } from 'tracelink';

fetch('/api/work', { headers: createTraceHeaders() });
```

This explicitly carries `x-trace-id`, `x-parent-span-id`, and
`x-debug-scopes`. TraceLink does not globally patch `fetch`.

## Entry Points

| Import | Exports |
|---|---|
| `tracelink` | Engine API, protocol helpers, `MemoryExporter` |
| `tracelink/browser` | Browser runtime, `BrowserHttpExporter`, DOM instrumentation |
| `tracelink/node` | Node runtime, `NodeHttpExporter`, ALS context |
| `tracelink/receiver/http` | Standalone Receiver |
| `tracelink/receiver/vite` | Vite Receiver host |
| `tracelink/protocol/trace-log.schema.json` | Wire schema |

See the [repository README](https://github.com/qinquan-ai/tracelink) for Python,
Scope control, architecture, examples, and protocol conformance.

## License

MIT
