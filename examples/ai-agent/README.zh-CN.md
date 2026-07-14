# 跨语言 AI Agent 示例

[English](./README.md) | 简体中文

Node 和 Python 示例会向同一个 Receiver 发送嵌套的 Agent/工具 span。它们展示了
共享的 `TraceLog` 字段、进程内自动父子关系、耗时、异步 span，以及显式的
`blocked` / `intent` outcome。

```bash
# 仓库根目录
npm run build
npx tracelink dashboard
```

在两个独立终端中运行：

```bash
node examples/ai-agent/agent.mjs
python examples/ai-agent/agent.py
```

两个示例默认发送到 `http://127.0.0.1:5174/__debug_log`。可通过
`TRACELINK_ENDPOINT` 修改地址。

两个进程会出现在同一个 Dashboard 中，因为它们把事件导出到同一个 Receiver。
共享 Receiver 本身不会建立跨进程父子边；业务请求必须通过
`createTraceHeaders()` 或 `create_trace_headers()` 传播当前上下文。
