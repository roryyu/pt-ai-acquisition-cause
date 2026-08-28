import { z } from "zod";

/**
 * 统一语义层（design.md 4.1）
 *
 * 语义查询转译链路（design.md 4.1.3）：
 *   自然语言问题
 *     → LLM 语义解析 → SemanticQueryV1（结构化意图）
 *     → 校验（指标/维度白名单）
 *     → SQL 转译（针对 PostgreSQL 数据源）
 *     → 只读执行 → 结果集 → 洞察生成
 */

// ─── SemanticQuery Schema（design.md 4.1.3 原文） ─────────────────────────────

export const SemanticQueryV1Schema = z.object({
  intent: z.enum(["query", "compare", "trend", "breakdown", "anomaly", "forecast"]),
  metrics: z.array(
    z.object({
      /** 指标表达式：聚合列（如 gmv/orders/active_users）或派生（如 conversion_rate） */
      metricId: z.string().min(1),
      alias: z.string().optional(),
    }),
  ).min(1),
  dimensions: z.array(
    z.object({
      /** 分组维度列（如 region/channel/category/stat_date） */
      dimensionId: z.string().min(1),
      /** 时间粒度：day/week/month/quarter/year */
      granularity: z.string().optional(),
    }),
  ).default([]),
  filters: z.array(
    z.object({
      field: z.string().min(1),
      operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "like", "between"]),
      value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
    }),
  ).default([]),
  timeRange: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    granularity: z.string().optional(),
  }).default({}),
  sort: z.array(
    z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) }),
  ).optional(),
  limit: z.number().int().positive().max(2000).optional(),
});

export type SemanticQueryV1 = z.infer<typeof SemanticQueryV1Schema>;

// ─── 语义模型：物理表 → 业务实体映射 ──────────────────────────────────────────

/** 指标字段定义：物理列 + 聚合方式 */
export interface MetricField {
  id: string;
  name: string;
  column: string;
  agg: "sum" | "avg" | "count" | "max" | "min" | "none";
  unit?: string;
  description: string;
}

/** 维度字段定义 */
export interface DimensionField {
  id: string;
  name: string;
  column: string;
  values?: string[];
  description: string;
}

/** 语义模型：一张物理表的业务视图 */
export interface SemanticModelDef {
  id: string;
  name: string;
  schema: string;
  table: string;
  timeColumn: string;
  metrics: MetricField[];
  dimensions: DimensionField[];
  description: string;
}

/**
 * 内置语义模型（demo 数据集，design.md 6.4.2 SemanticModelV1）
 * 由 scripts/seed-demo-data.ts 生成，指标与维度对齐业务口径
 */
export const DEMO_SEMANTIC_MODELS: SemanticModelDef[] = [
  {
    id: "semantic_model_daily_metrics",
    name: "经营日指标",
    schema: "demo",
    table: "daily_metrics",
    timeColumn: "stat_date",
    description: "区域×渠道×日 粒度的经营核心指标，覆盖 GMV、订单、用户、转化率",
    metrics: [
      { id: "gmv", name: "GMV", column: "gmv", agg: "sum", unit: "元", description: "商品交易总额" },
      { id: "orders", name: "订单量", column: "orders", agg: "sum", unit: "单", description: "支付订单总数" },
      { id: "active_users", name: "活跃用户", column: "active_users", agg: "sum", unit: "人", description: "日活用户数（按天累加）" },
      { id: "new_users", name: "新增用户", column: "new_users", agg: "sum", unit: "人", description: "新注册用户数" },
      { id: "conversion_rate", name: "转化率", column: "conversion_rate", agg: "avg", unit: "%", description: "下单用户/活跃用户（平均值口径）" },
      { id: "avg_order_value", name: "客单价", column: "avg_order_value", agg: "avg", unit: "元", description: "平均订单价值" },
    ],
    dimensions: [
      { id: "region", name: "区域", column: "region", values: ["华东", "华北", "华南", "华中", "西南", "西北", "东北"], description: "销售大区" },
      { id: "channel", name: "渠道", column: "channel", values: ["app", "miniapp", "web", "offline"], description: "销售渠道" },
      { id: "stat_date", name: "日期", column: "stat_date", description: "统计日期" },
    ],
  },
  {
    id: "semantic_model_orders",
    name: "订单明细",
    schema: "demo",
    table: "orders",
    timeColumn: "created_at",
    description: "订单粒度明细（抽样），支持类目/状态分析与退款率计算",
    metrics: [
      { id: "order_count", name: "订单数", column: "id", agg: "count", unit: "单", description: "订单条数" },
      { id: "order_amount", name: "订单金额", column: "amount", agg: "sum", unit: "元", description: "订单金额合计" },
      { id: "quantity", name: "件数", column: "quantity", agg: "sum", unit: "件", description: "购买件数" },
      { id: "refund_rate", name: "退款率", column: "id", agg: "count", description: "需要配合 status='refunded' 过滤计算" },
    ],
    dimensions: [
      { id: "region", name: "区域", column: "region", description: "下单区域" },
      { id: "channel", name: "渠道", column: "channel", values: ["app", "miniapp", "web", "offline"], description: "下单渠道" },
      { id: "category", name: "类目", column: "category", values: ["美妆", "3C数码", "服饰", "食品", "家居", "运动户外"], description: "商品类目" },
      { id: "status", name: "订单状态", column: "status", values: ["paid", "refunded", "cancelled"], description: "订单状态" },
      { id: "created_at", name: "下单时间", column: "created_at", description: "订单创建时间" },
    ],
  },
  {
    id: "semantic_model_products",
    name: "商品维表",
    schema: "demo",
    table: "products",
    timeColumn: "id",
    description: "商品基础信息（类目/价格/成本），支持毛利与价格带分析",
    metrics: [
      { id: "product_count", name: "商品数", column: "id", agg: "count", unit: "个", description: "商品数量" },
      { id: "avg_price", name: "均价", column: "price", agg: "avg", unit: "元", description: "平均售价" },
      { id: "avg_cost", name: "平均成本", column: "cost", agg: "avg", unit: "元", description: "平均成本" },
    ],
    dimensions: [
      { id: "category", name: "类目", column: "category", values: ["美妆", "3C数码", "服饰", "食品", "家居", "运动户外"], description: "商品类目" },
    ],
  },
  {
    id: "semantic_model_channel_daily",
    name: "投放渠道日指标",
    schema: "demo",
    table: "channel_daily_metrics",
    timeColumn: "stat_date",
    description: "投放渠道×承接端×市场×日 粒度的买量漏斗指标，覆盖花费、展示、点击、下载、注册、FD（首次充钱）、RD（再次召回充钱）",
    metrics: [
      { id: "spend", name: "投放花费", column: "spend", agg: "sum", unit: "美元", description: "广告消耗金额" },
      { id: "impressions", name: "展示量", column: "impressions", agg: "sum", unit: "次", description: "广告展示次数" },
      { id: "clicks", name: "点击量", column: "clicks", agg: "sum", unit: "次", description: "广告点击次数" },
      { id: "downloads", name: "下载量", column: "downloads", agg: "sum", unit: "次", description: "app 端应用下载次数（web 端为 0）" },
      { id: "registrations", name: "注册数", column: "registrations", agg: "sum", unit: "人", description: "新增注册用户数" },
      { id: "fd_users", name: "FD用户数", column: "fd_users", agg: "sum", unit: "人", description: "首次充钱用户数（First Deposit）" },
      { id: "fd_amount", name: "FD金额", column: "fd_amount", agg: "sum", unit: "美元", description: "首次充钱金额合计" },
      { id: "rd_users", name: "RD用户数", column: "rd_users", agg: "sum", unit: "人", description: "再次召回充钱用户数（Re-Deposit）" },
      { id: "rd_amount", name: "RD金额", column: "rd_amount", agg: "sum", unit: "美元", description: "召回充钱金额合计" },
    ],
    dimensions: [
      { id: "ad_channel", name: "投放渠道", column: "ad_channel", values: ["Meta", "X", "TikTok"], description: "广告投放媒体渠道" },
      { id: "platform", name: "承接端", column: "platform", values: ["app", "web"], description: "流量承接端：app 下载 / web 网页落地页" },
      { id: "region", name: "市场", column: "region", values: ["北美", "欧洲", "东南亚", "拉美", "日韩"], description: "投放目标市场" },
      { id: "stat_date", name: "日期", column: "stat_date", description: "统计日期" },
    ],
  },
  {
    id: "semantic_model_channel_campaigns",
    name: "投放计划",
    schema: "demo",
    table: "channel_campaigns",
    timeColumn: "start_date",
    description: "投放计划维表与累计效果（渠道×承接端×投放目标），含累计花费/下载/FD/RD",
    metrics: [
      { id: "campaign_count", name: "计划数", column: "id", agg: "count", unit: "个", description: "投放计划数量" },
      { id: "total_spend", name: "累计花费", column: "total_spend", agg: "sum", unit: "美元", description: "计划累计投放花费" },
      { id: "downloads", name: "累计下载", column: "downloads", agg: "sum", unit: "次", description: "计划累计下载量" },
      { id: "fd_users", name: "累计FD用户", column: "fd_users", agg: "sum", unit: "人", description: "计划累计首次充钱用户" },
      { id: "rd_users", name: "累计RD用户", column: "rd_users", agg: "sum", unit: "人", description: "计划累计召回充钱用户" },
    ],
    dimensions: [
      { id: "ad_channel", name: "投放渠道", column: "ad_channel", values: ["Meta", "X", "TikTok"], description: "广告投放媒体渠道" },
      { id: "platform", name: "承接端", column: "platform", values: ["app", "web"], description: "流量承接端" },
      { id: "objective", name: "投放目标", column: "objective", values: ["拉新下载", "首次充值", "召回充值"], description: "计划优化目标" },
      { id: "status", name: "计划状态", column: "status", values: ["active", "paused"], description: "计划投放状态" },
      { id: "start_date", name: "启动日期", column: "start_date", description: "计划启动日期" },
    ],
  },
];

/** 汇总模型的可查询列（供 NL 解析白名单校验，默认仅内置模型） */
export function semanticContextSummary(models: SemanticModelDef[] = DEMO_SEMANTIC_MODELS): string {
  return models.map((m) => {
    const metrics = m.metrics.map((x) => `${x.id}(${x.name}, ${x.agg}, ${x.description})`).join("; ");
    const dims = m.dimensions.map((x) => `${x.id}(${x.name}${x.values ? `, 取值: ${x.values.join("/")}` : ""})`).join("; ");
    return `模型「${m.name}」表 ${m.schema}.${m.table}（${m.description}）\n  指标: ${metrics}\n  维度: ${dims}\n  时间列: ${m.timeColumn}`;
  }).join("\n\n");
}

// ─── SemanticQuery → SQL 转译 ─────────────────────────────────────────────────

const TIME_GRANULARITY_SQL: Record<string, string> = {
  day: "to_char({col}, 'YYYY-MM-DD')",
  week: "to_char(date_trunc('week', {col}), 'YYYY-MM-DD')",
  month: "to_char({col}, 'YYYY-MM')",
  quarter: "to_char({col}, 'YYYY-\"Q\"Q')",
  year: "to_char({col}, 'YYYY')",
};

export interface TranslatedQuery {
  model: SemanticModelDef;
  sql: string;
  columns: string[];
  notes: string[];
}

/**
 * 将 SemanticQuery 转译为只读 SQL（PostgreSQL 方言）
 * 转译规则：
 * - 指标 → 聚合表达式（sum/avg/count/max/min）
 * - 维度 → GROUP BY 列（时间维度按粒度截断）
 * - 过滤 → WHERE 条件（操作符映射 + 参数内联前做类型净化）
 * - 时间范围 → 时间列 BETWEEN
 * models 缺省为内置模型；调用方可传入内置 + DB 自定义的全量模型列表
 */
export function translateToSql(
  query: SemanticQueryV1,
  models: SemanticModelDef[] = DEMO_SEMANTIC_MODELS,
): TranslatedQuery {
  const notes: string[] = [];

  // 1. 定位主模型：找第一个能承载全部指标/维度的模型（按指标名匹配）
  const model = findModel(query, models);
  if (!model) {
    throw new Error("无法定位语义模型：指标/维度未注册于任何语义模型");
  }

  // 2. SELECT 列
  const selectParts: string[] = [];
  const groupParts: string[] = [];

  for (const dim of query.dimensions) {
    const dimDef = model.dimensions.find((d) => d.id === dim.dimensionId || d.column === dim.dimensionId);
    if (!dimDef) {
      notes.push(`维度 ${dim.dimensionId} 不在模型 ${model.name} 中，已忽略`);
      continue;
    }
    const gran = dim.granularity ?? query.timeRange.granularity;
    if (dimDef.column === model.timeColumn && gran && TIME_GRANULARITY_SQL[gran]) {
      const expr = TIME_GRANULARITY_SQL[gran]!.replace("{col}", dimDef.column);
      selectParts.push(`${expr} AS ${quoteIdent(dimDef.id)}`);
      groupParts.push(expr);
    } else {
      selectParts.push(quoteIdent(dimDef.column));
      groupParts.push(quoteIdent(dimDef.column));
    }
  }

  for (const m of query.metrics) {
    const metricDef = model.metrics.find((x) => x.id === m.metricId || x.column === m.metricId);
    if (!metricDef) {
      notes.push(`指标 ${m.metricId} 不在模型 ${model.name} 中，已忽略`);
      continue;
    }
    const alias = quoteIdent(m.alias ?? metricDef.id);
    const expr =
      metricDef.agg === "count"
        ? `COUNT(${quoteIdent(metricDef.column)})`
        : metricDef.agg === "none"
          ? quoteIdent(metricDef.column)
          : `${metricDef.agg.toUpperCase()}(${quoteIdent(metricDef.column)})`;
    selectParts.push(`${expr} AS ${alias}`);
  }

  if (selectParts.length === 0) {
    throw new Error("SELECT 列为空：指标与维度均未命中语义模型");
  }

  // 3. WHERE 条件
  const conditions: string[] = [];
  for (const f of query.filters) {
    const column = resolveColumn(model, f.field);
    if (!column) {
      notes.push(`过滤字段 ${f.field} 无法解析，已忽略`);
      continue;
    }
    conditions.push(buildCondition(column, f.operator, f.value, notes));
  }
  // 时间范围
  const timeCol = model.timeColumn;
  if (query.timeRange.from) {
    conditions.push(`${quoteIdent(timeCol)} >= ${sqlString(query.timeRange.from)}`);
  }
  if (query.timeRange.to) {
    conditions.push(`${quoteIdent(timeCol)} <= ${sqlString(query.timeRange.to)}`);
  }

  // 4. WHERE → GROUP BY → ORDER BY → LIMIT（标准 SQL 子句顺序）
  let sql = `SELECT ${selectParts.join(", ")}\nFROM ${quoteIdent(model.schema)}.${quoteIdent(model.table)}`;
  if (conditions.length > 0) sql += `\nWHERE ${conditions.join(" AND ")}`;
  if (groupParts.length > 0) sql += `\nGROUP BY ${groupParts.join(", ")}`;
  if (query.sort && query.sort.length > 0) {
    const orderParts = query.sort
      .map((s) => {
        const col = resolveColumn(model, s.field) ?? s.field;
        return `${quoteIdent(col)} ${s.direction.toUpperCase()}`;
      })
      .filter((p) => !p.includes("unknown"));
    if (orderParts.length > 0) sql += `\nORDER BY ${orderParts.join(", ")}`;
  }
  sql += `\nLIMIT ${query.limit ?? 200}`;

  return { model, sql, columns: selectParts.map((p) => p.split(" AS ").pop() ?? p), notes };
}

function findModel(query: SemanticQueryV1, models: SemanticModelDef[]): SemanticModelDef | null {
  const metricIds = new Set(query.metrics.map((m) => m.metricId));
  const dimIds = new Set(query.dimensions.map((d) => d.dimensionId));
  let best: { model: SemanticModelDef; score: number } | null = null;
  for (const model of models) {
    let score = 0;
    for (const id of metricIds) {
      if (model.metrics.some((m) => m.id === id || m.column === id)) score += 2;
    }
    for (const id of dimIds) {
      if (model.dimensions.some((d) => d.id === id || d.column === id)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { model, score };
  }
  return best?.model ?? null;
}

function resolveColumn(model: SemanticModelDef, field: string): string | null {
  const metric = model.metrics.find((m) => m.id === field || m.column === field);
  if (metric) return metric.column;
  const dim = model.dimensions.find((d) => d.id === field || d.column === field);
  if (dim) return dim.column;
  return null;
}

function buildCondition(column: string, operator: string, value: string | number | Array<string | number>, notes: string[]): string {
  const col = quoteIdent(column);
  // 单值操作符：数组值取首元素
  const scalar = Array.isArray(value) ? value[0] : value;
  switch (operator) {
    case "eq": {
      if (scalar === undefined) break;
      return `${col} = ${sqlValue(scalar)}`;
    }
    case "neq": {
      if (scalar === undefined) break;
      return `${col} <> ${sqlValue(scalar)}`;
    }
    case "gt": {
      if (scalar === undefined) break;
      return `${col} > ${sqlValue(scalar)}`;
    }
    case "gte": {
      if (scalar === undefined) break;
      return `${col} >= ${sqlValue(scalar)}`;
    }
    case "lt": {
      if (scalar === undefined) break;
      return `${col} < ${sqlValue(scalar)}`;
    }
    case "lte": {
      if (scalar === undefined) break;
      return `${col} <= ${sqlValue(scalar)}`;
    }
    case "in": {
      const list = Array.isArray(value) ? value : [value];
      if (list.length > 0) {
        return `${col} IN (${list.map((v) => sqlValue(v)).join(", ")})`;
      }
      break;
    }
    case "like":
      if (scalar === undefined) break;
      return `${col} ILIKE ${sqlString(`%${String(scalar)}%`)}`;
    case "between": {
      const list = Array.isArray(value) ? value : [value];
      const lo = list[0];
      const hi = list[1];
      if (lo !== undefined && hi !== undefined) {
        return `${col} BETWEEN ${sqlValue(lo)} AND ${sqlValue(hi)}`;
      }
      break;
    }
    default:
      notes.push(`未知操作符 ${operator}，已忽略`);
      return "TRUE";
  }
  notes.push(`过滤值无效（字段 ${column}，操作符 ${operator}），已忽略`);
  return "TRUE";
}

/** SQL 字符串字面量（净化：禁止引号逃逸） */
function sqlString(v: string): string {
  const safe = v.replace(/'/g, "''");
  return `'${safe}'`;
}

function sqlValue(v: string | number): string {
  return typeof v === "number" ? String(v) : sqlString(v);
}

/** SQL 标识符（净化：仅允许字母数字下划线） */
function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`非法标识符: ${name}`);
  }
  return `"${name}"`;
}
