# TraceLink Python SDK

[English](./README.md) | 简体中文

Python SDK 构造与协议一致的 span，使用 `contextvars` 保存异步上下文，可选写入
本地文件，将事件导出到共享 TraceLink Receiver，并支持 FastAPI/Starlette 入站请求。

Python 包不包含 Receiver、Dashboard 或 CLI。请通过 npm 包运行：
`npx tracelink dashboard`。

## 安装

```bash
pip install tracelink
pip install "tracelink[fastapi]"
```

## 可选 AI Agent Skill

PyPI 包只提供 Python SDK，不会安装仓库中的 AI Agent Skill。请使用
[Skills CLI](https://github.com/vercel-labs/skills) 单独安装：

```bash
npx skills add qinquan-ai/tracelink --skill tracelink
```

CLI 会检测受支持的 AI Agent，并自动选择或提示选择安装目标。默认安装在当前项目；
传入 `--global` 可让 Skill 在多个项目中使用。

## 追踪与导出

```python
from tracelink import tracer

exporter = tracer.configure(
    enabled=True,
    http_endpoint="http://127.0.0.1:5174/__debug_log",
    scope_sync_endpoint="http://127.0.0.1:5174/__debug_log/scopes",
    file_enabled=False,
)

async def load_order():
    tracer.db("orders.py:load", "load order", scope="checkout")

await tracer.span(
    "BE-ENTRY",
    "routes.py:checkout",
    "checkout",
    load_order,
    scope="checkout",
)

exporter.flush(timeout=5.0)
```

如果没有传入 `enabled=True`，启动状态依次由 `TRACELINK_ENABLED`、`DEBUG` 和
`DEV` 环境变量决定。`TRACELINK_SCOPES` 用 `*` 或逗号分隔列表初始化本地 Scope 策略。

## 自定义 Exporter

```python
from tracelink import HttpExporter, tracer

off = tracer.add_exporter(HttpExporter())
off()
```

`HttpExporter` 使用有界后台队列和 Python 标准库 HTTP，网络失败不会逃逸到业务代码。
`FileExporter` 默认在本地写入 `.tracelink/trace.ndjson` 和
`.tracelink/trace.log`。当同一项目中的 Receiver 已负责这些文件时，应设置
`file_enabled=False`，否则 SDK 和 Receiver 可能写出重复行。

## FastAPI

```python
from fastapi import FastAPI
from tracelink import TraceMiddleware

app = FastAPI()
app.add_middleware(TraceMiddleware)
```

Extension 提取 `x-trace-id`、`x-parent-span-id` 和 `x-debug-scopes`，安装请求级
上下文，并在请求结束后恢复原值。调用方的当前 span 会成为后端入口的父节点。
Middleware 不会自动创建业务 span，仍需显式埋点路由或服务边界。

## 出站 HTTP

```python
from tracelink import create_trace_headers

requests.get(url, headers=create_trace_headers())
```

该 helper 显式且与客户端无关；TraceLink 不会全局修改 Requests、HTTPX 或 aiohttp。

## 上下文保证

`ContextVar` 能在嵌套调用、`await` 和并发 asyncio 任务中保持上下文。新建的操作系统
线程不会自动继承上下文，创建线程时需要显式复制或传递。

## 开发验证

在仓库根目录运行：

```bash
npm run verify:python
```

该命令依次执行 pytest、Ruff、严格 Mypy，构建隔离 wheel，将它安装到临时目录，
并从已安装产物执行导入验证。
