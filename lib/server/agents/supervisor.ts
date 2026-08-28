import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { chatCompletion, chatCompletionStream, getDefaultModel } from "@/lib/server/model-gateway";
import type { AgentEvent, AgentRunContext } from "./events";
import { createRunContext, nextStepId } from "./events";
import { runDataAnalystWorker, runResearchWorker } from "./workers";
import { ROUTING_PROMPT, DIRECT_ANSWER_PROMPT, CRITIC_PROMPT, SYNTHESIZER_PROMPT } from "./prompts";

/**
 * Supervisor 多 Agent 编排（design.md 4.3.1 / 7.2）
 *
 * LangGraph StateGraph 拓扑：
 *
 *   START → supervisor（意图路由）
 *     ├─ direct        → direct_answer ──────────────────────→ END
 *     ├─ data_analysis → data_analyst → synthesizer ─────────→ END
 *     └─ research      → researcher → critic
 *                          ├─ 通过   → synthesizer ─────────→ END
 *                          └─ 需修正 → researcher（重试≤1）→ critic → ...
 *
 * - supervisor：LLM 意图分类（问答 / 数据分析 / 深度研究）
 * - critic：校验研究产出（信源充分性 / 问题覆盖度 / 逻辑一致性），不达标重研究一次
 * - synthesizer：汇聚数据发现 + 研究证据 + 历史，流式生成最终结构化回答
 *
 * 全程事件经 ctx.sink 推送（phase / step / tool / table / chart / chunk）。
 */

// ─── 图状态 ───────────────────────────────────────────────────────────────────

const WorkflowState = Annotation.Root({
  /** 运行上下文（引用，贯穿全图） */
  ctx: Annotation<AgentRunContext>,
  /** 路由决策 */
  route: Annotation<"direct" | "data_analysis" | "research">({
    reducer: (_, b) => b,
    default: () => "direct",
  }),
  /** 数据分析 Worker 总结 */
  dataSummary: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  /** 研究 Worker 总结 */
  researchSummary: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  /** critic 重试计数 */
  researchAttempts: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  /** critic 结论 */
  critique: Annotation<{ passed: boolean; score: number; issues: string[] } | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
  /** 最终答案（增量累积） */
  finalAnswer: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
});

type WorkflowStateType = typeof WorkflowState.State;

// ─── 节点实现 ─────────────────────────────────────────────────────────────────

/** Supervisor：意图路由（design.md 4.3.1 Supervisor 职责） */
async function supervisorNode(state: WorkflowStateType): Promise<Partial<WorkflowStateType>> {
  const ctx = state.ctx;
  const stepId = nextStepId(ctx);
  ctx.sink({ type: "phase", phase: "routing", label: "意图识别与任务路由" });
  ctx.sink({ type: "step", stepId, agent: "supervisor", label: "分析问题意图", status: "running" });

  let route: "direct" | "data_analysis" | "research" = "direct";
  let reason = "";
  try {
    const raw = await chatCompletion(
      [
        { role: "system", content: ROUTING_PROMPT },
        ...ctx.history.slice(-4).map((h) => ({ role: h.role, content: h.content.slice(0, 300) })),
        { role: "user", content: ctx.question },
      ],
      { temperature: 0, maxTokens: 200 },
    );
    const parsed = extractJson(raw);
    if (parsed && typeof parsed.route === "string" && ["direct", "data_analysis", "research"].includes(parsed.route)) {
      route = parsed.route as typeof route;
      reason = typeof parsed.reason === "string" ? parsed.reason : "";
    }
  } catch (error) {
    console.warn("[supervisor] 路由失败，默认 direct:", error instanceof Error ? error.message : error);
  }

  ctx.route = route;
  ctx.sink({
    type: "step", stepId, agent: "supervisor",
    label: `路由决策：${routeLabel(route)}`, status: "done", detail: reason,
  });
  return { route };
}

function routeLabel(route: string): string {
  if (route === "data_analysis") return "数据分析";
  if (route === "research") return "深度研究";
  return "直接回答";
}

/** 条件边：supervisor → 下游节点 */
function routeFromSupervisor(state: WorkflowStateType): string {
  return state.route;
}

/** 直接回答节点（流式） */
async function directAnswerNode(state: WorkflowStateType): Promise<Partial<WorkflowStateType>> {
  const ctx = state.ctx;
  const stepId = nextStepId(ctx);
  ctx.sink({ type: "step", stepId, agent: "assistant", label: "生成回答", status: "running" });

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: DIRECT_ANSWER_PROMPT },
    ...ctx.history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: ctx.question },
  ];

  let answer = "";
  try {
    for await (const chunk of chatCompletionStream(messages, { temperature: 0.5 })) {
      answer += chunk;
      ctx.sink({ type: "chunk", content: chunk });
    }
    ctx.sink({ type: "step", stepId, agent: "assistant", label: "回答完成", status: "done" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.sink({ type: "step", stepId, agent: "assistant", label: "回答失败", status: "error", detail: msg });
    throw error;
  }
  return { finalAnswer: answer };
}

/** 数据分析节点 */
async function dataAnalystNode(state: WorkflowStateType): Promise<Partial<WorkflowStateType>> {
  const ctx = state.ctx;
  ctx.sink({ type: "phase", phase: "data_analysis", label: "数据分析（NL2SQL + 可视化）" });
  const summary = await runDataAnalystWorker(ctx);
  return { dataSummary: summary };
}

/** 深度研究节点 */
async function researcherNode(state: WorkflowStateType): Promise<Partial<WorkflowStateType>> {
  const ctx = state.ctx;
  ctx.sink({ type: "phase", phase: "research", label: "深度研究（检索 + 证据收集）" });
  const isRetry = state.researchAttempts > 0;
  if (isRetry) {
    const retryStepId = nextStepId(ctx);
    ctx.sink({
      type: "step", stepId: retryStepId, agent: "supervisor",
      label: "Critic 要求补充研究，重启研究 Agent", status: "running",
      detail: state.critique?.issues.join("；"),
    });
    ctx.sink({ type: "step", stepId: retryStepId, agent: "supervisor", label: "研究重启完成", status: "done" });
  }
  const summary = await runResearchWorker(ctx, isRetry ? state.critique?.issues ?? [] : []);
  return { researchSummary: summary, researchAttempts: state.researchAttempts + 1 };
}

/** Critic 节点：校验研究产出质量（design.md 4.3.1 Critic 职责） */
async function criticNode(state: WorkflowStateType): Promise<Partial<WorkflowStateType>> {
  const ctx = state.ctx;
  ctx.sink({ type: "phase", phase: "critique", label: "Critic 质量校验" });
  const stepId = nextStepId(ctx);
  ctx.sink({ type: "step", stepId, agent: "critic", label: "校验研究产出", status: "running" });

  const { notes, citations, searchedQueries } = ctx.researchFindings;

  // 快速硬校验：证据过少直接不通过
  const hasEnoughEvidence = notes.length >= 2 && citations.length >= 1;
  let passed = hasEnoughEvidence;
  let score = hasEnoughEvidence ? 7 : 3;
  let issues: string[] = [];

  if (!hasEnoughEvidence) {
    issues.push(`证据不足：仅 ${notes.length} 条发现 / ${citations.length} 个信源（要求 ≥2 条发现且 ≥1 个信源）`);
  } else {
    // LLM 软校验：覆盖度与一致性
    try {
      const raw = await chatCompletion(
        [
          {
            role: "system",
            content: CRITIC_PROMPT,
          },
          {
            role: "user",
            content: `研究问题：${ctx.question}\n\n执行过的检索：${searchedQueries.join("；")}\n\n研究发现：\n${notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n引用来源：${citations.map((c) => `[${c.no}] ${c.title}`).join("；")}`,
          },
        ],
        { temperature: 0, maxTokens: 400 },
      );
      const parsed = extractJson(raw);
      if (parsed && typeof parsed.score === "number") {
        score = parsed.score;
        passed = typeof parsed.passed === "boolean" ? parsed.passed : score >= 6;
        if (Array.isArray(parsed.issues)) {
          issues = parsed.issues.filter((i: unknown): i is string => typeof i === "string");
        }
      }
    } catch (error) {
      console.warn("[critic] LLM 校验失败，采用硬校验结果:", error instanceof Error ? error.message : error);
    }
  }

  ctx.critique = { passed, score, issues };
  ctx.sink({
    type: "step", stepId, agent: "critic",
    label: passed ? `校验通过（${score} 分）` : `校验未通过（${score} 分）`,
    status: "done",
    detail: issues.length > 0 ? issues.join("；") : undefined,
  });
  return { critique: { passed, score, issues } };
}

/** 条件边：critic → synthesizer | researcher（重试，首次失败后补研究一次） */
function critiqueDecision(state: WorkflowStateType): string {
  if (state.critique?.passed) return "synthesizer";
  // researchAttempts：第 1 轮研究后为 1；允许失败后补研究一次（第 2 轮后为 2，不再重试）
  if (state.researchAttempts < 2) return "researcher";
  return "synthesizer"; // 重试后仍不通过，带问题进入综合
}

/** 综合节点：汇聚全部产出，流式生成最终回答（design.md 7.2） */
async function synthesizerNode(state: WorkflowStateType): Promise<Partial<WorkflowStateType>> {
  const ctx = state.ctx;
  ctx.sink({ type: "phase", phase: "synthesis", label: "综合结论生成" });
  const stepId = nextStepId(ctx);
  ctx.sink({ type: "step", stepId, agent: "synthesizer", label: "汇总发现，生成结论", status: "running" });

  const sections: string[] = [];
  if (state.dataSummary) {
    sections.push(`## 数据分析 Agent 产出\n${state.dataSummary}`);
  }
  // 原始查询数据（防止转述失真：数值必须以这里为准）
  if (ctx.dataFindings.tables.length > 0) {
    const tableBlocks = ctx.dataFindings.tables.slice(0, 6).map((t, ti) => {
      const header = t.columns.join(" | ");
      const rows = t.rows.slice(0, 15).map((r) => t.columns.map((c) => String(r[c] ?? "")).join(" | "));
      return `表${ti + 1}「${t.title}」${t.note ? `（${t.note}）` : ""}\n${header}\n${rows.join("\n")}`;
    });
    sections.push(`## 数据分析原始查询结果（数值以此为准，与上文冲突时以本表为准）\n${tableBlocks.join("\n\n")}`);
  }
  if (ctx.dataFindings.sql.length > 0) {
    sections.push(`### 执行过的 SQL\n${ctx.dataFindings.sql.map((s, i) => `${i + 1}. \`${s.replace(/\s+/g, " ")}\``).join("\n")}`);
  }
  if (ctx.dataFindings.charts.length > 0) {
    sections.push(`### 已生成图表\n${ctx.dataFindings.charts.map((c) => `- ${c.title}（${c.type}）`).join("\n")}`);
  }
  if (state.researchSummary || ctx.researchFindings.notes.length > 0) {
    sections.push(`## 深度研究 Agent 产出\n${state.researchSummary || ""}\n\n### 研究发现证据池\n${ctx.researchFindings.notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}`);
  }
  if (ctx.researchFindings.citations.length > 0) {
    sections.push(`### 引用来源\n${ctx.researchFindings.citations.map((c) => `[${c.no}] ${c.title} — ${c.url}`).join("\n")}`);
  }
  if (state.critique) {
    sections.push(`### Critic 校验\n评分 ${state.critique.score}/10；${state.critique.passed ? "通过" : `未通过：${state.critique.issues.join("；")}`}`);
  }

  const userContent = `用户问题：${ctx.question}

${ctx.history.length > 0 ? `对话历史摘要：${ctx.history.slice(-3).map((h) => `${h.role === "user" ? "用户" : "助手"}: ${h.content.slice(0, 200)}`).join(" / ")}\n\n` : ""}---
${sections.join("\n\n")}`;

  let answer = "";
  try {
    for await (const chunk of chatCompletionStream(
      [
        { role: "system", content: SYNTHESIZER_PROMPT },
        { role: "user", content: userContent },
      ],
      { temperature: 0.3, maxTokens: 4096 },
    )) {
      answer += chunk;
      ctx.sink({ type: "chunk", content: chunk });
    }
    ctx.sink({ type: "step", stepId, agent: "synthesizer", label: "结论生成完成", status: "done" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.sink({ type: "step", stepId, agent: "synthesizer", label: "结论生成失败", status: "error", detail: msg });
    throw error;
  }
  return { finalAnswer: answer };
}

// ─── 图构建 ───────────────────────────────────────────────────────────────────

function buildWorkflow() {
  return new StateGraph(WorkflowState)
    .addNode("supervisor", supervisorNode)
    .addNode("direct_answer", directAnswerNode)
    .addNode("data_analyst", dataAnalystNode)
    .addNode("researcher", researcherNode)
    .addNode("critic", criticNode)
    .addNode("synthesizer", synthesizerNode)
    .addEdge(START, "supervisor")
    .addConditionalEdges("supervisor", routeFromSupervisor, {
      direct: "direct_answer",
      data_analysis: "data_analyst",
      research: "researcher",
    })
    .addEdge("direct_answer", END)
    .addEdge("data_analyst", "synthesizer")
    .addEdge("researcher", "critic")
    .addConditionalEdges("critic", critiqueDecision, {
      synthesizer: "synthesizer",
      researcher: "researcher",
    })
    .addEdge("synthesizer", END)
    .compile();
}

let compiled: ReturnType<typeof buildWorkflow> | null = null;
function getWorkflow() {
  if (!compiled) compiled = buildWorkflow();
  return compiled;
}

// ─── 对外入口 ─────────────────────────────────────────────────────────────────

export interface RunWorkflowOptions {
  questionId: string;
  question: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  sink: (event: AgentEvent) => void;
}

export interface WorkflowResult {
  route: "direct" | "data_analysis" | "research";
  finalAnswer: string;
  dataFindings: AgentRunContext["dataFindings"];
  researchFindings: AgentRunContext["researchFindings"];
  critique: AgentRunContext["critique"];
  elapsedMs: number;
}

/**
 * 运行完整多 Agent 工作流
 * 事件实时经 sink 推送；返回结构化结果供持久化。
 */
export async function runAgentWorkflow(options: RunWorkflowOptions): Promise<WorkflowResult> {
  const ctx = createRunContext({
    questionId: options.questionId,
    question: options.question,
    history: options.history,
    sink: options.sink,
  });

  ctx.sink({ type: "meta", questionId: options.questionId, model: getDefaultModel() });

  const workflow = getWorkflow();
  const finalState = await workflow.invoke(
    {
      ctx,
      route: "direct",
      dataSummary: "",
      researchSummary: "",
      researchAttempts: 0,
      critique: null,
      finalAnswer: "",
    },
    { recursionLimit: 60 },
  );

  const elapsedMs = Date.now() - ctx.startedAt;
  return {
    route: finalState.route,
    finalAnswer: finalState.finalAnswer,
    dataFindings: ctx.dataFindings,
    researchFindings: ctx.researchFindings,
    critique: ctx.critique,
    elapsedMs,
  };
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/** 从模型输出中提取 JSON（容忍 markdown 代码块包裹） */
function extractJson(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  // 直接尝试
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 尝试提取 ```json ... ``` 或 { ... }
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim()) as Record<string, unknown>;
      } catch {
        // 继续
      }
    }
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}
