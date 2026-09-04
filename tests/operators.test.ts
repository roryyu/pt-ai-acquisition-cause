import { beforeEach, describe, expect, it, vi } from "vitest";

// 算子测试：隔离 DB 与环境变量依赖（与 semantic-models.test.ts 同模式）
vi.mock("@/lib/env", () => ({
  env: {
    DATABASE_URL: "postgresql://localhost:5432/test?schema=cause",
    MODEL_GATEWAY_BASE_URL: "https://gateway.test/v1",
    MODEL_GATEWAY_API_KEY: "test-key",
    MODEL_GATEWAY_DEFAULT_MODEL: "test-model",
    MODEL_GATEWAY_TIMEOUT_MS: 30000,
  },
}));
vi.mock("@/lib/server/connectors/postgres", () => ({
  executeReadOnlyQuery: vi.fn(),
}));
// 算子层运行时语义模型：隔离 DB，固定返回内置演示模型（runtimeSemanticModels 走 model-store）
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/server/semantic/model-store", async () => {
  const { DEMO_SEMANTIC_MODELS } = await import("@/lib/server/semantic/semantic-query");
  return { listAllSemanticModels: vi.fn(async () => DEMO_SEMANTIC_MODELS) };
});
// 统一取数分流层：API 源经 listDataSources 定位、cachedRestRequest 直查（逐案 mock）
vi.mock("@/lib/server/connectors/datasources", () => ({
  listDataSources: vi.fn(async () => []),
}));
vi.mock("@/lib/server/connectors/api-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/connectors/api-cache")>();
  return { ...actual, cachedRestRequest: vi.fn() };
});

import {
  operatorMetricCatalog, operatorDimensionsForModel, aggExprOf, resolveMetricEntry,
  buildAggregateSql, buildTimeSeriesSql, buildAnomalySql,
  buildFilterSql, buildTransformSql, buildJoinSql,
  type OperatorDimensionEntry,
} from "@/lib/server/operators/data-operators";
import { runOperator, listOperators } from "@/lib/server/operators/registry";
import { executeReadOnlyQuery } from "@/lib/server/connectors/postgres";
import { listDataSources } from "@/lib/server/connectors/datasources";
import { cachedRestRequest } from "@/lib/server/connectors/api-cache";
import { listAllSemanticModels } from "@/lib/server/semantic/model-store";
import { DEMO_SEMANTIC_MODELS, type SemanticModelDef } from "@/lib/server/semantic/semantic-query";

const queryMock = vi.mocked(executeReadOnlyQuery);
const listDataSourcesMock = vi.mocked(listDataSources);
const cachedRestRequestMock = vi.mocked(cachedRestRequest);
const listAllModelsMock = vi.mocked(listAllSemanticModels);

beforeEach(() => {
  queryMock.mockReset();
});

// ─── 指标/维度目录（语义层驱动） ─────────────────────────────────────────────

describe("算子指标目录（语义层驱动）", () => {
  it("覆盖五个内置语义模型的核心指标", () => {
    const ids = operatorMetricCatalog().map((m) => m.id);
    for (const expected of ["gmv", "spend", "impressions", "fd_users", "rd_amount", "total_spend", "order_amount", "avg_price"]) {
      expect(ids).toContain(expected);
    }
  });

  it("跨模型同名指标不再遮蔽：各自以表名限定生成全局唯一 key，平等可独立寻址", () => {
    const catalog = operatorMetricCatalog();
    const downloads = catalog.filter((m) => m.id === "downloads");
    // 内置 channel_daily_metrics 与 channel_campaigns 均有 downloads，两者都保留、互不遮蔽
    expect(downloads).toHaveLength(2);
    expect(downloads.map((m) => m.key).sort()).toEqual([
      "channel_campaigns.downloads",
      "channel_daily_metrics.downloads",
    ]);
    // key 全局唯一
    const allKeys = catalog.map((m) => m.key);
    expect(new Set(allKeys).size).toBe(allKeys.length);
    // 裸 id 全局唯一时 key 即等于 id（spend 仅在 channel_daily_metrics）
    expect(catalog.find((m) => m.id === "spend")?.key).toBe("spend");
  });

  it("resolveMetricEntry：限定 id 精确命中、唯一裸 id 命中、同名裸 id 报多源歧义", () => {
    // 唯一裸 id 直接命中
    expect(resolveMetricEntry("spend", DEMO_SEMANTIC_MODELS).entry?.table).toBe("data.channel_daily_metrics");
    // 表名限定 id 精确命中对应来源（两个 downloads 各自可寻址）
    expect(resolveMetricEntry("channel_daily_metrics.downloads", DEMO_SEMANTIC_MODELS).entry?.modelId)
      .toBe("semantic_model_channel_daily");
    expect(resolveMetricEntry("channel_campaigns.downloads", DEMO_SEMANTIC_MODELS).entry?.modelId)
      .toBe("semantic_model_channel_campaigns");
    // 同名裸 id 命中多源 → 明确歧义错误，列出各限定 id（不静默偏向任一源）
    const ambiguous = resolveMetricEntry("downloads", DEMO_SEMANTIC_MODELS);
    expect(ambiguous.entry).toBeUndefined();
    expect(ambiguous.error).toContain("存在于多个数据源");
    expect(ambiguous.error).toContain("channel_daily_metrics.downloads");
    expect(ambiguous.error).toContain("channel_campaigns.downloads");
    // 完全无命中
    expect(resolveMetricEntry("nope", DEMO_SEMANTIC_MODELS).error).toBe("未知指标: nope");
  });

  it("需配合过滤的指标（refund_rate）被排除", () => {
    const ids = operatorMetricCatalog().map((m) => m.id);
    expect(ids).not.toContain("refund_rate");
  });

  it("无日期时间列的模型指标标记 supportsTime=false", () => {
    const catalog = operatorMetricCatalog();
    expect(catalog.find((m) => m.id === "spend")?.supportsTime).toBe(true);
    expect(catalog.find((m) => m.id === "avg_price")?.supportsTime).toBe(false);
  });

  it("维度目录排除时间列", () => {
    const dims = operatorDimensionsForModel("semantic_model_channel_daily").map((d) => d.id);
    expect(dims).toEqual(["ad_channel", "platform", "region"]);
    expect(dims).not.toContain("stat_date");
  });

  it("聚合表达式按聚合方式生成", () => {
    expect(aggExprOf("sum", "spend")).toBe('SUM("spend")');
    expect(aggExprOf("avg", "conversion_rate")).toBe('AVG("conversion_rate")');
    expect(aggExprOf("count", "id")).toBe("COUNT(*)");
  });
});

// ─── SQL 构建：子句顺序与指标定位 ─────────────────────────────────────────────

/** 断言各子句在 SQL 中的出现顺序（固定模板顺序防线） */
function assertClauseOrder(sql: string, clauses: string[]) {
  let last = -1;
  for (const clause of clauses) {
    const idx = sql.indexOf(clause);
    expect(idx, `子句 ${clause} 应存在`).toBeGreaterThan(-1);
    expect(idx, `子句 ${clause} 顺序应在前者之后`).toBeGreaterThan(last);
    last = idx;
  }
}

const spendEntry = () => {
  const entry = operatorMetricCatalog().find((m) => m.id === "spend");
  if (!entry) throw new Error("spend 指标缺失");
  return entry;
};

/**
 * 自定义物理映射的语义模型（schema/table/column/timeColumn 均与内置不同），
 * 用于验证 transform/join 的物理表名与列名由语义层解析、而非硬编码内置名。
 */
const CUSTOM_CHANNEL_DAILY: SemanticModelDef = {
  id: "semantic_model_channel_daily",
  name: "投放渠道日指标",
  schema: "analytics",
  table: "channel_facts",
  timeColumn: "event_date",
  description: "",
  metrics: [
    { id: "spend", name: "花费", column: "ad_spend", agg: "sum", description: "" },
    { id: "impressions", name: "展示", column: "imps", agg: "sum", description: "" },
    { id: "clicks", name: "点击", column: "clk", agg: "sum", description: "" },
    { id: "downloads", name: "下载", column: "dl", agg: "sum", description: "" },
    { id: "registrations", name: "注册", column: "regs", agg: "sum", description: "" },
    { id: "fd_users", name: "FD用户", column: "fd_u", agg: "sum", description: "" },
    { id: "rd_users", name: "RD用户", column: "rd_u", agg: "sum", description: "" },
    { id: "fd_amount", name: "FD金额", column: "fd_amt", agg: "sum", description: "" },
    { id: "rd_amount", name: "RD金额", column: "rd_amt", agg: "sum", description: "" },
  ],
  dimensions: [
    { id: "ad_channel", name: "渠道", column: "channel_name", description: "" },
    { id: "platform", name: "承接端", column: "plat", description: "" },
  ],
};

const CUSTOM_CHANNEL_CAMPAIGN: SemanticModelDef = {
  id: "semantic_model_channel_campaigns",
  name: "投放计划",
  schema: "analytics",
  table: "campaign_facts",
  timeColumn: "start_date",
  description: "",
  metrics: [
    { id: "total_spend", name: "累计花费", column: "cum_spend", agg: "sum", description: "" },
    { id: "downloads", name: "累计下载", column: "dl", agg: "sum", description: "" },
    { id: "fd_users", name: "累计FD", column: "fd_u", agg: "sum", description: "" },
    { id: "rd_users", name: "累计RD", column: "rd_u", agg: "sum", description: "" },
  ],
  dimensions: [
    { id: "ad_channel", name: "渠道", column: "channel_name", description: "" },
    { id: "platform", name: "承接端", column: "plat", description: "" },
  ],
};

describe("算子 SQL 构建", () => {
  it("aggregate：子句顺序固定且指标定位到所属模型表", () => {
    const entry = spendEntry();
    const dim = operatorDimensionsForModel(entry.modelId)[0];
    if (!dim) throw new Error("维度缺失");
    const sql = buildAggregateSql(entry, dim, { metric: "spend", groupBy: dim.id, from: "2026-01-01", to: "2026-08-31" });
    assertClauseOrder(sql, ["SELECT", "FROM data.channel_daily_metrics", "WHERE", "GROUP BY", "ORDER BY", "LIMIT"]);
    expect(sql).toContain('SUM("spend")');
    expect(sql).toContain(`"stat_date" >= '2026-01-01'`);
    expect(sql).toContain(`"stat_date" <= '2026-08-31'`);
  });

  it("aggregate：维度值过滤做单引号转义", () => {
    const entry = spendEntry();
    const dim: OperatorDimensionEntry = { id: "ad_channel", name: "投放渠道", column: "ad_channel", description: "" };
    const sql = buildAggregateSql(entry, dim, { metric: "spend", groupBy: "ad_channel", dimensionValue: "O'Brien" });
    expect(sql).toContain(`"ad_channel" = 'O''Brien'`);
  });

  it("timeseries：按月聚合并计算同比环比（月粒度 LAG(12)）", () => {
    const sql = buildTimeSeriesSql(spendEntry(), { metric: "spend", granularity: "month" });
    expect(sql).toContain("date_trunc('month', \"stat_date\")");
    expect(sql).toContain("LAG(value, 1)");
    expect(sql).toContain("LAG(value, 12)");
    assertClauseOrder(sql, ["WITH series AS", "FROM data.channel_daily_metrics", "SELECT to_char"]);
  });

  it("timeseries：周粒度同比滞后为 52", () => {
    const sql = buildTimeSeriesSql(spendEntry(), { metric: "spend", granularity: "week" });
    expect(sql).toContain("LAG(value, 52)");
  });

  it("anomaly：滚动窗口 Z-Score 与自定义阈值", () => {
    const sql = buildAnomalySql(spendEntry(), { metric: "spend", threshold: 3 });
    expect(sql).toContain("ROWS BETWEEN 28 PRECEDING AND CURRENT ROW");
    expect(sql).toContain("> 3 THEN");
    expect(sql).toContain("NULLS LAST");
  });

  it("filter：按模型全维度分组并注入维度值过滤", () => {
    const model = DEMO_SEMANTIC_MODELS.find((m) => m.id === "semantic_model_channel_daily");
    if (!model) throw new Error("模型缺失");
    const dims = operatorDimensionsForModel(model.id);
    const metricExprs = [{ id: "spend", expr: 'SUM("spend")' }];
    const sql = buildFilterSql(model, dims, metricExprs, { ad_channel: "Meta" }, { from: "2026-06-01" });
    assertClauseOrder(sql, ["SELECT", "FROM data.channel_daily_metrics", "WHERE", "GROUP BY", "ORDER BY", "LIMIT"]);
    expect(sql).toContain(`"ad_channel" = 'Meta'`);
    expect(sql).toContain('GROUP BY "ad_channel", "platform", "region"');
  });

  it("transform：输出归因派生指标（CPI/CPM/CTR/FD 率/RD 率/ROI）", () => {
    const sql = buildTransformSql({});
    expect(sql).toContain("AS cpi");
    expect(sql).toContain("AS cpm");
    expect(sql).toContain("AS ctr_pct");
    expect(sql).toContain("AS fd_rate_pct");
    expect(sql).toContain("AS rd_rate_pct");
    expect(sql).toContain("AS roi");
    expect(sql).toContain("SUM(fd_amount) + SUM(rd_amount)");
    assertClauseOrder(sql, ["SELECT", "FROM data.channel_daily_metrics", "GROUP BY", "ORDER BY"]);
  });

  it("join：日汇总与投放计划按渠道×承接端关联", () => {
    const sql = buildJoinSql({ from: "2026-01-01" });
    expect(sql).toContain("FROM data.channel_daily_metrics");
    expect(sql).toContain("FROM data.channel_campaigns");
    expect(sql).toContain("JOIN c ON c.ad_channel = d.ad_channel AND c.platform = d.platform");
    expect(sql).toContain(`"stat_date" >= '2026-01-01'`);
  });

  it("transform：物理表名/列名由语义模型解析（自定义映射 → SQL 跟随，非硬编码）", () => {
    const sql = buildTransformSql({ from: "2026-01-01" }, [CUSTOM_CHANNEL_DAILY]);
    expect(sql).toContain("FROM analytics.channel_facts");          // schema.table 随模型
    expect(sql).toContain("date_trunc('month', event_date)");        // 时间列随模型
    expect(sql).toContain("SUM(ad_spend)");                          // spend → ad_spend
    expect(sql).toContain("SUM(fd_amt) + SUM(rd_amt)");              // fd_amount/rd_amount → fd_amt/rd_amt
    expect(sql).toContain(`"event_date" >= '2026-01-01'`);
    expect(sql).not.toContain("data.channel_daily_metrics");         // 不再硬编码内置物理名
  });

  it("join：两侧物理表名/列名由语义模型解析（自定义映射 → SQL 跟随，非硬编码）", () => {
    const sql = buildJoinSql({}, [CUSTOM_CHANNEL_DAILY, CUSTOM_CHANNEL_CAMPAIGN]);
    expect(sql).toContain("FROM analytics.channel_facts");
    expect(sql).toContain("FROM analytics.campaign_facts");
    expect(sql).toContain("SELECT channel_name AS ad_channel, plat AS platform"); // 维度列解析 + 稳定别名
    expect(sql).toContain("SUM(cum_spend)");                          // total_spend → cum_spend
    // 外层 JOIN 仍按稳定别名 ad_channel/platform 关联（与物理列名解耦）
    expect(sql).toContain("JOIN c ON c.ad_channel = d.ad_channel AND c.platform = d.platform");
    expect(sql).not.toContain("data.channel_campaigns");
  });
});

// ─── registry runOperator：校验失败路径（不触达 DB） ─────────────────────────

describe("runOperator 参数校验与执行", () => {
  it("未知算子返回错误且不执行", async () => {
    const result = await runOperator("nope", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("算子不存在");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("指标不在目录内被运行时拦截（Schema 已放宽为字符串以支持自定义模型）", async () => {
    const result = await runOperator("aggregate", { metric: "gmv_v2", groupBy: "region" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未知指标: gmv_v2");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("同名指标用裸 id 调用算子时报多源歧义（不静默偏向任一源）", async () => {
    const result = await runOperator("aggregate", { metric: "downloads", groupBy: "ad_channel" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("存在于多个数据源");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("groupBy 不属于指标所属模型时返回明确错误", async () => {
    const result = await runOperator("aggregate", { metric: "spend", groupBy: "category" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("无维度 category");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("无日期时间列的指标不允许时序分析", async () => {
    const result = await runOperator("timeseries", { metric: "avg_price" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("无日期时间列，不支持时序分析");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("合法输入透传执行并包装结果", async () => {
    queryMock.mockResolvedValue({
      columns: ["ad_channel", "spend"],
      rows: [{ ad_channel: "Meta", spend: 123.45 }],
      rowCount: 1,
      elapsedMs: 5,
      truncated: false,
    } as never);
    const result = await runOperator("aggregate", { metric: "spend", groupBy: "ad_channel" });
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.sql).toContain("FROM data.channel_daily_metrics");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("注册表包含六个数据算子（全 SQL 引擎，API 源经统一取数分流层自动路由）与六个研究算子", () => {
    const operators = listOperators();
    expect(operators.filter((o) => o.category === "data")).toHaveLength(6);
    expect(operators.filter((o) => o.category === "research")).toHaveLength(6);
    for (const op of operators.filter((o) => o.category === "data")) {
      expect(op.engine).toBe("sql");
    }
  });
});

// ─── 统一取数分流层：API 源自动本地缓存+API 直查，PG 源本地 SQL（20260904 架构重构） ──

/** 与 scripts/sync-adjust-data.ts 挂载的 Adjust 语义模型同构（含 dataSourceId + apiSlug 标注） */
const ADJUST_MODEL: SemanticModelDef = {
  id: "semantic_model_adjust_daily",
  name: "Adjust 投放日指标",
  schema: "data",
  table: "adjust_daily_metrics",
  timeColumn: "stat_date",
  description: "",
  dataSourceId: "data_source_adjust",
  metrics: [
    { id: "installs", name: "安装量", column: "installs", agg: "sum", description: "" },
    { id: "register_cnt", name: "注册数", column: "register_cnt", agg: "sum", apiSlug: "register_events", description: "" },
    { id: "first_deposit_cnt", name: "首存数", column: "first_deposit_cnt", agg: "sum", apiSlug: "firstdeposit_events", description: "" },
  ],
  dimensions: [
    { id: "network", name: "投放渠道", column: "network", description: "" },
    { id: "country_code", name: "国家码", column: "country_code", description: "" },
    { id: "stat_date", name: "日期", column: "stat_date", apiSlug: "day", description: "" },
  ],
};

const ADJUST_SOURCE = {
  id: "data_source_adjust",
  name: "Adjust 报告服务",
  type: "api",
  apiConfig: { endpoint: "https://rs.adjust.com/reports-service", protocol: "rest", authType: "bearer", authToken: "token" },
  builtin: false,
  status: "active",
} as never;

describe("统一取数分流层（API 源自动本地缓存+API 直查，PG 源本地 SQL）", () => {
  beforeEach(() => {
    listAllModelsMock.mockResolvedValue([...DEMO_SEMANTIC_MODELS, ADJUST_MODEL] as never);
    listDataSourcesMock.mockResolvedValue([ADJUST_SOURCE]);
    cachedRestRequestMock.mockReset();
  });

  it("aggregate：API 源指标经 cachedRestRequest 直查，自动用上游 slug，列名映射回本地 id，不触达本地 SQL", async () => {
    cachedRestRequestMock.mockResolvedValue({
      status: 200, contentType: "text/csv",
      body: "network,register_events\nweb,42\ngadmobe-apk,7\n",
      elapsedMs: 500, truncated: false, fromCache: false, cacheState: "miss",
    } as never);
    const result = await runOperator("aggregate", {
      metric: "register_cnt", groupBy: "network", from: "2026-09-03", to: "2026-09-03",
    });
    expect(result.ok).toBe(true);
    const [config, request, options] = cachedRestRequestMock.mock.calls[0]!;
    expect(config.endpoint).toBe("https://rs.adjust.com/reports-service");
    expect(request.path).toBe("csv_report");
    expect(request.params?.["metrics"]).toBe("register_events");   // 本地 register_cnt → 上游 slug
    expect(request.params?.["dimensions"]).toBe("network");
    expect(request.params?.["date_period"]).toBe("2026-09-03:2026-09-03");
    expect(options.sourceId).toBe("data_source_adjust");
    expect(queryMock).not.toHaveBeenCalled();                       // 未走本地 SQL
    expect(result.columns).toEqual(["network", "register_cnt"]);    // 列名映射回本地 id
    expect(result.rows[0]).toEqual({ network: "web", register_cnt: 42 });
  });

  it("filter：API 源模型经 cachedRestRequest 取全维度明细，slug 自动映射回本地 id", async () => {
    cachedRestRequestMock.mockResolvedValue({
      status: 200, contentType: "text/csv",
      body: "network,country_code,installs,register_events,firstdeposit_events\nweb,us,100,42,7\n",
      elapsedMs: 400, truncated: false, fromCache: false, cacheState: "miss",
    } as never);
    const result = await runOperator("filter", {
      model: "semantic_model_adjust_daily", from: "2026-09-03", to: "2026-09-03",
    });
    expect(result.ok).toBe(true);
    const [, request] = cachedRestRequestMock.mock.calls[0]!;
    expect(request.params?.["dimensions"]).toBe("network,country_code");
    expect(request.params?.["metrics"]).toBe("installs,register_events,firstdeposit_events");
    expect(queryMock).not.toHaveBeenCalled();
    expect(result.columns).toEqual(["network", "country_code", "installs", "register_cnt", "first_deposit_cnt"]);
    expect(result.rows[0]).toEqual({ network: "web", country_code: "us", installs: 100, register_cnt: 42, first_deposit_cnt: 7 });
  });

  it("命中查询缓存（fresh）时 notes 标注未请求上游", async () => {
    cachedRestRequestMock.mockResolvedValue({
      status: 200, contentType: "text/csv", body: "network,installs\nweb,100\n",
      elapsedMs: 5, truncated: false, fromCache: true, cacheState: "fresh",
    } as never);
    const result = await runOperator("aggregate", { metric: "installs", groupBy: "network" });
    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toContain("命中查询缓存（fresh）");
  });

  it("PG 源指标仍走本地 SQL，不触达 cachedRestRequest（分流互不干扰）", async () => {
    queryMock.mockResolvedValue({
      columns: ["ad_channel", "spend"], rows: [{ ad_channel: "Meta", spend: 123.45 }],
      rowCount: 1, elapsedMs: 5, truncated: false,
    } as never);
    const result = await runOperator("aggregate", { metric: "spend", groupBy: "ad_channel" });
    expect(result.ok).toBe(true);
    expect(result.sql).toContain("FROM data.channel_daily_metrics");
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(cachedRestRequestMock).not.toHaveBeenCalled();
  });
});
