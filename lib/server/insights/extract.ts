/**
 * 画布实时绑定 payload 提取
 * 从问答（Question.answer）与深度研究（ResearchTask + Question.answer）中
 * 提取可上画布的内容结构（图表/表格/正文/引用），供 CanvasBinding.payload 存储。
 */
import type { ChartSpec, TablePayload, Citation } from "@/lib/agent-events";
import type { LivePayload } from "@/lib/canvas/types";

export type { LivePayload };

/** 源数据行（与 Prisma Question/ResearchTask 行结构兼容的最小集合） */
interface QuestionLike {
  id: string;
  content: string;
  status: string;
  answer: unknown;
}

/** answer JSON 的可能形态（ask 与 deep_research 两种载体） */
interface AnswerLike {
  kind?: string;
  content?: unknown;
  charts?: unknown;
  tables?: unknown;
  citations?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asChartSpecs(v: unknown): ChartSpec[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c) => isRecord(c) && Array.isArray(c.data)) as unknown as ChartSpec[];
}

function asTables(v: unknown): TablePayload[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (t) => isRecord(t) && Array.isArray(t.columns) && Array.isArray(t.rows),
  ) as unknown as TablePayload[];
}

function asCitations(v: unknown): Citation[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c) => isRecord(c) && typeof c.title === "string") as unknown as Citation[];
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  return "";
}

/**
 * 从问答记录提取 payload：
 * - 已完成：charts/tables 存在时为 chart 类，否则 text 类
 * - 未完成：仍返回带状态提示的占位 payload（画布上显示"更新中"）
 */
export function extractFromQuestion(question: QuestionLike): { payload: LivePayload; sourceStatus: string } {
  const status = question.status ?? "unknown";
  const answer = isRecord(question.answer) ? (question.answer as AnswerLike) : null;

  const charts = answer ? asChartSpecs(answer.charts) : [];
  const tables = answer ? asTables(answer.tables) : [];
  const citations = answer ? asCitations(answer.citations) : [];
  const text = answer ? asText(answer.content) : "";

  const payload: LivePayload = {
    kind: charts.length > 0 ? "chart" : "text",
    title: question.content,
    ...(text ? { text } : {}),
    ...(charts.length > 0 ? { charts } : {}),
    ...(tables.length > 0 ? { tables } : {}),
    ...(citations.length > 0 ? { citations } : {}),
  };
  return { payload, sourceStatus: status };
}

/**
 * 从深度研究主任务提取 payload：
 * 报告正文落在关联 Question.answer（kind=deep_research），引用在 answer.citations
 */
export function extractFromResearch(task: {
  id: string;
  status: string;
  output: unknown;
  citations: unknown;
}, question: QuestionLike | null): { payload: LivePayload; sourceStatus: string } {
  const status = task.status ?? "unknown";
  const answer = question && isRecord(question.answer) ? (question.answer as AnswerLike) : null;
  const output = isRecord(task.output) ? (task.output as Record<string, unknown>) : null;

  const text = answer ? asText(answer.content) : output ? asText(output.report) : "";
  const citations = answer
    ? asCitations(answer.citations)
    : asCitations(task.citations);
  const title = question?.content ?? "深度研究";

  const payload: LivePayload = {
    kind: "research",
    title,
    ...(text ? { text } : {}),
    ...(citations.length > 0 ? { citations } : {}),
  };
  return { payload, sourceStatus: status };
}

/** 判断源状态是否仍在运行中（画布徽标显示"更新中"） */
export function isSourceRunning(sourceStatus: string): boolean {
  return !["completed", "failed", "unknown", "deleted"].includes(sourceStatus);
}
