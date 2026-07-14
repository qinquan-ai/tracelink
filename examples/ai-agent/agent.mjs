/**
 * TraceLink AI-agent example — a realistic agent loop that instruments ITSELF
 * with TraceLink and showcases the complete wire feature set end-to-end:
 *
 *   - a top-level `agent.run` span with nested child spans
 *     (plan -> tool call -> sub-agent), proving auto span nesting via
 *     `parentSpanId` and a shared `traceId`;
 *   - an async tool step, so its span-close event carries a real `durationMs`
 *     and `async: true`;
 *   - a `blocked` outcome (a guardrail / permission denial) with `data.reason`;
 *   - an `intent` outcome (the model wanted to call a tool but didn't);
 *   - `level` variations (info / warn / error).
 *
 * It POSTs to the standalone receiver via NodeHttpExporter.
 * Start the Dashboard first (`npx tracelink dashboard`), then run this file.
 *
 * The `tracelink/node` import is a side-effect that installs the
 * AsyncLocalStorage-backed span context, so nesting stays correct across
 * `await` — this is what makes `parentSpanId` fill in automatically.
 */

import { NodeHttpExporter, tracer } from 'tracelink/node';

const ENDPOINT =
  process.env.TRACELINK_ENDPOINT ?? 'http://127.0.0.1:5174/__debug_log';

// Wire the Node HTTP exporter so events reach the Dashboard.
const exporter = new NodeHttpExporter({
  endpoint: ENDPOINT,
  getEnabledScopes: () => tracer.getEnabledScopes(),
});
tracer.addExporter(exporter.send.bind(exporter));

// Advisory metadata for the custom layers this agent emits on (X-* channels).
tracer.registerLayer('X-AGENT', { description: 'Agent control loop' });
tracer.registerLayer('X-LLM', { description: 'LLM planning / reasoning' });
tracer.registerLayer('X-TOOL', { description: 'Tool / function calls' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake LLM planning step — a child span nested under `agent.run`. */
function plan(goal) {
  return tracer.span(
    { layer: 'X-LLM', fn: 'agent.mjs:plan', msg: `规划目标: ${goal}` },
    () => {
      tracer.log({
        layer: 'X-LLM',
        fn: 'agent.mjs:plan',
        msg: '生成执行计划',
        level: 'info',
        data: { steps: ['search', 'summarize'] },
      });
      // An intent: the model considered calling a pricey tool but chose not to.
      tracer.intent('agent.mjs:plan', '本轮跳过昂贵的深度检索工具', {
        reason: 'cost budget exceeded for deep-research tool',
        data: { tool: 'deep_research', estimatedCostUsd: 4.2 },
      });
      return ['search', 'summarize'];
    },
  );
}

/** Async tool call — its close event proves durationMs + async:true. */
function searchTool(query) {
  return tracer.span(
    { layer: 'X-TOOL', fn: 'agent.mjs:searchTool', msg: `工具调用: search(${query})` },
    async () => {
      tracer.log({
        layer: 'X-TOOL',
        fn: 'agent.mjs:searchTool',
        msg: '发起检索请求',
        level: 'info',
        data: { query },
      });
      await sleep(120); // simulate real network latency
      tracer.log({
        layer: 'X-TOOL',
        fn: 'agent.mjs:searchTool',
        msg: '检索返回 3 条结果',
        level: 'info',
        data: { hits: 3 },
      });
      return ['doc-a', 'doc-b', 'doc-c'];
    },
  );
}

/** A delegated sub-agent — nests further and hits a guardrail (blocked). */
function subAgent(docs) {
  return tracer.span(
    { layer: 'X-AGENT', fn: 'agent.mjs:subAgent', msg: '子代理: 汇总并尝试写盘' },
    async () => {
      // A guardrail denial: writing outside the sandbox is blocked.
      tracer.blocked('agent.mjs:subAgent', '拒绝写入受保护路径', {
        reason: 'permission denied: write outside sandbox (/etc/passwd)',
        layer: 'X-AGENT',
        data: { path: '/etc/passwd', op: 'write' },
      });

      // A nested async tool inside the sub-agent (deeper parentSpanId chain).
      const summary = await tracer.span(
        { layer: 'X-TOOL', fn: 'agent.mjs:summarizeTool', msg: '工具调用: summarize' },
        async () => {
          await sleep(60);
          return `summary of ${docs.length} docs`;
        },
      );

      tracer.log({
        layer: 'X-AGENT',
        fn: 'agent.mjs:subAgent',
        msg: '子代理完成，降级为只读输出',
        level: 'warn',
        data: { summary },
      });
      return summary;
    },
  );
}

async function main() {
  const goal = 'research TraceLink and summarize';

  const result = await tracer.span(
    { layer: 'X-AGENT', fn: 'agent.mjs:run', msg: 'agent.run 顶层任务', scope: 'agent-run' },
    async () => {
      const steps = plan(goal);
      tracer.log({
        layer: 'X-AGENT',
        fn: 'agent.mjs:run',
        msg: `按计划执行 ${steps.length} 步`,
        level: 'info',
        data: { steps },
      });

      const docs = await searchTool('TraceLink tracing features');
      const summary = await subAgent(docs);

      // Demonstrate an error-level log without aborting the run.
      tracer.log({
        layer: 'X-AGENT',
        fn: 'agent.mjs:run',
        msg: '一个非致命错误（示例）',
        level: 'error',
        data: { code: 'PARTIAL_RESULT' },
      });

      return summary;
    },
  );

  console.log(`[agent] done -> ${result}`);
  // Give fire-and-forget requests a moment to settle before process exit.
  await sleep(400);
}

main().catch((err) => {
  console.error('[agent] fatal', err);
  process.exit(1);
});
