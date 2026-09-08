/**
 * Agent 事件协议（客户端侧）
 * 与 lib/server/agents/events.ts 保持同构（纯类型，无服务端依赖）
 */

export type ChartSpec = {
  type: "bar" | "line" | "area" | "pie" | "radar" | "composed";
  title: string;
  xKey: string;
  yKeys: string[];
  data: Record<string, unknown>[];
  xLabel?: string;
  yLabel?: string;
  unit?: string;
  valueFormat?: "number" | "percent" | "wan" | "compact";
};

export type TablePayload = {
  title: string;
  columns: string[];
  rows: Record<string, unknown>[];
  note?: string;
};

export type Citation = { no: number; title: string; url: string };

export type AgentPhase = "routing" | "data_analysis" | "research" | "analyzing" | "critique" | "synthesis";

export type AgentEvent =
  | { type: "meta"; questionId: string; model: string }
  | { type: "phase"; phase: AgentPhase; label: string }
  | {
      type: "plan";
      taskId?: string;
      objective: string;
      subQuestions: Array<{ id: string; question: string; rationale: string }>;
    }
  | { type: "step"; stepId: string; agent: string; label: string; status: "running" | "done" | "error"; detail?: string }
  | { type: "tool_call"; stepId: string; tool: string; input: unknown }
  | { type: "tool_result"; stepId: string; tool: string; summary: string; elapsedMs?: number }
  | { type: "table"; table: TablePayload }
  | { type: "chart"; chart: ChartSpec }
  | { type: "chunk"; content: string }
  | { type: "citations"; citations: Citation[] }
  | { type: "done"; questionId: string; elapsedMs: number }
  | { type: "error"; message: string };

/** Agent 时间线节点（由事件流折叠而成） */
export interface TimelineStep {
  stepId: string;
  agent: string;
  label: string;
  status: "running" | "done" | "error";
  detail?: string;
  /** 关联的工具调用 */
  tools: Array<{ id: string; tool: string; input: unknown; summary?: string; elapsedMs?: number }>;
}

/** Agent 事件流的客户端聚合状态 */
export interface AgentStreamState {
  questionId: string | null;
  phases: Array<{ phase: AgentPhase; label: string }>;
  steps: TimelineStep[];
  charts: ChartSpec[];
  tables: TablePayload[];
  citations: Citation[];
  answer: string;
  plan: { objective: string; subQuestions: Array<{ id: string; question: string; rationale: string }> } | null;
  done: boolean;
  error: string | null;
  elapsedMs: number | null;
}

export function emptyStreamState(): AgentStreamState {
  return {
    questionId: null,
    phases: [],
    steps: [],
    charts: [],
    tables: [],
    citations: [],
    answer: "",
    plan: null,
    done: false,
    error: null,
    elapsedMs: null,
  };
}

/** 将一个事件应用到聚合状态（不可变更新） */
export function applyAgentEvent(state: AgentStreamState, event: AgentEvent): AgentStreamState {
  switch (event.type) {
    case "meta":
      return { ...state, questionId: event.questionId };
    case "phase":
      return { ...state, phases: [...state.phases, { phase: event.phase, label: event.label }] };
    case "plan":
      return { ...state, plan: { objective: event.objective, subQuestions: event.subQuestions } };
    case "step": {
      const existing = state.steps.findIndex((s) => s.stepId === event.stepId);
      if (existing >= 0) {
        const steps = [...state.steps];
        steps[existing] = { ...steps[existing]!, label: event.label, status: event.status, detail: event.detail ?? steps[existing]!.detail };
        return { ...state, steps };
      }
      return {
        ...state,
        steps: [...state.steps, { stepId: event.stepId, agent: event.agent, label: event.label, status: event.status, detail: event.detail, tools: [] }],
      };
    }
    case "tool_call": {
      const steps = [...state.steps];
      // tool_call 的 stepId 未必对应已存在的 step（Agent 工具自带独立 stepId）
      const idx = steps.findIndex((s) => s.stepId === event.stepId);
      if (idx >= 0) {
        steps[idx] = {
          ...steps[idx]!,
          tools: [
            ...steps[idx]!.tools,
            // 注入稳定 id（stepId + 追加位置 + 工具名）：供 React 列表 key 使用，避免 index-as-key
            { id: `${event.stepId}#${steps[idx]!.tools.length}#${event.tool}`, tool: event.tool, input: event.input },
          ],
        };
      } else {
        steps.push({
          stepId: event.stepId,
          agent: "worker",
          label: toolDisplayName(event.tool),
          status: "running",
          tools: [{ id: `${event.stepId}#0#${event.tool}`, tool: event.tool, input: event.input }],
        });
      }
      return { ...state, steps };
    }
    case "tool_result": {
      const steps = [...state.steps];
      const idx = steps.findIndex((s) => s.stepId === event.stepId);
      if (idx >= 0) {
        const step = steps[idx]!;
        const tools = [...step.tools];
        // 找最后一个同工具名的调用挂结果
        for (let i = tools.length - 1; i >= 0; i--) {
          if (tools[i]!.tool === event.tool && !tools[i]!.summary) {
            tools[i] = { ...tools[i]!, summary: event.summary, elapsedMs: event.elapsedMs };
            break;
          }
        }
        steps[idx] = { ...step, tools, status: step.status === "running" ? "done" : step.status };
      }
      return { ...state, steps };
    }
    case "table":
      return { ...state, tables: [...state.tables, event.table] };
    case "chart":
      return { ...state, charts: [...state.charts, event.chart] };
    case "chunk":
      return { ...state, answer: state.answer + event.content };
    case "citations":
      return { ...state, citations: event.citations };
    case "done":
      return { ...state, done: true, elapsedMs: event.elapsedMs };
    case "error":
      return { ...state, error: event.message, done: true };
    default:
      return state;
  }
}

export function toolDisplayName(tool: string): string {
  const map: Record<string, string> = {
    sql_query: "SQL 查询",
    inspect_schema: "查看表结构",
    show_table: "展示表格",
    generate_chart: "生成图表",
    web_search: "联网搜索",
    fetch_page: "抓取网页",
    record_finding: "记录发现",
    search: "多源检索算子",
    extract: "信息抽取算子",
    compare: "多源对比算子",
  };
  return map[tool] ?? tool;
}
