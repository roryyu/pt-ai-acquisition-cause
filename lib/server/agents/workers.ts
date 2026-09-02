import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type { AIMessageChunk } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { getChatModel } from "@/lib/server/model-gateway";
import { listDataSources, type ResolvedDataSource } from "@/lib/server/connectors/datasources";
import {
  createRunOperatorTool, createSqlQueryTool, createInspectSchemaTool, createShowTableTool, createGenerateChartTool,
  createWebSearchTool, createFetchPageTool, createRecordFindingTool,
  createApiSourceTool, createMcpSourceTool, externalSourcesSummary,
  runtimeRunOperatorToolDescription, runtimeTablesHint,
} from "./tools";
import type { AgentRunContext } from "./events";
import { nextStepId } from "./events";
import {
  buildDataAnalystPrompt, RESEARCHER_PROMPT,
  dataAnalystExternalSourcesBlock, researchExternalSourcesBlock, critiqueFeedbackBlock,
} from "./prompts";

/**
 * Worker Agent（design.md 4.3.1 Agent 编排）
 *
 * - DataAnalystWorker：ReAct 循环优先调用数据分析算子（run_operator），
 *   算子无法表达时退回 SQL 查询/Schema 检查/表格/图表工具，
 *   将自然语言问题转化为真实的数据查询与可视化产出
 * - ResearchWorker：ReAct 循环调用 搜索/抓取/记录 工具，
 *   完成多子问题的信息收集与证据沉淀
 *
 * 两者均基于 LangGraph createReactAgent，事件经 ctx.sink 实时外送。
 */

/** 流式事件中的 AIMessageChunk 提取文本 */
function extractChunkText(chunk: unknown): string {
  const msg = chunk as AIMessageChunk;
  if (typeof msg?.content === "string") return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return typeof part.text === "string" ? part.text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

// ─── 数据分析 Worker ──────────────────────────────────────────────────────────

export async function runDataAnalystWorker(ctx: AgentRunContext): Promise<string> {
  const stepId = nextStepId(ctx);
  ctx.sink({
    type: "step", stepId, agent: "data_analyst",
    label: "数据分析 Agent 启动", status: "running",
  });

  const llm = getChatModel({ temperature: 0 });

  // 外部数据源与运行时语义模型（内置 + DB 自定义）：数据字典与算子目录全量注入
  const [externalSources, operatorDescription, tablesHint] = await Promise.all([
    loadExternalSources(),
    runtimeRunOperatorToolDescription(),
    runtimeTablesHint(),
  ]);
  const apiSources = externalSources.filter((s) => s.type === "api");

  const tools: StructuredToolInterface[] = [
    createRunOperatorTool(ctx, operatorDescription),
    createSqlQueryTool(ctx),
    createInspectSchemaTool(ctx),
    createShowTableTool(ctx),
    createGenerateChartTool(ctx),
  ];
  if (apiSources.length > 0) tools.push(createApiSourceTool(ctx, apiSources));

  const externalBlock = externalSources.length > 0
    ? dataAnalystExternalSourcesBlock(externalSourcesSummary(externalSources))
    : "";

  const agent = createReactAgent({
    llm,
    tools,
    prompt: buildDataAnalystPrompt(tablesHint) + externalBlock,
  });

  const messages: Array<{ role: "user"; content: string }> = [
    {
      role: "user",
      content: buildWorkerQuestion(ctx, "数据问题"),
    },
  ];

  let finalAnswer = "";
  try {
    const stream = await agent.streamEvents({ messages }, { version: "v2", recursionLimit: 50 });
    for await (const event of stream) {
      // 最后一轮（无工具调用的那一轮）模型输出即最终回答
      if (event.event === "on_chat_model_stream") {
        const text = extractChunkText(event.data?.chunk);
        if (text) finalAnswer += text;
      }
      // 工具调用轮次的输出会先累积，下一轮开始时重置
      if (event.event === "on_tool_start") {
        finalAnswer = "";
      }
    }
    ctx.sink({ type: "step", stepId, agent: "data_analyst", label: "数据分析完成", status: "done" });
    return finalAnswer.trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.sink({
      type: "step", stepId, agent: "data_analyst",
      label: "数据分析失败", status: "error", detail: msg,
    });
    return `数据分析执行失败：${msg}`;
  }
}

// ─── 深度研究 Worker ──────────────────────────────────────────────────────────

export async function runResearchWorker(ctx: AgentRunContext, critiqueIssues: string[] = []): Promise<string> {
  const stepId = nextStepId(ctx);
  ctx.sink({
    type: "step", stepId, agent: "researcher",
    label: critiqueIssues.length > 0 ? "深度研究 Agent 重启（补充证据）" : "深度研究 Agent 启动",
    status: "running",
  });

  // 已注册的外部数据源（api / mcp）：存在时动态扩展工具集与提示词
  const externalSources = await loadExternalSources();
  const apiSources = externalSources.filter((s) => s.type === "api");
  const mcpSources = externalSources.filter((s) => s.type === "mcp");

  const tools: StructuredToolInterface[] = [
    createWebSearchTool(ctx),
    createFetchPageTool(ctx),
    createRecordFindingTool(ctx),
  ];
  if (apiSources.length > 0) tools.push(createApiSourceTool(ctx, apiSources));
  if (mcpSources.length > 0) tools.push(createMcpSourceTool(ctx, mcpSources));

  const externalBlock = externalSources.length > 0
    ? researchExternalSourcesBlock(externalSourcesSummary(externalSources))
    : "";

  const llm = getChatModel({ temperature: 0.2 });
  const agent = createReactAgent({
    llm,
    tools,
    prompt: RESEARCHER_PROMPT + externalBlock,
  });

  const issueBlock = critiqueIssues.length > 0 ? critiqueFeedbackBlock(critiqueIssues) : "";

  let finalAnswer = "";
  try {
    const stream = await agent.streamEvents(
      { messages: [{ role: "user", content: buildWorkerQuestion(ctx, "研究问题") + issueBlock }] },
      { version: "v2", recursionLimit: 50 },
    );
    for await (const event of stream) {
      if (event.event === "on_chat_model_stream") {
        const text = extractChunkText(event.data?.chunk);
        if (text) finalAnswer += text;
      }
      if (event.event === "on_tool_start") {
        finalAnswer = "";
      }
    }
    // 兜底：模型未调用 record_finding 但已有检索证据时，
    // 将搜索摘要转正为发现（标注来源编号），保证 Critic/Synthesizer 有证据可用
    if (ctx.researchFindings.notes.length === 0 && ctx.researchFindings.searchSnippets.length > 0) {
      const salvaged = ctx.researchFindings.searchSnippets
        .filter((s) => s.snippet.length > 40)
        .slice(0, 4)
        .map((s) => `${s.snippet.slice(0, 200)}（来源 [${s.no}] ${s.title.slice(0, 40)}）`);
      if (salvaged.length > 0) {
        ctx.researchFindings.notes.push(...salvaged);
        const salvageStepId = nextStepId(ctx);
        ctx.sink({
          type: "step", stepId: salvageStepId, agent: "researcher",
          label: `自动转正 ${salvaged.length} 条搜索摘要为研究发现`, status: "done",
          detail: "模型未主动 record_finding，由系统兜底",
        });
      }
    }
    ctx.sink({ type: "step", stepId, agent: "researcher", label: "深度研究完成", status: "done" });
    return finalAnswer.trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // 递归超限等异常：仍尝试兜底转正证据，让下游有料可用
    if (ctx.researchFindings.notes.length === 0 && ctx.researchFindings.searchSnippets.length > 0) {
      const salvaged = ctx.researchFindings.searchSnippets
        .filter((s) => s.snippet.length > 40)
        .slice(0, 4)
        .map((s) => `${s.snippet.slice(0, 200)}（来源 [${s.no}] ${s.title.slice(0, 40)}）`);
      ctx.researchFindings.notes.push(...salvaged);
    }
    ctx.sink({
      type: "step", stepId, agent: "researcher",
      label: "深度研究中断（已保留部分证据）", status: "error", detail: msg,
    });
    return `研究执行中断：${msg}\n已保留 ${ctx.researchFindings.notes.length} 条搜索证据供后续综合。`;
  }
}

// ─── 辅助 ─────────────────────────────────────────────────────────────────────

/** 加载可用的自定义外部数据源（api / mcp，仅 active）；失败时降级为空列表 */
async function loadExternalSources(): Promise<ResolvedDataSource[]> {
  try {
    const sources = await listDataSources();
    return sources.filter(
      (s) => !s.builtin && s.status === "active" && (s.type === "api" || s.type === "mcp"),
    );
  } catch (error) {
    console.warn("[workers] 加载外部数据源失败，本次不启用：", error instanceof Error ? error.message : error);
    return [];
  }
}

/** 构建 Worker 输入（含历史对话，支持多轮追问） */
function buildWorkerQuestion(ctx: AgentRunContext, label: string): string {
  const historyBlock =
    ctx.history.length > 0
      ? `\n\n## 对话历史（供参考，当前问题可能依赖上文）\n${ctx.history
          .map((h) => `${h.role === "user" ? "用户" : "助手"}: ${h.content.slice(0, 500)}`)
          .join("\n")}`
      : "";
  return `${label}：${ctx.question}${historyBlock}`;
}
