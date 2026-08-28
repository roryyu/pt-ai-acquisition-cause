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

import {
  operatorMetricCatalog, operatorDimensionsForModel, aggExprOf,
  buildAggregateSql, buildTimeSeriesSql, buildAnomalySql,
  buildFilterSql, buildTransformSql, buildJoinSql,
  type OperatorDimensionEntry,
} from "@/lib/server/operators/data-operators";
import { runOperator, listOperators } from "@/lib/server/operators/registry";
import { executeReadOnlyQuery } from "@/lib/server/connectors/postgres";
import { DEMO_SEMANTIC_MODELS } from "@/lib/server/semantic/semantic-query";

const queryMock = vi.mocked(executeReadOnlyQuery);

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

  it("跨模型同名指标去重后归属首个模型（日粒度优先）", () => {
    const catalog = operatorMetricCatalog();
    const downloads = catalog.filter((m) => m.id === "downloads");
    expect(downloads).toHaveLength(1);
    const first = downloads[0];
    if (!first) throw new Error("downloads 指标缺失");
    expect(first.modelId).toBe("semantic_model_channel_daily");
    expect(first.table).toBe("demo.channel_daily_metrics");
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

describe("算子 SQL 构建", () => {
  it("aggregate：子句顺序固定且指标定位到所属模型表", () => {
    const entry = spendEntry();
    const dim = operatorDimensionsForModel(entry.modelId)[0];
    if (!dim) throw new Error("维度缺失");
    const sql = buildAggregateSql(entry, dim, { metric: "spend", groupBy: dim.id, from: "2026-01-01", to: "2026-08-31" });
    assertClauseOrder(sql, ["SELECT", "FROM demo.channel_daily_metrics", "WHERE", "GROUP BY", "ORDER BY", "LIMIT"]);
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
    assertClauseOrder(sql, ["WITH series AS", "FROM demo.channel_daily_metrics", "SELECT to_char"]);
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
    assertClauseOrder(sql, ["SELECT", "FROM demo.channel_daily_metrics", "WHERE", "GROUP BY", "ORDER BY", "LIMIT"]);
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
    assertClauseOrder(sql, ["SELECT", "FROM demo.channel_daily_metrics", "GROUP BY", "ORDER BY"]);
  });

  it("join：日汇总与投放计划按渠道×承接端关联", () => {
    const sql = buildJoinSql({ from: "2026-01-01" });
    expect(sql).toContain("FROM demo.channel_daily_metrics");
    expect(sql).toContain("FROM demo.channel_campaigns");
    expect(sql).toContain("JOIN c ON c.ad_channel = d.ad_channel AND c.platform = d.platform");
    expect(sql).toContain(`"stat_date" >= '2026-01-01'`);
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

  it("指标不在目录内被 Schema 拦截", async () => {
    const result = await runOperator("aggregate", { metric: "gmv_v2", groupBy: "region" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("参数校验失败");
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
    expect(result.error).toContain("参数校验失败");
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
    expect(result.sql).toContain("FROM demo.channel_daily_metrics");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("注册表包含六个数据算子与六个研究算子", () => {
    const operators = listOperators();
    expect(operators.filter((o) => o.category === "data")).toHaveLength(6);
    expect(operators.filter((o) => o.category === "research")).toHaveLength(6);
    for (const op of operators.filter((o) => o.category === "data")) {
      expect(op.engine).toBe("sql");
    }
  });
});
