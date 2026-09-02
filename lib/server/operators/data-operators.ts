import { z } from "zod";
import { executeReadOnlyQuery } from "@/lib/server/connectors/postgres";
import { DEMO_SEMANTIC_MODELS, type SemanticModelDef } from "@/lib/server/semantic/semantic-query";
import { listAllSemanticModels } from "@/lib/server/semantic/model-store";
import { listDataSources } from "@/lib/server/connectors/datasources";
import { cachedRestRequest } from "@/lib/server/connectors/api-cache";
import { parseCsvTable, csvTableToObjects } from "@/lib/server/connectors/csv";
import { env } from "@/lib/env";

/**
 * 数据分析算子（design.md 5.2.1）
 *
 * 七个预置算子：六个 SQL 算子在 PostgreSQL/DuckDB 兼容语法上真实执行，
 * 一个 API 取数算子经带缓存的 REST 连接器拉取外部 CSV 报告：
 * - AggregateOp   分组聚合、多维度下钻
 * - FilterOp      条件过滤
 * - TransformOp   派生指标计算（CPI/CPM/CTR/FD 率/RD 率/ROI 等）
 * - TimeSeriesOp  时序补全、同比环比
 * - AnomalyOp     异常检测（Z-Score / 环比突变）
 * - JoinOp        跨源数据关联（投放日汇总 × 投放计划累计效果）
 * - ApiFetchOp    外部 API 数据源取数（如 Adjust 报告服务，CSV 结构化 + 查询缓存）
 *
 * 指标/维度口径统一由语义层模型驱动（内置 DEMO_SEMANTIC_MODELS + DB 自定义模型，
 * 见 runtimeSemanticModels），算子不硬编码具体指标枚举；每个算子 = 元数据 + 纯执行函数，
 * 由 registry.ts 注册，经 /api/v1/operators 暴露，并被任务问答的
 * run_operator 工具复用（算子优先、sql_query 兜底）。
 */

// ─── 算子通用类型 ─────────────────────────────────────────────────────────────

export interface OperatorMeta {
  id: string;
  name: string;
  category: "data" | "research";
  description: string;
  /** 参数 Schema（JSON Schema 形态描述，供 UI 动态渲染表单） */
  params: Array<{
    name: string;
    label: string;
    type: "string" | "number" | "date" | "enum" | "boolean";
    required: boolean;
    defaultValue?: string | number | boolean;
    options?: string[];
    placeholder?: string;
  }>;
  engine: "sql" | "llm" | "hybrid" | "api";
}

export interface OperatorRunResult {
  ok: boolean;
  operatorId: string;
  /** 结构化结果（表格） */
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** 执行信息 */
  sql?: string;
  elapsedMs: number;
  notes: string[];
  error?: string;
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** 单引号转义（维度值拼入 WHERE 前必须处理） */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ─── 指标/维度目录（语义层驱动，算子口径的唯一来源） ──────────────────────────

/** 需要配合过滤条件才能计算、不可独立聚合的指标，排除出算子目录 */
const FILTER_BOUND_METRICS = new Set(["refund_rate"]);

/** 算子可用的指标条目：指标定义 + 所属模型定位信息 */
export interface OperatorMetricEntry {
  id: string;
  name: string;
  column: string;
  agg: "sum" | "avg" | "count" | "max" | "min";
  unit?: string;
  description: string;
  modelId: string;
  modelName: string;
  /** 全限定表名（schema.table） */
  table: string;
  timeColumn: string;
  /** timeColumn 是否为日期列（支持时间过滤/时序/异常检测） */
  supportsTime: boolean;
}

/** 算子可用的维度条目 */
export interface OperatorDimensionEntry {
  id: string;
  name: string;
  column: string;
  values?: string[];
  description: string;
}

/**
 * 从语义模型生成算子指标目录：
 * - 排除无聚合口径（agg=none）与需配合过滤的指标
 * - 同名指标跨模型重复时保留首个（内置模型顺序即优先级）
 * - 时间列非日期（如 products 用 id）的模型标记 supportsTime=false
 */
export function operatorMetricCatalog(
  models: SemanticModelDef[] = DEMO_SEMANTIC_MODELS,
): OperatorMetricEntry[] {
  const catalog: OperatorMetricEntry[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    for (const metric of model.metrics) {
      if (metric.agg === "none" || FILTER_BOUND_METRICS.has(metric.id) || seen.has(metric.id)) continue;
      seen.add(metric.id);
      catalog.push({
        id: metric.id,
        name: metric.name,
        column: metric.column,
        agg: metric.agg,
        unit: metric.unit,
        description: metric.description,
        modelId: model.id,
        modelName: model.name,
        table: `${model.schema}.${model.table}`,
        timeColumn: model.timeColumn,
        supportsTime: model.timeColumn !== "id",
      });
    }
  }
  return catalog;
}

/** 某模型的可分组维度（排除时间列，分组日期请改用 timeseries 算子） */
export function operatorDimensionsForModel(
  modelId: string,
  models: SemanticModelDef[] = DEMO_SEMANTIC_MODELS,
): OperatorDimensionEntry[] {
  const model = models.find((m) => m.id === modelId);
  if (!model) return [];
  return model.dimensions
    .filter((d) => d.column !== model.timeColumn)
    .map((d) => ({ id: d.id, name: d.name, column: d.column, values: d.values, description: d.description }));
}

/**
 * 运行时语义模型集合：内置 + DB 自定义（如 Adjust 投放日指标）；
 * DB 不可用时降级为内置模型（纯函数单测与离线场景不阻断）
 */
export async function runtimeSemanticModels(): Promise<SemanticModelDef[]> {
  try {
    return await listAllSemanticModels();
  } catch {
    return DEMO_SEMANTIC_MODELS;
  }
}

/** 按聚合方式与物理列生成聚合表达式 */
export function aggExprOf(agg: OperatorMetricEntry["agg"], column: string): string {
  switch (agg) {
    case "count":
      return `COUNT(${column === "id" ? "*" : `"${column}"`})`;
    case "avg":
      return `AVG("${column}")`;
    case "max":
      return `MAX("${column}")`;
    case "min":
      return `MIN("${column}")`;
    default:
      return `SUM("${column}")`;
  }
}

/** 指标聚合表达式（SUM/AVG/COUNT/MAX/MIN） */
export function metricAggExpr(entry: OperatorMetricEntry): string {
  return aggExprOf(entry.agg, entry.column);
}

/** 指标目录速览（供提示词注入） */
export function operatorMetricCatalogSummary(
  models: SemanticModelDef[] = DEMO_SEMANTIC_MODELS,
): string {
  const catalog = operatorMetricCatalog(models);
  return catalog
    .map((m) => `- ${m.id}（${m.name}${m.unit ? `，${m.unit}` : ""}，模型：${m.modelName}）：${m.description}`)
    .join("\n");
}

/** 维度目录速览（按模型分组，供提示词注入） */
export function operatorDimensionCatalogSummary(
  models: SemanticModelDef[] = DEMO_SEMANTIC_MODELS,
): string {
  return models
    .map((model) => {
      const dims = operatorDimensionsForModel(model.id, models);
      if (dims.length === 0) return "";
      const text = dims
        .map((d) => `${d.id}(${d.name}${d.values ? `，取值: ${d.values.join("/")}` : ""})`)
        .join("，");
      return `- ${model.name}（${model.id}）：${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

// ─── 通用输入片段 ─────────────────────────────────────────────────────────────

export interface TimeRangeInput {
  from?: string;
  to?: string;
}

/** 时间范围 WHERE 条件（按模型时间列） */
export function timeConditions(timeColumn: string, range: TimeRangeInput): string[] {
  const conditions: string[] = [];
  if (range.from) conditions.push(`"${timeColumn}" >= '${range.from}'`);
  if (range.to) conditions.push(`"${timeColumn}" <= '${range.to}'`);
  return conditions;
}

// ─── 动态输入枚举（由目录派生，仅供 UI 提示；运行时校验以动态目录为准，
// 自定义模型指标/模型 ID 无法预知，Schema 层放宽为字符串） ────────────────────

type EnumTuple = [string, ...string[]];

/** 内置模型算子可用指标 ID（UI 提示用） */
export const ALL_METRIC_IDS = operatorMetricCatalog().map((m) => m.id) as EnumTuple;
/** 内置模型支持时序/异常检测的指标 ID（UI 提示用） */
export const TIME_METRIC_IDS = operatorMetricCatalog()
  .filter((m) => m.supportsTime)
  .map((m) => m.id) as EnumTuple;
/** 内置语义模型 ID（UI 提示用） */
export const SEMANTIC_MODEL_IDS = DEMO_SEMANTIC_MODELS.map((m) => m.id) as EnumTuple;

const DATE_INPUT = z.string().regex(DATE_REGEX);

// ─── AggregateOp：分组聚合 ────────────────────────────────────────────────────

export const AggregateOpMeta: OperatorMeta = {
  id: "aggregate",
  name: "分组聚合",
  category: "data",
  description: "任意指标按其所属模型的维度分组聚合，支持维度值过滤与时间范围（如按投放渠道统计花费）",
  engine: "sql",
  params: [
    { name: "metric", label: "指标", type: "enum", required: true, options: operatorMetricCatalog().map((m) => m.id) },
    { name: "groupBy", label: "分组维度", type: "string", required: true, placeholder: "必须是该指标所属模型的维度，如 ad_channel" },
    { name: "dimensionValue", label: "维度值过滤", type: "string", required: false, placeholder: "如 Meta" },
    { name: "from", label: "开始日期", type: "date", required: false, placeholder: "2026-01-01" },
    { name: "to", label: "结束日期", type: "date", required: false },
  ],
};

export const AggregateInput = z.object({
  // 指标 ID 不限于内置枚举：运行时按动态目录（内置+自定义模型）校验
  metric: z.string().min(1),
  groupBy: z.string().min(1),
  dimensionValue: z.string().optional(),
  from: DATE_INPUT.optional(),
  to: DATE_INPUT.optional(),
});

/** 构建分组聚合 SQL（纯函数，便于测试；子句顺序固定） */
export function buildAggregateSql(
  entry: OperatorMetricEntry,
  dim: OperatorDimensionEntry,
  input: z.infer<typeof AggregateInput>,
): string {
  const conditions = timeConditions(entry.timeColumn, input);
  if (input.dimensionValue) conditions.push(`"${dim.column}" = ${quoteLiteral(input.dimensionValue)}`);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return `SELECT "${dim.column}" AS ${dim.id}, ROUND(${metricAggExpr(entry)}::numeric, 2) AS ${entry.id}\nFROM ${entry.table}\n${where}\nGROUP BY "${dim.column}"\nORDER BY 2 DESC\nLIMIT 200`;
}

export async function runAggregateOp(input: z.infer<typeof AggregateInput>): Promise<OperatorRunResult> {
  const start = Date.now();
  const models = await runtimeSemanticModels();
  const entry = operatorMetricCatalog(models).find((m) => m.id === input.metric);
  if (!entry) return failed("aggregate", new Error(`未知指标: ${input.metric}`), start);
  const dim = operatorDimensionsForModel(entry.modelId, models).find((d) => d.id === input.groupBy);
  if (!dim) {
    const valid = operatorDimensionsForModel(entry.modelId, models).map((d) => d.id).join(", ");
    return failed("aggregate", new Error(`指标 ${input.metric} 所属模型「${entry.modelName}」无维度 ${input.groupBy}，可用维度: ${valid}`), start);
  }
  const sql = buildAggregateSql(entry, dim, input);
  try {
    const result = await executeReadOnlyQuery(env.DATABASE_URL, sql, { maxRows: 200 });
    return {
      ok: true, operatorId: "aggregate", columns: result.columns, rows: result.rows,
      rowCount: result.rowCount, sql, elapsedMs: Date.now() - start,
      notes: [`指标 ${entry.id}（${entry.name}）来自模型「${entry.modelName}」`],
    };
  } catch (error) {
    return failed("aggregate", error, start, sql);
  }
}

// ─── TimeSeriesOp：时序 + 同比环比 ───────────────────────────────────────────

export const TimeSeriesOpMeta: OperatorMeta = {
  id: "timeseries",
  name: "时序分析",
  category: "data",
  description: "任意指标按日/周/月聚合时序，自动计算环比与同比变化率",
  engine: "sql",
  params: [
    { name: "metric", label: "指标", type: "enum", required: true, options: operatorMetricCatalog().filter((m) => m.supportsTime).map((m) => m.id) },
    { name: "granularity", label: "粒度", type: "enum", required: false, defaultValue: "month", options: ["day", "week", "month"] },
    { name: "from", label: "开始日期", type: "date", required: false, placeholder: "2025-01-01" },
    { name: "to", label: "结束日期", type: "date", required: false },
  ],
};

export const TimeSeriesInput = z.object({
  // 指标 ID 运行时按动态目录校验（含 supportsTime 检查）
  metric: z.string().min(1),
  granularity: z.enum(["day", "week", "month"]).default("month"),
  from: DATE_INPUT.optional(),
  to: DATE_INPUT.optional(),
});

/** 各粒度的同比滞后周期（日=365、周=52、月=12） */
const YOY_LAG: Record<string, number> = { day: 365, week: 52, month: 12 };

/** 构建时序同比环比 SQL（纯函数） */
export function buildTimeSeriesSql(
  entry: OperatorMetricEntry,
  input: z.infer<typeof TimeSeriesInput>,
): string {
  const conditions = timeConditions(entry.timeColumn, input);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const yoyLag = YOY_LAG[input.granularity] ?? 12;
  return `WITH series AS (
  SELECT date_trunc('${input.granularity}', "${entry.timeColumn}") AS bucket, ROUND(${metricAggExpr(entry)}::numeric, 2) AS value
  FROM ${entry.table}
  ${where}
  GROUP BY 1
)
SELECT to_char(bucket, 'YYYY-MM-DD') AS period,
       value,
       ROUND((value - LAG(value, 1) OVER (ORDER BY bucket)) / NULLIF(LAG(value, 1) OVER (ORDER BY bucket), 0) * 100, 2) AS mom_pct,
       ROUND((value - LAG(value, ${yoyLag}) OVER (ORDER BY bucket)) / NULLIF(LAG(value, ${yoyLag}) OVER (ORDER BY bucket), 0) * 100, 2) AS yoy_pct
FROM series
ORDER BY bucket`;
}

export async function runTimeSeriesOp(input: z.infer<typeof TimeSeriesInput>): Promise<OperatorRunResult> {
  const start = Date.now();
  const models = await runtimeSemanticModels();
  const entry = operatorMetricCatalog(models).find((m) => m.id === input.metric);
  if (!entry) return failed("timeseries", new Error(`未知指标: ${input.metric}`), start);
  if (!entry.supportsTime) {
    return failed("timeseries", new Error(`指标 ${input.metric} 所属模型无日期时间列，不支持时序分析`), start);
  }
  const sql = buildTimeSeriesSql(entry, input);
  try {
    const result = await executeReadOnlyQuery(env.DATABASE_URL, sql, { maxRows: 800 });
    return {
      ok: true, operatorId: "timeseries", columns: result.columns, rows: result.rows,
      rowCount: result.rowCount, sql, elapsedMs: Date.now() - start,
      notes: ["mom_pct=环比%，yoy_pct=同比%；粒度越细同比所需历史数据越长"],
    };
  } catch (error) {
    return failed("timeseries", error, start, sql);
  }
}

// ─── AnomalyOp：异常检测 ──────────────────────────────────────────────────────

export const AnomalyOpMeta: OperatorMeta = {
  id: "anomaly",
  name: "异常检测",
  category: "data",
  description: "基于 28 日滚动窗口 Z-Score 检测任意指标的时序异常点（|z| > 阈值 视为异常）",
  engine: "sql",
  params: [
    { name: "metric", label: "指标", type: "enum", required: true, options: operatorMetricCatalog().filter((m) => m.supportsTime).map((m) => m.id) },
    { name: "threshold", label: "Z-Score 阈值", type: "number", required: false, defaultValue: 2 },
    { name: "from", label: "开始日期", type: "date", required: false, placeholder: "2026-01-01" },
    { name: "to", label: "结束日期", type: "date", required: false },
  ],
};

export const AnomalyInput = z.object({
  // 指标 ID 运行时按动态目录校验（含 supportsTime 检查）
  metric: z.string().min(1),
  threshold: z.coerce.number().min(1).max(5).default(2),
  from: DATE_INPUT.optional(),
  to: DATE_INPUT.optional(),
});

/** 构建滚动窗口 Z-Score 异常检测 SQL（纯函数） */
export function buildAnomalySql(
  entry: OperatorMetricEntry,
  input: z.infer<typeof AnomalyInput>,
): string {
  const conditions = timeConditions(entry.timeColumn, input);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return `WITH daily AS (
  SELECT date_trunc('day', "${entry.timeColumn}") AS stat_day, ROUND(${metricAggExpr(entry)}::numeric, 4) AS value
  FROM ${entry.table}
  ${where}
  GROUP BY 1
), stats AS (
  SELECT stat_day, value,
         AVG(value) OVER (ORDER BY stat_day ROWS BETWEEN 28 PRECEDING AND CURRENT ROW) AS roll_avg,
         STDDEV(value) OVER (ORDER BY stat_day ROWS BETWEEN 28 PRECEDING AND CURRENT ROW) AS roll_std
  FROM daily
)
SELECT to_char(stat_day, 'YYYY-MM-DD') AS date,
       value,
       ROUND(roll_avg, 4) AS baseline,
       ROUND((value - roll_avg) / NULLIF(roll_std, 0), 2) AS z_score,
       CASE WHEN ABS((value - roll_avg) / NULLIF(roll_std, 0)) > ${input.threshold} THEN '异常' ELSE '正常' END AS flag
FROM stats
ORDER BY ABS((value - roll_avg) / NULLIF(roll_std, 0)) DESC NULLS LAST
LIMIT 30`;
}

export async function runAnomalyOp(input: z.infer<typeof AnomalyInput>): Promise<OperatorRunResult> {
  const start = Date.now();
  const models = await runtimeSemanticModels();
  const entry = operatorMetricCatalog(models).find((m) => m.id === input.metric);
  if (!entry) return failed("anomaly", new Error(`未知指标: ${input.metric}`), start);
  if (!entry.supportsTime) {
    return failed("anomaly", new Error(`指标 ${input.metric} 所属模型无日期时间列，不支持异常检测`), start);
  }
  const sql = buildAnomalySql(entry, input);
  try {
    const result = await executeReadOnlyQuery(env.DATABASE_URL, sql, { maxRows: 50 });
    const anomalyCount = result.rows.filter((r) => r.flag === "异常").length;
    return {
      ok: true, operatorId: "anomaly", columns: result.columns, rows: result.rows,
      rowCount: result.rowCount, sql, elapsedMs: Date.now() - start,
      notes: [`按 |z| > ${input.threshold} 判定，检出 ${anomalyCount} 个异常日（结果按异常程度排序）`],
    };
  } catch (error) {
    return failed("anomaly", error, start, sql);
  }
}

// ─── FilterOp：条件过滤（按模型下钻） ─────────────────────────────────────────

export const FilterOpMeta: OperatorMeta = {
  id: "filter",
  name: "条件过滤",
  category: "data",
  description: "按维度值组合与时间范围过滤指定语义模型的数据，输出全维度分组聚合结果，用于下钻验证",
  engine: "sql",
  params: [
    { name: "model", label: "语义模型", type: "enum", required: true, options: DEMO_SEMANTIC_MODELS.map((m) => m.id) },
    { name: "filters", label: "维度值过滤（JSON）", type: "string", required: false, placeholder: '{"ad_channel":"Meta","platform":"app"}' },
    { name: "from", label: "开始日期", type: "date", required: false },
    { name: "to", label: "结束日期", type: "date", required: false },
  ],
};

export const FilterInput = z.object({
  // 模型 ID 运行时按动态目录校验（内置 + 自定义模型）
  model: z.string().min(1),
  filters: z.record(z.string(), z.string()).optional(),
  from: DATE_INPUT.optional(),
  to: DATE_INPUT.optional(),
});

/** 构建按模型全维度分组 + 全指标聚合的过滤下钻 SQL（纯函数） */
export function buildFilterSql(
  model: SemanticModelDef,
  dims: OperatorDimensionEntry[],
  metricExprs: Array<{ id: string; expr: string }>,
  filters: Record<string, string>,
  range: TimeRangeInput,
): string {
  const conditions = timeConditions(model.timeColumn, range);
  for (const [dimId, value] of Object.entries(filters)) {
    const dim = dims.find((d) => d.id === dimId);
    if (dim) conditions.push(`"${dim.column}" = ${quoteLiteral(value)}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const selectCols = [
    ...dims.map((d) => `"${d.column}" AS ${d.id}`),
    ...metricExprs.map((m) => `ROUND(${m.expr}::numeric, 2) AS ${m.id}`),
  ].join(",\n       ");
  const groupCols = dims.map((d) => `"${d.column}"`).join(", ");
  return `SELECT ${selectCols}\nFROM ${model.schema}.${model.table}\n${where}\nGROUP BY ${groupCols}\nORDER BY ${dims.length + 1} DESC\nLIMIT 200`;
}

export async function runFilterOp(input: z.infer<typeof FilterInput>): Promise<OperatorRunResult> {
  const start = Date.now();
  const models = await runtimeSemanticModels();
  const model = models.find((m) => m.id === input.model);
  if (!model) {
    const valid = models.map((m) => m.id).join(", ");
    return failed("filter", new Error(`未知语义模型: ${input.model}，可用: ${valid}`), start);
  }
  const dims = operatorDimensionsForModel(model.id, models);
  const filters = input.filters ?? {};
  const unknownDims = Object.keys(filters).filter((k) => !dims.some((d) => d.id === k));
  if (unknownDims.length > 0) {
    return failed("filter", new Error(`模型「${model.name}」无维度 ${unknownDims.join(", ")}，可用维度: ${dims.map((d) => d.id).join(", ")}`), start);
  }
  // 直接枚举所选模型自身的指标（不经目录去重，避免跨模型同名指标被裁掉）
  const metricExprs = model.metrics.flatMap((m) => {
    if (m.agg === "none" || FILTER_BOUND_METRICS.has(m.id)) return [];
    return [{ id: m.id, expr: aggExprOf(m.agg, m.column) }];
  });
  const sql = buildFilterSql(model, dims, metricExprs, filters, input);
  try {
    const result = await executeReadOnlyQuery(env.DATABASE_URL, sql, { maxRows: 200 });
    return {
      ok: true, operatorId: "filter", columns: result.columns, rows: result.rows,
      rowCount: result.rowCount, sql, elapsedMs: Date.now() - start,
      notes: [`模型「${model.name}」按全部维度分组聚合，指标取目录内该模型全部可聚合指标`],
    };
  } catch (error) {
    return failed("filter", error, start, sql);
  }
}

// ─── TransformOp：归因派生指标计算 ────────────────────────────────────────────

export const TransformOpMeta: OperatorMeta = {
  id: "transform",
  name: "派生指标计算",
  category: "data",
  description: "按月计算投放归因派生指标：CPI（单下载成本）/CPM/CTR/点击注册率/FD 率/RD 率/ROI",
  engine: "sql",
  params: [
    { name: "from", label: "开始日期", type: "date", required: false, placeholder: "2026-01-01" },
    { name: "to", label: "结束日期", type: "date", required: false },
  ],
};

export const TransformInput = z.object({
  from: DATE_INPUT.optional(),
  to: DATE_INPUT.optional(),
});

/** 构建归因派生指标月度 SQL（纯函数，基于投放渠道日指标模型） */
export function buildTransformSql(range: TimeRangeInput): string {
  const conditions = timeConditions("stat_date", range);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return `SELECT to_char(date_trunc('month', stat_date), 'YYYY-MM') AS month,
       ROUND(SUM(spend)::numeric, 2) AS spend,
       SUM(impressions) AS impressions,
       SUM(clicks) AS clicks,
       SUM(downloads) AS downloads,
       SUM(registrations) AS registrations,
       SUM(fd_users) AS fd_users,
       SUM(rd_users) AS rd_users,
       ROUND((SUM(spend) / NULLIF(SUM(downloads), 0))::numeric, 2) AS cpi,
       ROUND((1000.0 * SUM(spend) / NULLIF(SUM(impressions), 0))::numeric, 2) AS cpm,
       ROUND((100.0 * SUM(clicks) / NULLIF(SUM(impressions), 0))::numeric, 2) AS ctr_pct,
       ROUND((100.0 * SUM(registrations) / NULLIF(SUM(clicks), 0))::numeric, 2) AS click_to_reg_pct,
       ROUND((100.0 * SUM(fd_users) / NULLIF(SUM(registrations), 0))::numeric, 2) AS fd_rate_pct,
       ROUND((100.0 * SUM(rd_users) / NULLIF(SUM(fd_users), 0))::numeric, 2) AS rd_rate_pct,
       ROUND(((SUM(fd_amount) + SUM(rd_amount)) / NULLIF(SUM(spend), 0))::numeric, 2) AS roi
FROM demo.channel_daily_metrics
${where}
GROUP BY 1
ORDER BY 1`;
}

export async function runTransformOp(input: z.infer<typeof TransformInput>): Promise<OperatorRunResult> {
  const start = Date.now();
  const sql = buildTransformSql(input);
  try {
    const result = await executeReadOnlyQuery(env.DATABASE_URL, sql, { maxRows: 100 });
    return {
      ok: true, operatorId: "transform", columns: result.columns, rows: result.rows,
      rowCount: result.rowCount, sql, elapsedMs: Date.now() - start,
      notes: [
        "cpi=花费/下载（美元），cpm=千次展示成本，*_pct 为百分比",
        "fd_rate_pct=FD 用户/注册，rd_rate_pct=RD 用户/FD，roi=(FD 金额+RD 金额)/花费",
      ],
    };
  } catch (error) {
    return failed("transform", error, start, sql);
  }
}

// ─── JoinOp：跨源关联（日汇总 × 投放计划累计效果） ─────────────────────────────

export const JoinOpMeta: OperatorMeta = {
  id: "join",
  name: "跨源关联",
  category: "data",
  description: "关联投放渠道日汇总与投放计划表，按渠道×承接端对比实际日汇总效果与计划累计口径",
  engine: "sql",
  params: [
    { name: "from", label: "开始日期", type: "date", required: false, placeholder: "2026-01-01" },
    { name: "to", label: "结束日期", type: "date", required: false },
  ],
};

export const JoinInput = z.object({
  from: DATE_INPUT.optional(),
  to: DATE_INPUT.optional(),
});

/** 构建日汇总 × 投放计划的跨源关联 SQL（纯函数） */
export function buildJoinSql(range: TimeRangeInput): string {
  const conditions = timeConditions("stat_date", range);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return `WITH d AS (
  SELECT ad_channel, platform,
         ROUND(SUM(spend)::numeric, 2) AS actual_spend,
         SUM(downloads) AS actual_downloads,
         SUM(fd_users) AS actual_fd_users,
         SUM(rd_users) AS actual_rd_users
  FROM demo.channel_daily_metrics
  ${where}
  GROUP BY ad_channel, platform
), c AS (
  SELECT ad_channel, platform,
         ROUND(SUM(total_spend)::numeric, 2) AS plan_spend,
         SUM(downloads) AS plan_downloads,
         SUM(fd_users) AS plan_fd_users,
         SUM(rd_users) AS plan_rd_users
  FROM demo.channel_campaigns
  GROUP BY ad_channel, platform
)
SELECT d.ad_channel,
       d.platform,
       d.actual_spend,
       c.plan_spend,
       d.actual_downloads,
       c.plan_downloads,
       d.actual_fd_users,
       c.plan_fd_users,
       d.actual_rd_users,
       c.plan_rd_users
FROM d JOIN c ON c.ad_channel = d.ad_channel AND c.platform = d.platform
ORDER BY d.actual_spend DESC`;
}

export async function runJoinOp(input: z.infer<typeof JoinInput>): Promise<OperatorRunResult> {
  const start = Date.now();
  const sql = buildJoinSql(input);
  try {
    const result = await executeReadOnlyQuery(env.DATABASE_URL, sql, { maxRows: 50 });
    return {
      ok: true, operatorId: "join", columns: result.columns, rows: result.rows,
      rowCount: result.rowCount, sql, elapsedMs: Date.now() - start,
      notes: ["actual_* 为日指标汇总口径（受时间范围约束），plan_* 为投放计划累计口径（全周期），对比时注意口径差异"],
    };
  } catch (error) {
    return failed("join", error, start, sql);
  }
}

// ─── ApiFetchOp：外部 API 数据源取数（design.md 5.1.2 API 适配器） ────────────

export const ApiFetchOpMeta: OperatorMeta = {
  id: "api_fetch",
  name: "API 取数",
  category: "data",
  description: "从 API 数据源（如 Adjust 报告服务）拉取 CSV/JSON 报告并结构化为表格，经查询缓存与限流",
  engine: "api",
  params: [
    { name: "sourceId", label: "数据源 ID", type: "string", required: true, placeholder: "data_source_xxx（API 类型）" },
    { name: "path", label: "报告路径", type: "string", required: true, placeholder: "如 csv_report（拼接到 endpoint）" },
    { name: "dimensions", label: "维度", type: "string", required: true, placeholder: "逗号分隔，如 day,network" },
    { name: "metrics", label: "指标", type: "string", required: true, placeholder: "逗号分隔，如 installs,register_events" },
    { name: "datePeriod", label: "日期区间", type: "string", required: true, placeholder: "如 -7d:-1d 或 2026-08-01:2026-08-25" },
    { name: "filters", label: "过滤条件", type: "string", required: false, placeholder: 'JSON 对象，如 {"network__in":"web,gadmobe-apk"}' },
    { name: "sortBy", label: "排序", type: "string", required: false, placeholder: "如 -installs（降序）" },
    { name: "limit", label: "行数上限", type: "number", required: false, defaultValue: 200 },
  ],
};

export const ApiFetchInput = z.object({
  sourceId: z.string().min(1),
  path: z.string().min(1),
  dimensions: z.string().min(1),
  metrics: z.string().min(1),
  datePeriod: z.string().min(1),
  /** 过滤条件直接并入 query 参数（支持 __in/__gte 等操作符后缀） */
  filters: z.record(z.string(), z.string()).optional(),
  sortBy: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

/** 组装报告 API query 参数（纯函数，便于测试；键顺序固定保证缓存键稳定） */
export function buildApiFetchParams(input: z.infer<typeof ApiFetchInput>): Record<string, string> {
  const params: Record<string, string> = {
    dimensions: input.dimensions,
    metrics: input.metrics,
    date_period: input.datePeriod,
  };
  for (const [key, value] of Object.entries(input.filters ?? {})) params[key] = value;
  if (input.sortBy) params["sort_by"] = input.sortBy;
  if (input.limit) params["limit"] = String(input.limit);
  return params;
}

/** 响应体 → 表格（CSV 文本走 parseCsvTable；JSON rows 数组直接取对象行） */
function apiBodyToTable(contentType: string, body: unknown): { columns: string[]; rows: Record<string, unknown>[] } | null {
  if (contentType.includes("csv") && typeof body === "string") {
    const table = parseCsvTable(body);
    return { columns: table.header, rows: csvTableToObjects(table) };
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const rows = (body as { rows?: unknown }).rows;
    if (Array.isArray(rows) && rows.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
      const objectRows = rows as Record<string, unknown>[];
      const columns = Object.keys(objectRows[0] ?? {});
      return { columns, rows: objectRows };
    }
  }
  return null;
}

export async function runApiFetchOp(input: z.infer<typeof ApiFetchInput>): Promise<OperatorRunResult> {
  const start = Date.now();
  const source = (await listDataSources()).find((s) => s.id === input.sourceId);
  if (!source || source.type !== "api" || !source.apiConfig?.endpoint) {
    return failed("api_fetch", new Error(`API 数据源不存在或未配置 endpoint: ${input.sourceId}`), start);
  }
  const params = buildApiFetchParams(input);
  let result;
  try {
    result = await cachedRestRequest(source.apiConfig, { method: "GET", path: input.path, params }, { sourceId: source.id });
  } catch (error) {
    return failed("api_fetch", error, start);
  }
  const notes: string[] = [];
  if (result.cacheState === "fresh") notes.push("命中查询缓存（fresh），未请求上游");
  if (result.cacheState === "stale") notes.push("上游异常，降级返回过期缓存（stale）");
  if (result.status === 204) {
    return {
      ok: true, operatorId: "api_fetch", columns: [], rows: [], rowCount: 0,
      elapsedMs: Date.now() - start, notes: [...notes, "区间无数据（204）"],
    };
  }
  if (result.status < 200 || result.status >= 300) {
    const detail = typeof result.body === "string" ? result.body.slice(0, 300) : JSON.stringify(result.body).slice(0, 300);
    return failed("api_fetch", new Error(`API 返回 ${result.status}: ${detail}`), start);
  }
  if (result.truncated) notes.push("响应体超过 200KB 被截断，表格可能不完整（请缩小日期区间或减少维度）");
  const table = apiBodyToTable(result.contentType, result.body);
  if (!table) {
    return failed("api_fetch", new Error(`无法解析响应为表格（content-type: ${result.contentType}）`), start);
  }
  const MAX_ROWS = 200;
  const rows = table.rows.slice(0, MAX_ROWS);
  if (table.rows.length > MAX_ROWS) notes.push(`结果 ${table.rows.length} 行，已截断至前 ${MAX_ROWS} 行`);
  return {
    ok: true, operatorId: "api_fetch", columns: table.columns, rows,
    rowCount: rows.length, elapsedMs: Date.now() - start,
    notes: [...notes, `数据源「${source.name}」，上游耗时 ${result.elapsedMs}ms`],
  };
}

// ─── 失败包装 ─────────────────────────────────────────────────────────────────

function failed(operatorId: string, error: unknown, start: number, sql?: string): OperatorRunResult {
  return {
    ok: false,
    operatorId,
    columns: [],
    rows: [],
    rowCount: 0,
    sql,
    elapsedMs: Date.now() - start,
    notes: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

