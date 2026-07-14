# TraceLink 测试说明

[English](./testing.md) | 简体中文

本页记录当前有效的测试边界和发布门禁。历史测试文档中的 `senders/python`、
根目录 `tests/`、`HttpSink` 和 Junction 流程均已失效。

## 1. 统一验证入口

```bash
npm test                  # JavaScript SDK + Receiver
npm run verify:javascript # JS 测试、构建、npm tarball 验证
npm run test:python       # Python pytest
npm run lint:python       # Ruff + Mypy
npm run verify:python     # Python 测试、静态检查、wheel 验证
npm run verify            # JavaScript + Python 完整门禁
```

`npm test` 使用 Vitest 默认发现规则递归执行 `*.test.ts`。测试数量不是配置文件
写死的，而是所有 `it()` / `test()` 注册项之和；当前基线为 7 个文件、71 项测试。

## 2. 测试归属

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

JavaScript SDK 测试只验证语言 SDK 自己拥有的 Engine、Runtime 和 Transport。
Receiver 测试直接依赖 `protocol/types`，验证 HTTP 路由、文件持久化、Scope 策略、
日志/控制 SSE、Dashboard 资源、优雅停机和端口复用。Python 测试独立验证
ContextVar Runtime、Exporter、FastAPI Extension 和 Protocol Conformance。

## 3. 包验证

`scripts/verify-js-package.mjs` 对 `npm pack` 结果做真实消费检查，确认公开 exports、
CLI、Protocol Schema 和构建产物都进入 tarball。`scripts/verify-python-package.mjs`
构建并检查 wheel，防止 src-layout、类型标记或可选依赖在发布时遗漏。

测试源码通过并不代表发布包一定正确，因此包验证属于发布门禁，不是可选清理项。

## 4. Dashboard 发布闭环

Dashboard 在独立 `debug_board` 仓库开发。完整发布验证从该仓库执行：

```bash
cd ../debug_board
npm run verify:release
```

该命令依次运行 TraceLink 完整门禁、Dashboard 类型检查、本地 tarball 物理安装、
单文件 Dashboard 构建、嵌入仓库根目录的 `dashboard/index.html`，最后重新构建 npm 包。

## 5. Examples 不是 Tests

`examples/` 是可运行文档，用于展示真实接入和人工观察 Dashboard；它们不提供
自动断言，也不决定 CI 成败。自动回归必须落在对应 SDK 或 Receiver 的测试目录。

`.pytest_cache`、`.mypy_cache` 和 `.ruff_cache` 只保存本地增量结果，已被 Git 忽略，
可随时删除并由下一次检查重新生成。
