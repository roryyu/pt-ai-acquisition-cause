/**
 * Agent 事件协议（SSE 流式输出的统一契约）
 *
 * 问答/研究接口通过 Server-Sent Events 逐事件推送：
 * meta → phase → step → tool_call/tool_result → table/chart → chunk → done
 */

/** 图表规格（Agent 生成 → 前端 Recharts 渲染） */
export interface ChartSpec {
  type: "bar" | "line" | "area" | "pie" | "radar" | "composed";
  title: string;
  xKey: string;
  /** 多序列图（bar/line/area）的 Y 轴字段列表 */
  yKeys: string[];
  /** 数据行（每行含 xKey + 各 yKey 字段） */
  data: Record<string, unknown>[];
  xLabel?: string;
  yLabel?: string;
  unit?: string;
  /** 数值格式化：千分位/百分比/万元 */
  valueFormat?: "number" | "percent" | "wan" | "compact";
}

/** 表格数据 */
export interface TablePayload {
  title: string;
  columns: string[];
  rows: Record<string, unknown>[];
  note?: string;
}

/** Agent 执行阶段 */
export type AgentPhase =
  | "routing"        // 意图识别与路由
  | "data_analysis"  // 数据分析 Worker
  | "research"       // 深度研究 Worker
  | "analyzing"      // 多源交叉比对（深度研究 CompareOp）
  | "critique"       // Critic 校验
  | "synthesis";     // 综合结论

export type AgentEvent =
  | { type: "meta"; questionId: string; model: string }
  | { type: "phase"; phase: AgentPhase; label: string }
  | { type: "plan"; taskId?: string; objective: string; subQuestions: Array<{ id: string; question: string; rationale: string }> }
  | { type: "step"; stepId: string; agent: string; label: string; status: "running" | "done" | "error"; detail?: string }
  | { type: "tool_call"; stepId: string; tool: string; input: unknown }
  | { type: "tool_result"; stepId: string; tool: string; summary: string; elapsedMs?: number }
  | { type: "table"; table: TablePayload }
  | { type: "chart"; chart: ChartSpec }
  | { type: "chunk"; content: string }
  | { type: "citations"; citations: Array<{ no: number; title: string; url: string }> }
  | { type: "done"; questionId: string; elapsedMs: number }
  | { type: "error"; message: string };

/** 事件出口：由 API 路由注入（SSE encoder），Agent 各节点调用 */
export type EventSink = (event: AgentEvent) => void;

/** Agent 运行上下文：贯穿整个工作流 */
export interface AgentRunContext {
  questionId: string;
  question: string;
  /** 历史对话（多轮追问） */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  sink: EventSink;
  /** 数据分析 Agent 产出（SQL/表格/图表） */
  dataFindings: {
    sql: string[];
    tables: TablePayload[];
    charts: ChartSpec[];
  };
  /** 研究 Agent 产出 */
  researchFindings: {
    notes: string[];
    citations: Array<{ no: number; title: string; url: string }>;
    searchedQueries: string[];
    /** 最近一轮搜索摘要（worker 兜底转正为发现用） */
    searchSnippets: Array<{ no: number; title: string; snippet: string }>;
    /** 已抓取的 URL（fetch 预算控制） */
    fetchedUrls: string[];
  };
  /** 意图路由结果 */
  route: "direct" | "data_analysis" | "research" | null;
  /** critic 校验结论 */
  critique: { passed: boolean; score: number; issues: string[] } | null;
  /** 步骤计数器 */
  stepCounter: number;
  startedAt: number;
}

export function createRunContext(params: {
  questionId: string;
  question: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  sink: EventSink;
}): AgentRunContext {
  return {
    questionId: params.questionId,
    question: params.question,
    history: params.history ?? [],
    sink: params.sink,
    dataFindings: { sql: [], tables: [], charts: [] },
    researchFindings: { notes: [], citations: [], searchedQueries: [], searchSnippets: [], fetchedUrls: [] },
    route: null,
    critique: null,
    stepCounter: 0,
    startedAt: Date.now(),
  };
}

/** 生成步骤 ID */
export function nextStepId(ctx: AgentRunContext): string {
  ctx.stepCounter += 1;
  return `step_${ctx.stepCounter}`;
}
