# Receiver And Dashboard

Start:

```bash
npx tracelink dashboard
npx tracelink dashboard --port 6000 --no-open
```

Default UI: `http://127.0.0.1:5174/__debug_log/ui`.

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/__debug_log` | ingest one TraceLog |
| `GET` | `/__debug_log` | NDJSON history |
| `DELETE` | `/__debug_log` | delete history files |
| `GET` | `/__debug_log/stream` | replay + live SSE |
| `GET/POST/DELETE` | `/__debug_log/scopes` | read, replace, or reset Scope state |
| `GET` | `/__debug_log/scopes/stream` | Scope policy SSE |
| `GET` | `/__debug_log/ui` | embedded Dashboard |

Files under the Receiver working directory:

```text
.tracelink/trace.ndjson
.tracelink/trace.log
.tracelink/scopes.json
```

Port behavior:

- `5174` is a default, not a mandatory identity.
- All SDKs and the Dashboard must select the same Receiver.
- Another identified TraceLink Receiver is reused unless `--force` is passed.
- A foreign process is never killed; choose another explicit port.
- The Receiver does not auto-increment ports.

The Receiver is loopback-only, unauthenticated, and intended only for local
development.

## Dashboard Semantics

- **Clear screen** affects only log-table visibility. It must not delete Receiver history or remove parent events needed by either graph.
- **Redraw** creates a graph-only cutoff at the current row and resets both graph views. It does not delete Receiver history.
- **Clear history** deletes Receiver history files (trace.ndjson and trace.log) and resets logs, the live graph, and the call-chain map.
- The **live graph** is dynamic. The **call-chain map** accumulates traces within the current graph window and merges them into a stable skeleton.
- **Stable trace ordering** uses immutable trace start time, never latest-event time.
- The **Receiver** owns events and history; the **Dashboard** owns graph layout and view-local caches.
