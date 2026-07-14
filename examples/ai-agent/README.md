# Cross-Language AI Agent Example

English | [简体中文](./README.zh-CN.md)

The Node and Python examples emit nested agent/tool spans into one Receiver.
They demonstrate shared `TraceLog` fields, automatic in-process parent links,
durations, async spans, and explicit `blocked` / `intent` outcomes.

```bash
# repository root
npm run build
npx tracelink dashboard
```

In separate terminals:

```bash
node examples/ai-agent/agent.mjs
python examples/ai-agent/agent.py
```

Both examples target `http://127.0.0.1:5174/__debug_log` by default. Override it
with `TRACELINK_ENDPOINT`.

The two processes are visible in the same Dashboard because they export to the
same Receiver. Sharing a Receiver does not by itself create a parent edge across
processes; application requests must propagate the active context with
`createTraceHeaders()` or `create_trace_headers()`.
