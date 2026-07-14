# TraceLink

[English](./README.md) | 简体中文

TraceLink 是一套用于本地开发期追踪的工具，可还原真实请求、工作流或 AI Agent 运行过程在应用中的实际调用路径。

它包含：

- JavaScript 和 Python SDK，两者生成相同的 `TraceLog` 数据契约。
- 与语言无关的协议，包括 JSON Schema 和 golden fixtures。
- 一个本地 Receiver，负责事件接收、NDJSON 持久化、SSE 推送和 Scope 控制。
- 一个内嵌 Dashboard，包括日志、PixiJS 实时调用图、SVG 调用链导图和时间线。
- 一个用于添加追踪和检查链路的 AI Agent Skill。

TraceLink 采用故障安全设计：Exporter、控制流或 Dashboard 发生故障时，不得改变应用本身的行为。

## 架构

```text
应用代码
  -> 语言 SDK
     -> Engine：span 生命周期、ID、上下文、Scope 门控、数据清洗
     -> Runtime：浏览器调用栈、Node AsyncLocalStorage、Python ContextVar
     -> Transport：Exporter、HTTP Propagator、Scope 控制客户端
     -> Extensions：FastAPI 适配器、DOM 点击埋点
  -> TraceLink Protocol
  -> Receiver
  -> Dashboard
```

TraceLink 不存在一个可供 Go、Rust、Python 和 JavaScript 共同导入执行的跨语言“Core”。每种语言的 SDK 都使用自身运行时提供的上下文机制正确实现调用上下文。跨语言复用的是 Protocol，以及唯一的 Receiver 和 Dashboard。尚未支持的语言可以先实现一个小型 HTTP Exporter；需要自动维护 span 父子关系时，再增加符合该语言习惯的上下文 Engine。

目录模型和平台覆盖情况参见[架构文档](./docs/architecture.zh-CN.md)。

## 安装软件包

```bash
npm install tracelink
pip install tracelink
pip install "tracelink[fastapi]"   # 可选的 FastAPI/Starlette 扩展
```

npm 包提供 JavaScript SDK、Receiver 和 Dashboard；PyPI 包提供 Python SDK。二者都不会把可选的 AI Agent Skill 自动安装到 Agent 的 Skill 目录。

## 安装 AI Agent Skill

使用 [Skills CLI](https://github.com/vercel-labs/skills) 单独安装仓库中的 `tracelink` Skill：

```bash
npx skills add qinquan-ai/tracelink --skill tracelink
```

CLI 会检测受支持的 AI Agent，并自动选择或提示选择安装目标。默认安装在当前项目；传入 `--global` 可让 Skill 在多个项目中使用。npm 和 pip 都不会自动把 Skill 复制到某个 Agent 专用目录。

## 启动 Dashboard

```bash
npx tracelink dashboard
npx tracelink dashboard --port 6000 --no-open
```

默认 UI 地址为 `http://127.0.0.1:5174/__debug_log/ui`。端口 `5174` 可以修改，但 TraceLink 不会静默选择其他端口：所有 SDK 和 Dashboard 必须指向同一个 Receiver。`--force` 只会重启另一个已确认属于 TraceLink 的 Receiver，绝不会终止无关进程。

## JavaScript

在 Node 中导入完整的运行时入口，以安装 `AsyncLocalStorage`：

```typescript
import { NodeHttpExporter, tracer } from "tracelink/node";

const exporter = new NodeHttpExporter({
  endpoint: "http://127.0.0.1:5174/__debug_log",
  getEnabledScopes: () => tracer.getEnabledScopes(),
});
tracer.addExporter(exporter.send.bind(exporter));

await tracer.span({
  layer: "BE-ENTRY",
  fn: "order.ts:createOrder",
  msg: "create order",
  scope: "create-order",
}, async () => {
  tracer.layer("BE-DB", "orderRepo.ts:insert", "insert order");
});
```

浏览器应用从 `tracelink/browser` 导入 `BrowserHttpExporter`。Vue、React、Svelte、Astro 和原生浏览器代码共用同一个浏览器 Runtime；进行显式追踪时不需要框架专用包。

## Python

```python
from tracelink import tracer

exporter = tracer.configure(
    http_endpoint="http://127.0.0.1:5174/__debug_log",
    scope_sync_endpoint="http://127.0.0.1:5174/__debug_log/scopes",
    file_enabled=False,
)

async def create_order():
    tracer.db("order_repo.py:insert", "insert order", scope="create-order")

await tracer.span(
    "BE-ENTRY",
    "orders.py:create_order",
    "create order",
    create_order,
    scope="create-order",
)

exporter.flush(timeout=5.0)
```

Python 使用 `contextvars.ContextVar`，因此嵌套调用、`await` 和并发 asyncio 任务都能保留正确的父节点。新建的操作系统线程仍需显式传播上下文。

## 跨服务上下文

遥测事件导出和应用请求上下文传播是两种不同操作。Exporter 把 `TraceLog` 事件发送到 Receiver；Propagator 把当前上下文写入业务 HTTP 请求：

```typescript
import { createTraceHeaders } from "tracelink";

await fetch("/api/orders", { headers: createTraceHeaders() });
```

```python
from tracelink import TraceMiddleware, create_trace_headers

app.add_middleware(TraceMiddleware)
requests.get(url, headers=create_trace_headers())
```

轻量传播请求头包括 `x-trace-id`、`x-parent-span-id` 和 `x-debug-scopes`。TraceLink 不会全局修改 `fetch` 或所有 HTTP 客户端；除非由框架 Extension 处理，否则必须显式传播上下文。

## Scope 控制

Receiver 持有权威的 Scope 启用列表。SDK 连接 Receiver 的 Scope SSE 流，立即接收当前策略，并在事件源应用后续变化。这是推送机制，不是每两秒轮询一次。

## 软件包入口

| 导入路径 | 用途 |
|---|---|
| `tracelink` | 与 Runtime 无关的 Engine API、协议辅助函数、内存 Exporter |
| `tracelink/browser` | 浏览器 Runtime、`BrowserHttpExporter`、DOM 埋点 |
| `tracelink/node` | Node Runtime、`NodeHttpExporter`、`AsyncLocalStorage` 上下文 |
| `tracelink/receiver/http` | 独立的 `node:http` Receiver |
| `tracelink/receiver/vite` | Vite 开发环境 Receiver Host |
| `tracelink/protocol/trace-log.schema.json` | 发布的软件协议 Schema |

子路径导出属于公开的软件包映射，不需要与源码目录路径完全一致。

## Trace 数据

Receiver 写入以下文件：

```text
.tracelink/trace.ndjson   # 每行一个 TraceLog JSON 对象
.tracelink/trace.log      # 便于阅读的多行文本
.tracelink/scopes.json    # 持久化的 Scope 目录和启用策略
```

💡 **多进程/跨服务调试的配置指南**：
* **什么叫“多进程”**：包括**同一个业务链路中的所有参与者**。例如“浏览器前端（JS SDK） + 后端 API（Python SDK）”，或者你开发的微服务系统中的网关、订单服务、用户服务等多个独立运行的进程。
* **单进程脚本调试**：Python 提供默认启用的本地 `FileExporter`，直接将事件写入本地 `.tracelink/`。这适合独立脚本调试，此时无需启动 Receiver 进程。
* **多进程/前后端联合调试**：你必须在 Python SDK 初始化时设置 **`file_enabled=False`** 关闭本地文件写入，并配置使用 **`HttpExporter`**。
  * *原因*：如果各个服务各自往本地写文件，不仅会与 Receiver 的写入冲突导致数据行重复，而且数据会被割裂在不同地方。**只有当所有进程的 HTTP Exporter 都指向同一个 Receiver 时，Dashboard 才能将各服务的调用链融合成同一个完整的数据源，展示出跨服务的联合调用图。**

⚠️ **多项目隔离与端口冲突提示**：
* 同一个 Receiver 实例同一时间只能管理和读取**某一个**本地工作目录（默认是当前运行路径下的 `.tracelink/`）。
* 如果你同时开发两个毫不相干的项目（例如 `项目A` 和 `项目B`），为避免它们的调用图混在一起：
  1. 你应该为它们分配不同的端口启动 Receiver。
  2. 例如：项目 A 的 Receiver 运行在 `5174` 端口（读写 `项目A/.tracelink/`），项目 B 的 Receiver 通过命令行参数运行在 `5176` 端口（读写 `项目B/.tracelink/`）。
  3. 客户端 SDK 在初始化配置时，也需要将 `http_endpoint` 改为对应项目的 Receiver 端口。


## 验证

```bash
npm run verify            # JavaScript 源码/dist/tarball + Python 测试/lint/wheel
```

完整发布验证由相邻的 Dashboard 仓库负责：

```bash
cd ../debug_board
npm run verify:release
```

## 文档

- [架构和平台覆盖](./docs/architecture.zh-CN.md)
- [详细用法](./docs/usage.zh-CN.md)
- [测试和发布门禁](./docs/testing.zh-CN.md)
- [Protocol 和 SDK 一致性（英文权威版）](./protocol/CONFORMANCE.md)
- [AI Agent Skill](./skills/tracelink/SKILL.md)
- [跨语言 AI Agent 示例](./examples/ai-agent/README.zh-CN.md)
- [Python SDK 指南](./sdks/python/README.zh-CN.md)

## 安全

Receiver 默认只监听 `127.0.0.1`，没有身份认证，仅用于本地开发。不要将它暴露到不可信网络，也不要把它作为生产环境可观测性后端发布。

## 许可证

MIT
