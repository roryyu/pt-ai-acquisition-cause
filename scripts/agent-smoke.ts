/**
 * Agent 工作流冒烟测试（独立于 Next.js 运行时）
 *
 * 验证多 Agent 编排全链路：
 * 1. 数据分析路径：supervisor 路由 → DataAnalyst ReAct（NL→SQL→图表）→ synthesizer 流式
 * 2. 研究路径：supervisor 路由 → Researcher ReAct（搜索→抓取→记录）→ critic → synthesizer
 *
 * 运行：npx tsx scripts/agent-smoke.ts [data|research|direct]
 */
process.loadEnvFile?.();

const { runAgentWorkflow } = await import("../lib/server/agents/supervisor");
import type { AgentEvent } from "../lib/server/agents/events";

const mode = process.argv[2] ?? "data";

const QUESTIONS: Record<string, string> = {
  data: "2026年各大区GMV是多少？哪个区域表现最好？顺便分析下华东区app渠道最近三个月的转化率有没有异常",
  research: "2026年中国AI眼镜市场规模和主要厂商竞争格局是怎样的？",
  direct: "什么是RFM模型？在用户运营中怎么用？",
};

async function main() {
  const question = QUESTIONS[mode];
  if (!question) {
    console.error(`未知模式: ${mode}（可选 data / research / direct）`);
    process.exit(1);
  }
  console.log(`\n════════ Agent 冒烟测试 [${mode}] ════════`);
  console.log(`问题：${question}\n`);

  const events: AgentEvent[] = [];
  const t0 = Date.now();

  const result = await runAgentWorkflow({
    questionId: `smoke_${mode}_${Date.now()}`,
    question,
    sink: (event) => {
      events.push(event);
      switch (event.type) {
        case "phase":
          console.log(`\n▶ [阶段] ${event.label}`);
          break;
        case "step":
          console.log(`  ◇ [${event.agent}] ${event.label} ${event.status === "done" ? "✓" : event.status === "error" ? "✗" : "…"}${event.detail ? ` — ${event.detail.slice(0, 100)}` : ""}`);
          break;
        case "tool_call":
          console.log(`    🔧 ${event.tool} ${JSON.stringify(event.input).slice(0, 160)}`);
          break;
        case "tool_result":
          console.log(`    ↳ ${event.summary}`);
          break;
        case "chart":
          console.log(`    📊 [图表] ${event.chart.type}「${event.chart.title}」(${event.chart.data.length} 点)`);
          break;
        case "table":
          console.log(`    📋 [表格] ${event.table.title} (${event.table.rows.length} 行)`);
          break;
        case "citations":
          break;
        case "chunk":
          break;
        case "error":
          console.log(`    ❌ ${event.message}`);
          break;
        default:
          break;
      }
    },
  });

  // 统计
  const toolCalls = events.filter((e) => e.type === "tool_call") as Array<{ tool: string }>;
  const charts = events.filter((e) => e.type === "chart") as Array<{ chart: { title: string; type: string } }>;
  const tables = events.filter((e) => e.type === "table") as Array<{ table: { title: string } }>;
  const chunks = events.filter((e) => e.type === "chunk") as Array<{ content: string }>;
  const answerLen = chunks.reduce((s, c) => s + c.content.length, 0);

  console.log(`\n──────── 结果统计 ────────`);
  console.log(`路由: ${result.route}`);
  console.log(`工具调用: ${toolCalls.length} 次 (${[...new Set(toolCalls.map((t) => t.tool))].join(", ")})`);
  console.log(`图表: ${charts.length} 张 | 表格: ${tables.length} 个 | 回答长度: ${answerLen} 字`);
  if (result.researchFindings) {
    console.log(`研究发现: ${result.researchFindings.notes.length} 条 | 引用: ${result.researchFindings.citations.length} 个`);
  }
  if (result.critique) {
    console.log(`Critic: ${result.critique.score} 分 ${result.critique.passed ? "通过" : "未通过"}`);
  }
  console.log(`总耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log(`\n──────── 最终回答（前 800 字） ────────`);
  console.log(result.finalAnswer.slice(0, 800));
  console.log(result.finalAnswer.length > 800 ? "\n...（截断）" : "");
}

main().catch((err) => {
  console.error("冒烟测试失败:", err);
  process.exit(1);
});
