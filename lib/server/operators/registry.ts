import { z } from "zod";
import type { OperatorMeta, OperatorRunResult } from "./data-operators";
import {
  AggregateOpMeta, runAggregateOp, AggregateInput,
  TimeSeriesOpMeta, runTimeSeriesOp, TimeSeriesInput,
  AnomalyOpMeta, runAnomalyOp, AnomalyInput,
  FilterOpMeta, runFilterOp, FilterInput,
  TransformOpMeta, runTransformOp, TransformInput,
  JoinOpMeta, runJoinOp, JoinInput,
} from "./data-operators";
import {
  SearchOpMeta, runSearchOp,
  ExtractOpMeta, runExtractOp,
  SummarizeOpMeta, runSummarizeOp,
  CompareOpMeta, runCompareOp,
  CitationOpMeta, runCitationOp,
  WriteOpMeta, runWriteOp,
} from "./research-operators";

/**
 * 算子注册表（design.md 5.2 算子层）
 *
 * 数据分析算子（SQL/API 引擎）+ 研究算子（LLM 引擎）统一注册，
 * 每个算子 = 元数据（Meta）+ 输入 Schema（Zod）+ 执行函数。
 * 数据算子的输入 Schema 由语义层指标目录动态生成（见 data-operators.ts），
 * 供 /api/v1/operators（列表/试运行）与任务问答 run_operator 工具复用。
 */

interface RegisteredOperator {
  meta: OperatorMeta;
  inputSchema: z.ZodTypeAny;
  run: (input: unknown) => Promise<OperatorRunResult>;
}

const REGISTRY: Record<string, RegisteredOperator> = {
  aggregate: { meta: AggregateOpMeta, inputSchema: AggregateInput, run: (i) => runAggregateOp(i as never) },
  timeseries: { meta: TimeSeriesOpMeta, inputSchema: TimeSeriesInput, run: (i) => runTimeSeriesOp(i as never) },
  anomaly: { meta: AnomalyOpMeta, inputSchema: AnomalyInput, run: (i) => runAnomalyOp(i as never) },
  filter: { meta: FilterOpMeta, inputSchema: FilterInput, run: (i) => runFilterOp(i as never) },
  transform: { meta: TransformOpMeta, inputSchema: TransformInput, run: (i) => runTransformOp(i as never) },
  join: { meta: JoinOpMeta, inputSchema: JoinInput, run: (i) => runJoinOp(i as never) },
  search: { meta: SearchOpMeta, inputSchema: SearchInputSchema(), run: (i) => runSearchOp(i as never) as Promise<OperatorRunResult> },
  extract: { meta: ExtractOpMeta, inputSchema: ExtractInputSchema(), run: (i) => runExtractOp(i as never) },
  summarize: { meta: SummarizeOpMeta, inputSchema: SummarizeInputSchema(), run: (i) => runSummarizeOp(i as never) },
  compare: { meta: CompareOpMeta, inputSchema: CompareInputSchema(), run: (i) => runCompareOp(i as never) },
  citation: { meta: CitationOpMeta, inputSchema: CitationInputSchema(), run: (i) => runCitationOp(i as never) },
  write: { meta: WriteOpMeta, inputSchema: WriteInputSchema(), run: (i) => runWriteOp(i as never) },
};

// 研究算子输入 Schema（LLM 引擎，参数与语义层目录无关，静态定义）
function SearchInputSchema() {
  return z.object({ query: z.string().min(1), maxResults: z.coerce.number().optional() });
}
function ExtractInputSchema() {
  return z.object({ url: z.string().url(), focus: z.string().optional() });
}
function SummarizeInputSchema() {
  return z.object({ text: z.string().min(10), style: z.enum(["structured", "paragraph"]).optional() });
}
function CompareInputSchema() {
  return z.object({ sources: z.string().min(20), topic: z.string().min(2) });
}
function CitationInputSchema() {
  return z.object({ query: z.string().min(2) });
}
function WriteInputSchema() {
  return z.object({
    section: z.string().min(2),
    material: z.string().min(20),
    audience: z.enum(["管理层", "分析师", "业务团队"]).optional(),
  });
}

/** 列出全部算子元数据（按分类分组） */
export function listOperators(): OperatorMeta[] {
  return Object.values(REGISTRY).map((op) => op.meta);
}

/** 获取单个算子元数据 */
export function getOperator(id: string): OperatorMeta | null {
  return REGISTRY[id]?.meta ?? null;
}

/** 执行算子（输入经 Zod 校验） */
export async function runOperator(id: string, input: unknown): Promise<OperatorRunResult> {
  const op = REGISTRY[id];
  if (!op) {
    return {
      ok: false, operatorId: id, columns: [], rows: [], rowCount: 0,
      elapsedMs: 0, notes: [], error: `算子不存在: ${id}`,
    };
  }
  const parsed = op.inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false, operatorId: id, columns: [], rows: [], rowCount: 0,
      elapsedMs: 0, notes: [],
      error: `参数校验失败: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    };
  }
  return op.run(parsed.data);
}
