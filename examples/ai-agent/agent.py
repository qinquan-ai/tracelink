"""TraceLink AI-agent example — Python edition.

The Python twin of `agent.mjs`. A realistic agent loop that **instruments
itself** with TraceLink and showcases the complete wire feature set end-to-end,
POSTing into the SAME standalone receiver + dashboard the Node agent feeds:

  - a top-level `agent.run` span with nested child spans
    (plan -> search tool -> sub-agent -> summarize tool), proving auto span
    nesting via `parentSpanId` and a shared `traceId` (backed by
    `contextvars`, so nesting stays correct across `await`);
  - an async tool step, so its span-close event carries a real `durationMs`
    and `async: true`;
  - a `blocked` outcome (a guardrail / permission denial) with `data.reason`;
  - an `intent` outcome (the model wanted a tool but skipped it);
  - `level` variations (info / warn / error).

The Python SDK has an HTTP exporter, so it can POST to the shared Dashboard.
Start the Dashboard first (`npx tracelink dashboard`), then run this file.

    python examples/ai-agent/agent.py

The endpoint is overridable via `TRACELINK_ENDPOINT`
(default `http://127.0.0.1:5174/__debug_log`).
"""

from __future__ import annotations

import asyncio
import os

from tracelink import tracer

ENDPOINT = os.environ.get(
    "TRACELINK_ENDPOINT", "http://127.0.0.1:5174/__debug_log"
)

# A distinct scope keeps the Python trace easy to spot on the shared Dashboard
# alongside the Node agent's `agent-run` chain.
SCOPE = "agent-run-py"


def plan(goal: str):
    """Fake LLM planning step — a child span nested under `agent.run`."""

    def body():
        tracer.custom(
            "X-LLM", "agent.py:plan", "生成执行计划",
            {"steps": ["search", "summarize"]}, level="info",
        )
        # An intent: the model considered a pricey tool but chose not to.
        tracer.intent(
            "agent.py:plan", "本轮跳过昂贵的深度检索工具",
            reason="cost budget exceeded for deep-research tool",
            data={"tool": "deep_research", "estimatedCostUsd": 4.2},
            layer="X-LLM",
        )
        return ["search", "summarize"]

    return tracer.span("X-LLM", "agent.py:plan", f"规划目标: {goal}", body)


async def search_tool(query: str):
    """Async tool call — its close event proves durationMs + async:true."""

    async def body():
        tracer.custom(
            "X-TOOL", "agent.py:search_tool", "发起检索请求",
            {"query": query}, level="info",
        )
        await asyncio.sleep(0.12)  # simulate real network latency
        tracer.custom(
            "X-TOOL", "agent.py:search_tool", "检索返回 3 条结果",
            {"hits": 3}, level="info",
        )
        return ["doc-a", "doc-b", "doc-c"]

    return await tracer.span(
        "X-TOOL", "agent.py:search_tool", f"工具调用: search({query})", body
    )


async def sub_agent(docs):
    """A delegated sub-agent — nests further and hits a guardrail (blocked)."""

    async def body():
        # A guardrail denial: writing outside the sandbox is blocked.
        tracer.blocked(
            "agent.py:sub_agent", "拒绝写入受保护路径",
            reason="permission denied: write outside sandbox (/etc/passwd)",
            data={"path": "/etc/passwd", "op": "write"},
            layer="X-AGENT",
        )

        # A nested async tool inside the sub-agent (deeper parentSpanId chain).
        async def summarize_body():
            await asyncio.sleep(0.06)
            return f"summary of {len(docs)} docs"

        summary = await tracer.span(
            "X-TOOL", "agent.py:summarize_tool", "工具调用: summarize", summarize_body
        )

        tracer.custom(
            "X-AGENT", "agent.py:sub_agent", "子代理完成，降级为只读输出",
            {"summary": summary}, level="warn",
        )
        return summary

    return await tracer.span(
        "X-AGENT", "agent.py:sub_agent", "子代理: 汇总并尝试写盘", body
    )


async def run() -> str:
    goal = "research TraceLink and summarize"

    async def body():
        steps = plan(goal)
        tracer.custom(
            "X-AGENT", "agent.py:run", f"按计划执行 {len(steps)} 步",
            {"steps": steps}, level="info",
        )

        docs = await search_tool("TraceLink tracing features")
        summary = await sub_agent(docs)

        # Demonstrate an error-level log without aborting the run.
        tracer.custom(
            "X-AGENT", "agent.py:run", "一个非致命错误（示例）",
            {"code": "PARTIAL_RESULT"}, level="error",
        )
        return summary

    return await tracer.span(
        "X-AGENT", "agent.py:run", "agent.run 顶层任务", body, scope=SCOPE
    )


def main() -> None:
    # Force-enable so the example works regardless of DEBUG/DEV env, and open
    # all scopes so nothing is filtered out.
    tracer.set_enabled(True)
    tracer.enable_all_scopes()

    # The Receiver owns this project's trace files, so avoid a second local write.
    exporter = tracer.configure(
        enabled=True,
        http_endpoint=ENDPOINT,
        file_enabled=False,
    )

    # Advisory metadata for the custom X-* layers this agent emits on.
    tracer.register_layer("X-AGENT", {"description": "Agent control loop"})
    tracer.register_layer("X-LLM", {"description": "LLM planning / reasoning"})
    tracer.register_layer("X-TOOL", {"description": "Tool / function calls"})

    result = asyncio.run(run())
    print(f"[agent.py] done -> {result}")

    if exporter is not None:
        exporter.flush(timeout=3)


if __name__ == "__main__":
    main()
