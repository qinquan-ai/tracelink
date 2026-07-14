# TraceLink Testing

English | [简体中文](./testing.zh-CN.md)

This page records the current test boundaries and release gates. References in
historical test documents to `senders/python`, root-level `tests/`, `HttpSink`,
and Junction workflows are obsolete.

## 1. Verification Commands

```bash
npm test                  # JavaScript SDK + Receiver
npm run verify:javascript # JS tests, build, and npm tarball verification
npm run test:python       # Python pytest
npm run lint:python       # Ruff + Mypy
npm run verify:python     # Python tests, static checks, and wheel verification
npm run verify            # Complete JavaScript + Python gate
```

`npm test` uses Vitest's default discovery rules to execute `*.test.ts`
recursively. The test count is not hard-coded in configuration; it is the sum
of registered `it()` / `test()` cases. The current baseline is 7 files and 71
tests.

## 2. Test Ownership

```text
sdks/javascript/tests/
  engine/
    tracer.test.ts
    stack-context.test.ts
  runtime/node/
    async-context.test.ts
  transport/exporters/
    browser-http.test.ts
    node-http.test.ts
  transport/propagators/
    http.test.ts

receiver/tests/
  http-receiver.test.ts

sdks/python/tests/
  test_tracer.py
  test_exporters.py
  test_middleware.py
  test_propagators.py
  test_conformance_fixtures.py
  test_optional_import.py
```

JavaScript SDK tests cover only the Engine, Runtime, and Transport owned by the
language SDK. Receiver tests depend directly on `protocol/types` and verify HTTP
routes, file persistence, Scope policy, log/control SSE, Dashboard assets,
graceful shutdown, and port reuse. Python tests independently verify the
ContextVar Runtime, Exporters, FastAPI Extension, and Protocol Conformance.

## 3. Package Verification

`scripts/verify-js-package.mjs` consumes the real output of `npm pack` and
confirms that public exports, the CLI, Protocol Schema, and build artifacts are
present in the tarball. `scripts/verify-python-package.mjs` builds and checks a
wheel, preventing src-layout, typing markers, or optional dependencies from
being omitted during publication.

Passing source tests does not prove that the published packages are correct, so
package verification is a release gate rather than optional cleanup.

## 4. Dashboard Release Loop

The Dashboard is developed in the separate `debug_board` repository. Run the
complete release verification from that repository:

```bash
cd ../debug_board
npm run verify:release
```

The command runs the complete TraceLink gate, Dashboard type checking, physical
installation of a local tarball, the single-file Dashboard build, embedding
into `Trace_Link/dashboard/index.html`, and finally rebuilds the npm package.

## 5. Examples Are Not Tests

`examples/` contains runnable documentation for demonstrating real integration
and manually inspecting the Dashboard. Examples have no automatic assertions
and do not determine CI success. Automated regressions belong in the test
directory of the SDK or Receiver boundary they verify.

`.pytest_cache`, `.mypy_cache`, and `.ruff_cache` only contain local incremental
results. Git ignores them, and the next check can regenerate them at any time.
