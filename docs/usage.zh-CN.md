# TraceLink 使用说明

[English](./usage.md) | 简体中文

本页只说明如何接入。职责与目录见[架构](./architecture.zh-CN.md)，线协议见
[Protocol（英文权威版）](../protocol/CONFORMANCE.md)。

## 1. 启动 Receiver 与 Dashboard

```bash
npx tracelink dashboard
npx tracelink dashboard --port 6000 --no-open
```

默认入口是 `http://127.0.0.1:5174/__debug_log/ui`。`5174` 只是默认值，
不是固定身份；修改端口后，所有 Exporter 与 Dashboard 必须指向同一个 Receiver。
TraceLink 不会自动向后寻找空闲端口，避免产生两套互不相通的数据源。

Vite 项目也可以把 Receiver 挂在开发服务器：

```typescript
import { defineConfig } from 'vite';
import { debugLogPlugin } from 'tracelink/receiver/vite';

export default defineConfig({ plugins: [debugLogPlugin()] });
```

## 2. JavaScript SDK

### 2.1 Node

从 `tracelink/node` 导入完整 Runtime Profile。该入口会安装
`AsyncLocalStorage`，使并发异步链的上下文互不串线。

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
  scope: 'create-order',
}, async () => {
  tracer.layer('BE-DB', 'orderRepo.ts:insert', 'insert order');
});
```

### 2.2 Browser

```typescript
import { BrowserHttpExporter, tracer } from 'tracelink/browser';

const exporter = new BrowserHttpExporter({
  endpoint: '/__debug_log',
  getEnabledScopes: () => tracer.getEnabledScopes(),
});
tracer.addExporter(exporter.send.bind(exporter));
```

浏览器默认 `StackContextProvider` 支持同步嵌套和单条异步链，但不能保证同一
页面内任意并发 Promise 链的上下文隔离。Node 使用 ALS；浏览器需要未来的
Async Context 标准或框架级 Extension 才能提供同等级保证。

### 2.3 span 与普通事件

```typescript
tracer.log({
  layer: 'FE-ACTION',
  fn: 'CheckoutButton:onClick',
  msg: 'checkout clicked',
  scope: 'checkout',
  data: { cartSize: 3 },
});

await tracer.span({
  layer: 'FE-API',
  fn: 'checkoutApi:create',
  msg: 'POST /orders',
  scope: 'checkout',
}, submitOrder);
```

`span()` 立即发出 open 事件，函数结束后用相同 `spanId` 发出 close 事件；
close 带 `durationMs` 与 `async`。内部事件自动继承 `traceId` 并把当前 span
写入 `parentSpanId`。

## 3. Python SDK

```bash
pip install tracelink
pip install "tracelink[fastapi]"
```

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

`configure(http_endpoint=...)` 返回后台 `HttpExporter`。它的 `send()` 只入队，
网络失败和队列满都会失败无害；短命脚本退出前才需要主动 `flush()`。

也可以注册自定义 Exporter：

```python
from tracelink import HttpExporter, tracer

off = tracer.add_exporter(HttpExporter())
off()
```

### Exporter 运行模式

Python SDK 支持两种输出方式：

- **离线文件输出（默认开启）：** `FileExporter` 写入
  `.tracelink/trace.ndjson` 和 `.tracelink/trace.log`。从同一个项目根目录
  启动 Receiver 后，它可以读取 `trace.ndjson` 并向 Dashboard 回放历史事件。
- **实时 HTTP 输出：** `HttpExporter` 将事件发送给运行中的 Receiver，适用于
  前后端联调和多服务开发。

当同一项目中的 Receiver 已负责 `.tracelink/` 时，必须设置
`file_enabled=False`，否则 Python SDK 和 Receiver 可能把相同事件追加到同一
文件并产生重复行。


## 4. 跨服务传播

Exporter 把观测事件发给 Receiver；Propagator 把业务请求的调用上下文发给
下一个服务。这两件事不能混为一谈。

JavaScript 发业务请求：

```typescript
import { createTraceHeaders } from 'tracelink';

await fetch('/api/orders', {
  method: 'POST',
  headers: createTraceHeaders({ headers: { 'Content-Type': 'application/json' } }),
});
```

Python 发业务请求：

```python
from tracelink import create_trace_headers

requests.get(url, headers=create_trace_headers())
```

FastAPI 接收：

```python
from fastapi import FastAPI
from tracelink import TraceMiddleware

app = FastAPI()
app.add_middleware(TraceMiddleware)
```

Header 含义：

| Header | 含义 |
|---|---|
| `x-trace-id` | 跨进程共享的一条 trace |
| `x-parent-span-id` | 调用方当前 span，成为被调用服务首个事件的父节点 |
| `x-debug-scopes` | 当前采集 Scope 策略的 JSON 数组 |

TraceLink 不全局改写 `fetch`、Axios、Requests 或任意框架客户端。显式 helper
可搜索、可关闭，也不会改变第三方请求行为。未来的框架 Extension 可以在明确
边界内自动调用同一个 Propagator。

## 5. Scope 采集控制

JavaScript：

```typescript
tracer.configure({
  scopeSync: { endpoint: 'http://127.0.0.1:5174/__debug_log/scopes' },
});
```

Python：

```python
tracer.configure(
    scope_sync_endpoint="http://127.0.0.1:5174/__debug_log/scopes",
)
```

SDK 连接 `/scopes/stream` SSE。连接后立即收到当前策略，后续只在策略变化时
接收推送；断线保留最后策略并重连，不依赖固定轮询。

## 6. Dashboard 视图与数据操作

| 操作 | 准确语义 |
|---|---|
| 清屏 / Clear screen | 只设置日志表的视图切点，不删除 Dashboard 内存日志、不删除 Receiver 历史，也不重置调用图 |
| 重新绘图 / Redraw | 从当前时刻建立独立的图数据切点，同时重置实时调用图和链路导图；不删除 Receiver 历史 |
| 清除历史 / Clear history | 调用 DELETE `/__debug_log`，删除 Receiver 历史文件，并清空 Dashboard 日志和两种图缓存 |
| 自适应视口 | 只调整画布相机 |
| 恢复默认布局 | 只清除链路导图的手动拖动位置 |
| 导出 SVG | 导出当前链路导图布局和显示状态 |

### 调用图说明
- **实时调用图**：根据当前图窗口持续更新节点、边、热度和时间轴。
- **链路导图**：在当前图窗口内累计事件，按调用路径合并多条 trace 形成骨架。trace 使用不可变的起始时间排序；新事件不得因为“最后事件时间”变化而改变已有 trace 的纵向顺序。

> ℹ️ **说明**：Receiver 只负责接收、保存和推送事件，不参与图的布局维护。所有的图布局和累计缓存均由 Dashboard 本身在前端完成。

## 7. Layer、Scope 与 Outcome

- `layer` 表示技术位置：`FE-ACTION`、`FE-API`、`BE-ENTRY`、`BE-DB` 等。
- `scope` 表示业务范围：`checkout`、`delete-work`、`agent-run`。
- `outcome` 表示结果：缺省等价于 `call`，也可为 `blocked` 或 `intent`。
- `blocked` / `intent` 的原因放在 `data.reason`，不增加顶层 `reason`。
- 自定义 layer 使用 `X-*`，例如 `X-AI-INFERENCE`。

## 8. 新语言最小接入

最小版本只需：

1. 按 JSON Schema 构造 `TraceLog`。
2. 把单个 JSON 对象 POST 到 `/__debug_log`。
3. 配置短超时，失败时不影响业务。

这能显示日志与手动关系，但不会自动理解并发调用栈。完整 SDK 还需要该语言的
Engine/Runtime，用原生上下文能力维护 `traceId`、`spanId` 和 `parentSpanId`。
不要在 Receiver 根据到达顺序猜父子关系。

## 9. 生产环境

TraceLink 是本地开发工具。生产构建应关闭 SDK 采集，不部署 Receiver，不把
`127.0.0.1` Receiver 暴露到不可信网络。自定义 Exporter 如需发往远端，鉴权、
隐私、限流和可靠性由使用方负责。
