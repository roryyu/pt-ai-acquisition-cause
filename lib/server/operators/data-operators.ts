import { z } from "zod";
import { executeReadOnlyQuery } from "@/lib/server/connectors/postgres";
import { DEMO_SEMANTIC_MODELS, type SemanticModelDef } from "@/lib/server/semantic/semantic-query";
import { listAllSemanticModels } from "@/lib/server/semantic/model-store";
import { listDataSources, type ResolvedDataSource } from "@/lib/server/connectors/datasources";
import { cachedRestRequest } from "@/lib/server/connectors/api-cache";
import { parseCsvTable, csvTableToObjects } from "@/lib/server/connectors/csv";
import { modelDimensionSlugs, persistApiRowsToDataTable, shouldPersist } from "@/lib/server/integrations/api-ingest";
import { env } from "@/lib/env";

/**
 * 数据分析算子（design.md 5.2.1）
 *
 * 六个预置算子均在 PostgreSQL/DuckDB 兼容语法或统一取数分流层上真实执行：
 * - AggregateOp   分组聚合、多维度下钻
 * - FilterOp      条件过滤
 * - TransformOp   派生指标计算（CPI/CPM/CTR/FD 率/RD 率/ROI 等）
 * - TimeSeriesOp  时序补全、同比环比
 * - AnomalyOp     异常检测（Z-Score / 环比突变）
 * - JoinOp        跨源数据关联（投放日汇总 × 投放计划累计效果）
 *
 * 取数物理路径由「统一取数分流层」按指标所属数据源自动决定，LLM 只面对语义 key：
 * PG/内置源 → 本地 SQL；外部 API 源 → cachedRestRequest（本地查询缓存 + API 直查，
 * 维度/指标自动映射上游 slug）。不再单独暴露需手拼 sourceId/path/slug 的 api_fetch 算子。
 *
 * 指标/维度口径统一由语义层模型驱动（默认种子模型 DEMO_SEMANTIC_MODELS + 任意同步入库/API
 * 源的自定义模型，彼此平级、无优先，见 runtimeSemanticModels），算子不硬编码具体指标枚举；
 * 每个算子 = 元数据 + 纯执行函数，
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
  /** 原始指标 id（模型内唯一，用作 SQL 别名） */
  id: string;
  /**
   * 全局唯一可寻址 id（算子 metric 入参、目录展示、UI 枚举均用此）：
   * 裸 id 在全部数据源中唯一时即等于 id；跨模型同名时以表名限定
   * （如 channel_daily_metrics.impressions / adjust_daily_metrics.impressions），
   * 确保每个数据源的指标平等、可独立寻址，不被同名遮蔽。
   */
  key: string;
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
  /**
   * 指标所属模型的数据源 ID（统一取数分流依据）：
   * 空/null=内置 PG 经营库（走本地 SQL）；非空=外部源（如 Adjust API 源，走本地缓存+API直查）。
   */
  dataSourceId?: string | null;
  /** 上游 API 指标 slug（API 源直查时用；缺省=与本地列名同名）——LLM 永不接触，算子内部解析 */
  apiSlug?: string;
}

/** 算子可用的维度条目 */
export interface OperatorDimensionEntry {
  id: string;
  name: string;
  column: string;
  values?: string[];
  description: string;
  /** 上游 API 维度 slug（API 源直查时用；缺省=与本地列名同名）——LLM 永不接触 */
  apiSlug?: string;
}

/**
 * 从语义模型生成算子指标目录（统一数据集合，各数据源平等）：
 * - 排除无聚合口径（agg=none）与需配合过滤的指标
 * - 不按 id 裁剪：所有数据源（默认种子模型 + 任意同步入库/API 源）的指标全部纳入，
 *   同名指标不再“保留首个”，而是各自以表名限定生成全局唯一 key（见 OperatorMetricEntry.key），
 *   确保任一来源的指标都能被独立寻址、平等参与分析，无内置/外部优先级
 * - 时间列非日期（如 products 用 id）的模型标记 supportsTime=false
 */
export function operatorMetricCatalog(
  models: SemanticModelDef[] = DEMO_SEMANTIC_MODELS,
): OperatorMetricEntry[] {
  const catalog: OperatorMetricEntry[] = [];
  for (const model of models) {
    for (const metric of model.metrics) {
      if (metric.agg === "none" || FILTER_BOUND_METRICS.has(metric.id)) continue;
      catalog.push({
        id: metric.id,
        key: metric.id, // 占位，下方按全局同名情况统一计算
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
        dataSourceId: model.dataSourceId ?? null,
        apiSlug: metric.apiSlug,
      });
    }
  }
  // 计算全局唯一可寻址 key：裸 id 唯一→保持原样；跨模型同名→表名限定；
  // 表名限定后仍冲突（同表同名的极端情况）→ 退回 modelId 限定，保证唯一
  const rawCount = new Map<string, number>();
  for (const e of catalog) rawCount.set(e.id, (rawCount.get(e.id) ?? 0) + 1);
  const keySeen = new Set<string>();
  for (const e of catalog) {
    const bareTable = e.table.slice(e.table.indexOf(".") + 1);
    let key = (rawCount.get(e.id) ?? 0) > 1 ? `${bareTable}.${e.id}` : e.id;
    if (keySeen.has(key)) key = `${e.modelId}.${e.id}`;
    keySeen.add(key);
    e.key = key;
  }
  return catalog;
}

/**
 * 按算子 metric 入参解析指标目录条目（aggregate/timeseries/anomaly 共用）：
 * - 优先精确匹配全局唯一 key（含表名限定 id）
 * - 裸 id 命中多个数据源时返回明确错误，列出各限定 id 供选择（不静默偏向任一源）
 * - 完全无命中返回“未知指标”
 */
export function resolveMetricEntry(
  metricKey: string,
  models: SemanticModelDef[],
): { entry?: OperatorMetricEntry; error?: string } {
  const catalog = operatorMetricCatalog(models);
  const exact = catalog.find((m) => m.key === metricKey);
  if (exact) return { entry: exact };
  const sameRaw = catalog.filter((m) => m.id === metricKey);
  if (sameRaw.length > 1) {
    const options = sameRaw.map((m) => `${m.key}（${m.modelName}）`).join(" / ");
    return { error: `指标 ${metricKey} 存在于多个数据源，请用限定 id 指定其一：${options}` };
  }
  return { error: `未知指标: ${metricKey}` };
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
    .map((d) => ({ id: d.id, name: d.name, column: d.column, values: d.values, description: d.description, apiSlug: d.apiSlug }));
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
    .map((m) => `- ${m.key}（${m.name}${m.unit ? `，${m.unit}` : ""}，模型：${m.modelName}）：${m.description}`)
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

/** 默认种子模型算子可用指标 key（UI 提示用；运行时以动态目录为准） */
export const ALL_METRIC_IDS = operatorMetricCatalog().map((m) => m.key) as EnumTuple;
/** 默认种子模型支持时序/异常检测的指标 key（UI 提示用） */
export const TIME_METRIC_IDS = operatorMetricCatalog()
  .filter((m) => m.supportsTime)
  .map((m) => m.key) as EnumTuple;
/** 默认种子语义模型 ID（UI 提示用；filter 算子运行时以动态目录为准） */
export const SEMANTIC_MODEL_IDS = DEMO_SEMANTIC_MODELS.map((m) => m.id) as EnumTuple;

const DATE_INPUT = z.string().regex(DATE_REGEX);

// ─── 统一取数分流层（PG源→本地SQL；API源→本地缓存+API直查，自动slug） ──────
// LLM 只用语义 key 指定指标/维度，算子据 entry.dataSourceId 自动选择物理执行路径，
// 永不暴露 sourceId / 上游 slug / 物理字段名——从源头消除指标维度混乱。

/** 解析指标所属数据源：API 源返回其配置（走 cachedRestRequest 本地缓存+直查），PG/内置源返回 null（走本地 SQL） */
async function resolveApiSource(dataSourceId?: string | null): Promise<ResolvedDataSource | null> {
  if (!dataSourceId) return null;
  const source = (await listDataSources()).find((s) => s.id === dataSourceId);
  return source && source.type === "api" && source.apiConfig?.endpoint ? source : null;
}

/** 时间范围 → 上游 date_period（from:to）；缺省近 30 天（Adjust 数据 T+1） */
function apiDatePeriod(range: TimeRangeInput): string {
  if (range.from && range.to) return `${range.from}:${range.to}`;
  if (range.from) return `${range.from}:${range.from}`;
  if (range.to) return `${range.to}:${range.to}`;
  return "-30d:-1d";
}

/** CSV/JSON 值安全转数值 */
function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 落库扩维取数路径的响应体上限（8MB）：默认 200KB 截断装不下全维度明细
 * （天数 × 渠道 × 国家可达万行级），仅限算子内部分解落库链路使用，
 * query_api_source 等通用工具仍维持 200KB 默认限制
 */
export const EXPANDED_MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * API 源统一取数：维度/指标自动用上游 slug 构造 JSON 终端（/report）请求 →
 * cachedRestRequest（命中本地查询缓存则不请求上游，否则 API 直查并回写缓存）→ 解析为表格行。
 * 返回行列名仍为上游 slug，由调用方映射回本地语义 id。
 * 选用 JSON 终端而非 CSV：额外获得 totals（汇总校验）与 data_warnings（上游数据预警），
 * 均写入 notes 供 LLM/使用者感知；带 utc_offset 保证与本地同步落库同一时区口径。
 */
async function fetchApiReportRows(
  source: ResolvedDataSource,
  dimSlugs: string[],
  metricSlugs: string[],
  datePeriod: string,
  sortSlug?: string,
  /** 调用方所属语义模型：提供且响应覆盖模型全维度时，miss 结果分解落库到对应 data 表 */
  model?: SemanticModelDef,
  /** 取数选项：maxBodyBytes 放宽响应体截断限制（落库扩维路径用） */
  opts?: { maxBodyBytes?: number },
): Promise<
  | { ok: true; columns: string[]; rows: Record<string, unknown>[]; elapsedMs: number; notes: string[]; truncated: boolean }
  | { ok: false; error: string }
> {
  const params: Record<string, string> = {
    dimensions: dimSlugs.join(","),
    metrics: metricSlugs.join(","),
    date_period: datePeriod,
  };
  if (sortSlug) params["sort"] = `-${sortSlug}`;
  if (env.ADJUST_RS_UTC_OFFSET) params["utc_offset"] = env.ADJUST_RS_UTC_OFFSET;
  let result;
  try {
    result = await cachedRestRequest(
      source.apiConfig!,
      { method: "GET", path: "report", params },
      { sourceId: source.id, maxBodyBytes: opts?.maxBodyBytes },
    );
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (result.status === 204) {
    return { ok: true, columns: [], rows: [], elapsedMs: result.elapsedMs, notes: ["区间无数据（204）"], truncated: false };
  }
  if (result.status < 200 || result.status >= 300) {
    const detail = typeof result.body === "string" ? result.body.slice(0, 300) : JSON.stringify(result.body).slice(0, 300);
    return { ok: false, error: `API 返回 ${result.status}: ${detail}` };
  }
  const table = apiBodyToTable(result.contentType, result.body);
  if (!table) return { ok: false, error: `无法解析响应为表格（content-type: ${result.contentType}）` };
  const notes: string[] = [];
  if (result.cacheState === "fresh") notes.push("命中查询缓存（fresh），未请求上游");
  if (result.cacheState === "stale") notes.push("上游异常，降级返回过期缓存（stale）");
  // JSON 终端附加信息：totals（区间总量，可与分组行求和交叉校验）与 data_warnings（上游数据预警）
  if (result.body && typeof result.body === "object" && !Array.isArray(result.body)) {
    const { totals, data_warnings: dataWarnings } = result.body as {
      totals?: Record<string, unknown>;
      data_warnings?: unknown;
    };
    if (totals && Object.keys(totals).length > 0) {
      const summary = Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(", ");
      notes.push(`API totals 区间总量（口径校验用）: ${summary}`);
    }
    if (Array.isArray(dataWarnings) && dataWarnings.length > 0) {
      notes.push(`上游数据预警: ${dataWarnings.join("；")}`);
    }
  }
  // 分解落库：真实响应（miss 且未截断）按全维度幂等 upsert 至语义模型对应的 data 表，
  // 供后续本地 SQL/算子复用；失败仅告警不影响取数（命中缓存/截断响应不落）
  if (model && result.cacheState === "miss" && !result.truncated && table.rows.length > 0 && shouldPersist(model, dimSlugs)) {
    const persisted = await persistApiRowsToDataTable(model, table.rows);
    if (persisted > 0) notes.push(`已分解落库 ${persisted} 行至 ${model.schema}.${model.table}，后续可本地查询`);
  }
  return { ok: true, columns: table.columns, rows: table.rows, elapsedMs: result.elapsedMs, notes, truncated: result.truncated };
}

/**
 * 扩维明细的内存聚合（纯函数）：按 groupBy 维度的上游 slug 累加指标值，
 * 输出本地 id 列名，按值降序（与 SQL ORDER BY 2 DESC / API sort=-metric 口径一致）；
 * dimensionValue 提供时仅保留该维度值（扩维路径下维度值过滤在内存完成）
 */
export function aggregateRowsInMemory(
  rows: Record<string, unknown>[],
  opts: { dimSlug: string; metricSlug: string; dimId: string; metricId: string; dimensionValue?: string },
): Record<string, unknown>[] {
  const acc = new Map<unknown, number>();
  for (const r of rows) {
    const key = r[opts.dimSlug] ?? null;
    if (opts.dimensionValue !== undefined && String(key) !== opts.dimensionValue) continue;
    acc.set(key, (acc.get(key) ?? 0) + toNum(r[opts.metricSlug]));
  }
  return [...acc.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ [opts.dimId]: key, [opts.metricId]: Math.round(value * 100) / 100 }));
}

// ─── AggregateOp：分组聚合 ────────────────────────────────────────────────────

export const AggregateOpMeta: OperatorMeta = {
  id: "aggregate",
  name: "分组聚合",
  category: "data",
  description: "任意指标按其所属模型的维度分组聚合，支持维度值过滤与时间范围（如按投放渠道统计花费）",
  engine: "sql",
  params: [
    { name: "metric", label: "指标", type: "enum", required: true, options: operatorMetricCatalog().map((m) => m.key) },
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
  const { entry, error } = resolveMetricEntry(input.metric, models);
  if (!entry) return failed("aggregate", new Error(error ?? `未知指标: ${input.metric}`), start);
  const dim = operatorDimensionsForModel(entry.modelId, models).find((d) => d.id === input.groupBy);
  if (!dim) {
    const valid = operatorDimensionsForModel(entry.modelId, models).map((d) => d.id).join(", ");
    return failed("aggregate", new Error(`指标 ${input.metric} 所属模型「${entry.modelName}」无维度 ${input.groupBy}，可用维度: ${valid}`), start);
  }
  // 统一分流：API 源指标 → 本地缓存+API直查（维度/指标自动用上游 slug，LLM 无感）；PG 源 → 本地 SQL
  const apiSource = await resolveApiSource(entry.dataSourceId);
  if (apiSource) {
    const dimSlug = dim.apiSlug ?? dim.column;
    const metricSlug = entry.apiSlug ?? entry.column;
    const datePeriod = apiDatePeriod(input);
    const model = models.find((m) => m.id === entry.modelId);
    // 第一段：扩维请求模型全维度明细（放宽响应限制）——真实响应（miss）自动分解落库 data 表，
    // 同时内存按 groupBy 聚合返回，输出形态与单维度直查一致；上游拒绝维度组合或响应过大
    // （截断）时自动回退第二段单维度请求（原有行为，不落库）
    if (model && model.dimensions.length > 0) {
      const expanded = await fetchApiReportRows(
        apiSource, modelDimensionSlugs(model), [metricSlug], datePeriod, undefined, model,
        { maxBodyBytes: EXPANDED_MAX_BODY_BYTES },
      );
      if (expanded.ok && !expanded.truncated) {
        const rows = aggregateRowsInMemory(expanded.rows, {
          dimSlug, metricSlug, dimId: dim.id, metricId: entry.id, dimensionValue: input.dimensionValue,
        });
        return {
          ok: true, operatorId: "aggregate", columns: [dim.id, entry.id], rows,
          rowCount: rows.length, elapsedMs: Date.now() - start,
          notes: [
            `指标 ${entry.id}（${entry.name}）来自 API 源「${apiSource.name}」，已扩维取全维度明细并按 ${dim.id} 内存聚合（真实响应自动分解落库）`,
            ...expanded.notes,
          ],
        };
      }
    }
    // 第二段（回退）：单维度直查，上游已按维度聚合、响应小；粒度不足不落库（既定方案）
    const res = await fetchApiReportRows(apiSource, [dimSlug], [metricSlug], datePeriod, metricSlug);
    if (!res.ok) return failed("aggregate", new Error(res.error), start);
    let rows = res.rows.map((r) => ({ [dim.id]: r[dimSlug] ?? null, [entry.id]: toNum(r[metricSlug]) }));
    if (input.dimensionValue !== undefined) rows = rows.filter((r) => String(r[dim.id]) === input.dimensionValue);
    return {
      ok: true, operatorId: "aggregate", columns: [dim.id, entry.id], rows,
      rowCount: rows.length, elapsedMs: Date.now() - start,
      notes: [
        `指标 ${entry.id}（${entry.name}）来自 API 源「${apiSource.name}」，经本地缓存+API直查自动取数（上游维度 ${dimSlug}、指标 ${metricSlug}）`,
        ...res.notes,
      ],
    };
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
    { name: "metric", label: "指标", type: "enum", required: true, options: operatorMetricCatalog().filter((m) => m.supportsTime).map((m) => m.key) },
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
  const { entry, error } = resolveMetricEntry(input.metric, models);
  if (!entry) return failed("timeseries", new Error(error ?? `未知指标: ${input.metric}`), start);
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
    { name: "metric", label: "指标", type: "enum", required: true, options: operatorMetricCatalog().filter((m) => m.supportsTime).map((m) => m.key) },
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
  const { entry, error } = resolveMetricEntry(input.metric, models);
  if (!entry) return failed("anomaly", new Error(error ?? `未知指标: ${input.metric}`), start);
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
  // 统一分流：API 源模型 → 本地缓存+API直查全维度明细（维度/指标自动用上游 slug）；PG 源 → 本地 SQL
  const apiSource = await resolveApiSource(model.dataSourceId);
  if (apiSource) {
    const metricFields = model.metrics.filter((m) => m.agg !== "none" && !FILTER_BOUND_METRICS.has(m.id));
    // API 请求附带时间维度（时间列为日期列时）：响应覆盖模型全维度，
    // 既得到按日明细，也使结果满足分解落库 data 表的粒度条件（缺失时是区间汇总，粒度不足）
    const timeDim = model.timeColumn !== "id"
      ? model.dimensions.find((d) => d.column === model.timeColumn)
      : undefined;
    const dimsForApi: OperatorDimensionEntry[] = timeDim ? [...dims, timeDim] : dims;
    const dimSlugs = dimsForApi.map((d) => d.apiSlug ?? d.column);
    const metricSlugs = metricFields.map((m) => m.apiSlug ?? m.column);
    // 放宽响应限制：大区间全维度明细易超默认 200KB 截断，导致无法落库
    const res = await fetchApiReportRows(apiSource, dimSlugs, metricSlugs, apiDatePeriod(input), undefined, model, {
      maxBodyBytes: EXPANDED_MAX_BODY_BYTES,
    });
    if (!res.ok) return failed("filter", new Error(res.error), start);
    const dimIdBySlug = new Map(dimsForApi.map((d) => [d.apiSlug ?? d.column, d.id]));
    const metIdBySlug = new Map(metricFields.map((m) => [m.apiSlug ?? m.column, m.id]));
    let rows = res.rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [slug, v] of Object.entries(r)) {
        const id = dimIdBySlug.get(slug) ?? metIdBySlug.get(slug) ?? slug;
        out[id] = metIdBySlug.has(slug) ? toNum(v) : v;
      }
      return out;
    });
    for (const [dimId, value] of Object.entries(filters)) rows = rows.filter((r) => String(r[dimId]) === value);
    return {
      ok: true, operatorId: "filter",
      columns: [...dimsForApi.map((d) => d.id), ...metricFields.map((m) => m.id)],
      rows, rowCount: rows.length, elapsedMs: Date.now() - start,
      notes: [
        `模型「${model.name}」来自 API 源「${apiSource.name}」，经本地缓存+API直查取全维度明细（自动 slug 映射）`,
        ...res.notes,
      ],
    };
  }
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

// ─── transform/join 语义解析辅助（物理表名/列名由语义模型解析，不硬编码） ──────
// transform/join 是绑定固定模型的“分析配方”：模型 ID 为稳定语义锚点，
// 物理 schema.table 与列名一律经语义层解析，随模型定义变更自动跟随，杜绝裸字符串漂移。

/** transform/join 口径锚点模型 ID（投放渠道日指标 + 投放计划） */
const CHANNEL_DAILY_MODEL_ID = "semantic_model_channel_daily";
const CHANNEL_CAMPAIGN_MODEL_ID = "semantic_model_channel_campaigns";

/** 按语义模型 ID 定位模型（缺失即抛错，由 run 包装为算子失败） */
function modelById(modelId: string, models: SemanticModelDef[]): SemanticModelDef {
  const model = models.find((m) => m.id === modelId);
  if (!model) throw new Error(`语义模型缺失: ${modelId}`);
  return model;
}

/** 全限定物理表名（schema.table，由语义模型解析） */
function tableRef(model: SemanticModelDef): string {
  return `${model.schema}.${model.table}`;
}

/** 指标物理列名（按语义模型指标 id 解析） */
function metricColumn(model: SemanticModelDef, metricId: string): string {
  const metric = model.metrics.find((m) => m.id === metricId);
  if (!metric) throw new Error(`模型 ${model.id} 缺少指标 ${metricId}`);
  return metric.column;
}

/** 维度物理列名（按语义模型维度 id 解析） */
function dimensionColumn(model: SemanticModelDef, dimId: string): string {
  const dim = model.dimensions.find((d) => d.id === dimId);
  if (!dim) throw new Error(`模型 ${model.id} 缺少维度 ${dimId}`);
  return dim.column;
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

/** 构建归因派生指标月度 SQL（纯函数；物理表名/列名由语义模型解析，派生口径为算子内置分析配方） */
export function buildTransformSql(
  range: TimeRangeInput,
  models: SemanticModelDef[] = DEMO_SEMANTIC_MODELS,
): string {
  const model = modelById(CHANNEL_DAILY_MODEL_ID, models);
  const spend = metricColumn(model, "spend");
  const impressions = metricColumn(model, "impressions");
  const clicks = metricColumn(model, "clicks");
  const downloads = metricColumn(model, "downloads");
  const registrations = metricColumn(model, "registrations");
  const fdUsers = metricColumn(model, "fd_users");
  const rdUsers = metricColumn(model, "rd_users");
  const fdAmount = metricColumn(model, "fd_amount");
  const rdAmount = metricColumn(model, "rd_amount");
  const timeCol = model.timeColumn;
  const conditions = timeConditions(timeCol, range);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return `SELECT to_char(date_trunc('month', ${timeCol}), 'YYYY-MM') AS month,
       ROUND(SUM(${spend})::numeric, 2) AS spend,
       SUM(${impressions}) AS impressions,
       SUM(${clicks}) AS clicks,
       SUM(${downloads}) AS downloads,
       SUM(${registrations}) AS registrations,
       SUM(${fdUsers}) AS fd_users,
       SUM(${rdUsers}) AS rd_users,
       ROUND((SUM(${spend}) / NULLIF(SUM(${downloads}), 0))::numeric, 2) AS cpi,
       ROUND((1000.0 * SUM(${spend}) / NULLIF(SUM(${impressions}), 0))::numeric, 2) AS cpm,
       ROUND((100.0 * SUM(${clicks}) / NULLIF(SUM(${impressions}), 0))::numeric, 2) AS ctr_pct,
       ROUND((100.0 * SUM(${registrations}) / NULLIF(SUM(${clicks}), 0))::numeric, 2) AS click_to_reg_pct,
       ROUND((100.0 * SUM(${fdUsers}) / NULLIF(SUM(${registrations}), 0))::numeric, 2) AS fd_rate_pct,
       ROUND((100.0 * SUM(${rdUsers}) / NULLIF(SUM(${fdUsers}), 0))::numeric, 2) AS rd_rate_pct,
       ROUND(((SUM(${fdAmount}) + SUM(${rdAmount})) / NULLIF(SUM(${spend}), 0))::numeric, 2) AS roi
FROM ${tableRef(model)}
${where}
GROUP BY 1
ORDER BY 1`;
}

export async function runTransformOp(input: z.infer<typeof TransformInput>): Promise<OperatorRunResult> {
  const start = Date.now();
  const models = await runtimeSemanticModels();
  let sql: string;
  try {
    sql = buildTransformSql(input, models);
  } catch (error) {
    return failed("transform", error, start);
  }
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

/** 构建日汇总 × 投放计划的跨源关联 SQL（纯函数；两侧物理表名/列名均由语义模型解析） */
export function buildJoinSql(
  range: TimeRangeInput,
  models: SemanticModelDef[] = DEMO_SEMANTIC_MODELS,
): string {
  const daily = modelById(CHANNEL_DAILY_MODEL_ID, models);
  const campaign = modelById(CHANNEL_CAMPAIGN_MODEL_ID, models);
  // 关联键：两侧同名维度（投放渠道 × 承接端），CTE 输出统一别名为维度 id，外层据此 JOIN
  const dChannel = dimensionColumn(daily, "ad_channel");
  const dPlatform = dimensionColumn(daily, "platform");
  const cChannel = dimensionColumn(campaign, "ad_channel");
  const cPlatform = dimensionColumn(campaign, "platform");
  // actual 侧（日汇总）指标列
  const dSpend = metricColumn(daily, "spend");
  const dDownloads = metricColumn(daily, "downloads");
  const dFdUsers = metricColumn(daily, "fd_users");
  const dRdUsers = metricColumn(daily, "rd_users");
  // plan 侧（投放计划）指标列
  const cSpend = metricColumn(campaign, "total_spend");
  const cDownloads = metricColumn(campaign, "downloads");
  const cFdUsers = metricColumn(campaign, "fd_users");
  const cRdUsers = metricColumn(campaign, "rd_users");
  const conditions = timeConditions(daily.timeColumn, range);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return `WITH d AS (
  SELECT ${dChannel} AS ad_channel, ${dPlatform} AS platform,
         ROUND(SUM(${dSpend})::numeric, 2) AS actual_spend,
         SUM(${dDownloads}) AS actual_downloads,
         SUM(${dFdUsers}) AS actual_fd_users,
         SUM(${dRdUsers}) AS actual_rd_users
  FROM ${tableRef(daily)}
  ${where}
  GROUP BY ${dChannel}, ${dPlatform}
), c AS (
  SELECT ${cChannel} AS ad_channel, ${cPlatform} AS platform,
         ROUND(SUM(${cSpend})::numeric, 2) AS plan_spend,
         SUM(${cDownloads}) AS plan_downloads,
         SUM(${cFdUsers}) AS plan_fd_users,
         SUM(${cRdUsers}) AS plan_rd_users
  FROM ${tableRef(campaign)}
  GROUP BY ${cChannel}, ${cPlatform}
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
  const models = await runtimeSemanticModels();
  let sql: string;
  try {
    sql = buildJoinSql(input, models);
  } catch (error) {
    return failed("join", error, start);
  }
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

// ─── API 响应体解析（统一取数分流层辅助，供 fetchApiReportRows 调用） ─────────
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

