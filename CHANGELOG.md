# Changelog

This changelog starts with TraceLink's first public release. Development-only package names and unpublished iteration history are intentionally omitted.

## 0.6.4 - 2026-07-15

- Localized the Dashboard About panel for Chinese users.
- Added a project-support entry without replacing the existing issue-feedback path.
- Routed sponsorship through the stable blog support page so provider changes do not require a TraceLink release.

## 0.6.3 - 2026-07-15

- Separated the product version from the wire-protocol generation across the SDKs and Receiver.
- Kept Receiver headers `0.4.0` and `0.5.0` as compatible aliases for protocol generation `1`.
- Removed the internal protocol generation from the Dashboard About panel and rejected incompatible Receiver reuse.
- Updated the Dashboard blog link and added GitHub-to-Gitee public release mirroring.

## 0.6.2 - 2026-07-15

First installable public release from the clean `qinquan-ai/tracelink` repository.

- Restored protocol fixture files required by fresh-clone and GitHub Actions verification.
- Hardened private-to-public allowlist synchronization and release validation.
- Added public CI for JavaScript, Python, package, and production-dependency checks.
- Aligned the Dashboard's displayed Receiver protocol version with the Receiver response header.

## Initial Public Release

### SDK And Protocol

- One JavaScript package with Engine, browser, Node, standalone HTTP Receiver, and Vite Receiver entry points.
- One Python SDK using the same `TraceLog` wire schema.
- Canonical `tracer` singleton in both JavaScript and Python.
- Scope filtering, trace/span context, nested spans, `durationMs`, `async`, `level`, and `outcome`.
- Receiver-pushed Scope SSE synchronization in JavaScript and Python, with a capture decision fixed for each Span lifecycle.
- Fail-safe custom exporters and non-blocking HTTP export.
- SDK/protocol conformance specification and golden NDJSON fixtures.
- Python request-context propagation, strict typing, lint, and isolated wheel verification.

### Receiver And Dashboard

- `tracelink dashboard` CLI for starting the local Receiver and embedded single-file Dashboard.
- NDJSON and human-readable local log files.
- SSE live streaming, Scope control, history clearing, and cooperative Receiver restart.
- Persisted Scope catalog with an independent cache reset that restores capture-all.
- Log table, PixiJS live call graph, Canvas 2D timeline, and SVG call-chain map.
- Trace filtering, time association, node dragging, layout reset, and SVG export.

### AI Agent Support

- Installable TraceLink Skill with instrumentation and diagnosis guidance.
- Explicit `blocked` and `intent` outcomes for guardrails and skipped actions.
- Cross-language AI-agent example covering Node and Python SDKs.

### Development And Release

- Receiver protocol, JavaScript tests, Python tests, and cross-language fixtures.
- Dashboard self-tracing for end-to-end dogfooding.
- Physical local npm tarball installation during Dashboard release builds.
- `debug_board` `verify:release` workflow covering tests, Python lint/type checks,
  isolated wheel installation, Dashboard type checking, and final embedded builds.
