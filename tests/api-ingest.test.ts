import { beforeEach, describe, expect, it, vi } from "vitest";

// API 分解落库测试：隔离 DB 与环境变量依赖（与 operators.test.ts 同模式）
vi.mock("@/lib/env", () => ({
  env: {
    DATABASE_URL: "postgresql://localhost:5432/test?schema=cause",
  },
}));
const executeRawMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { $executeRawUnsafe: (...args: unknown[]) => executeRawMock(...args) },
}));

import {
  shouldPersist, modelDimensionSlugs, mapRowsToLocalColumns, persistApiRowsToDataTable, MAX_INGEST_ROWS,
} from "@/lib/server/integrations/api-ingest";
import type { SemanticModelDef } from "@/lib/server/semantic/semantic-query";

/** 与 scripts/sync-adjust-data.ts 挂载的 Adjust 语义模型同构（含 apiSlug 标注） */
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
    { id: "fd_rate", name: "FD转化率", column: "fd_rate", agg: "none", description: "" },
  ],
  dimensions: [
    { id: "network", name: "投放渠道", column: "network", description: "" },
    { id: "country_code", name: "国家码", column: "country_code", description: "" },
    { id: "stat_date", name: "日期", column: "stat_date", apiSlug: "day", description: "" },
  ],
};

beforeEach(() => {
  executeRawMock.mockReset();
});

describe("落库粒度判定（全维度明细才落）", () => {
  it("模型全维度上游 slug 含时间维度的 day（apiSlug 映射）", () => {
    expect(modelDimensionSlugs(ADJUST_MODEL)).toEqual(["network", "country_code", "day"]);
  });

  it("请求维度覆盖模型全维度 → 可落库", () => {
    expect(shouldPersist(ADJUST_MODEL, ["network", "country_code", "day"])).toBe(true);
    // 多出的额外维度不影响覆盖判定
    expect(shouldPersist(ADJUST_MODEL, ["day", "network", "country_code", "os_name"])).toBe(true);
  });

  it("缺失时间维度（单/部分维度聚合）→ 拒绝落库", () => {
    expect(shouldPersist(ADJUST_MODEL, ["network", "country_code"])).toBe(false);
    expect(shouldPersist(ADJUST_MODEL, ["network"])).toBe(false);
    expect(shouldPersist(ADJUST_MODEL, [])).toBe(false);
  });

  it("无维度模型不允许落库", () => {
    expect(shouldPersist({ ...ADJUST_MODEL, dimensions: [] }, ["network"])).toBe(false);
  });
});

describe("上游 slug → 本地列名映射", () => {
  it("维度/指标 slug 反查本地列名（day→stat_date、register_events→register_cnt），未知列丢弃", () => {
    const mapped = mapRowsToLocalColumns(ADJUST_MODEL, [
      { day: "2026-09-04", network: "web", country_code: "us", installs: 100, register_events: 42, os_name: "ios" },
    ]);
    expect(mapped.dimColumns).toEqual(["network", "country_code", "stat_date"]);
    // agg=none 的派生比率指标不参与落库列
    expect(mapped.metricColumns).toEqual(["installs", "register_cnt"]);
    expect(mapped.rows).toEqual([
      { stat_date: "2026-09-04", network: "web", country_code: "us", installs: 100, register_cnt: 42 },
    ]);
  });

  it("主键值缺失的行剔除（无法 upsert，避免互相覆盖）", () => {
    const mapped = mapRowsToLocalColumns(ADJUST_MODEL, [
      { network: "web", country_code: "us", installs: 1 },            // 缺 day
      { day: "2026-09-04", network: "", country_code: "us", installs: 2 }, // network 空串
      { day: "2026-09-04", network: "web", country_code: "jp", installs: 3 },
    ]);
    expect(mapped.rows).toHaveLength(1);
    expect(mapped.rows[0]).toMatchObject({ country_code: "jp", installs: 3 });
  });

  it("部分指标请求（aggregate 扩维单指标）：仅响应实际返回的指标列参与 upsert，DDL 仍建全列", () => {
    const mapped = mapRowsToLocalColumns(ADJUST_MODEL, [
      { day: "2026-09-04", network: "web", country_code: "us", register_events: 42 },
    ]);
    // upsert 列不含 installs（未请求 → 不得覆盖为 0）；建表列保持模型全量
    expect(mapped.metricColumns).toEqual(["register_cnt"]);
    expect(mapped.allMetricColumns).toEqual(["installs", "register_cnt"]);
  });
});

describe("persistApiRowsToDataTable（幂等建表 + 参数化 upsert）", () => {
  const ROWS = [
    { day: "2026-09-04", network: "web", country_code: "us", installs: 100, register_events: 42 },
    { day: "2026-09-04", network: "web", country_code: "jp", installs: 30, register_events: 7 },
  ];

  it("先幂等建表再批量 upsert：主键=全维度、指标列走 EXCLUDED、值全部参数化", async () => {
    executeRawMock.mockResolvedValue(2);
    const persisted = await persistApiRowsToDataTable(ADJUST_MODEL, ROWS);
    expect(persisted).toBe(2);
    expect(executeRawMock).toHaveBeenCalledTimes(2);

    // 第 1 次：CREATE TABLE IF NOT EXISTS（时间列 DATE、维度列 TEXT、指标列 NUMERIC、主键全维度）
    const ddl: string = executeRawMock.mock.calls[0]![0];
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "data"."adjust_daily_metrics"');
    expect(ddl).toContain('"stat_date" DATE NOT NULL');
    expect(ddl).toContain('"network" TEXT NOT NULL');
    expect(ddl).toContain('"installs" NUMERIC(18,4) NOT NULL DEFAULT 0');
    expect(ddl).toContain('PRIMARY KEY ("network", "country_code", "stat_date")');
    expect(executeRawMock.mock.calls[0]!.length).toBe(1); // DDL 无参数

    // 第 2 次：INSERT ... ON CONFLICT (全维度) DO UPDATE
    const [sql, ...values] = executeRawMock.mock.calls[1]!;
    expect(sql).toContain('INSERT INTO "data"."adjust_daily_metrics"');
    expect(sql).toContain('ON CONFLICT ("network", "country_code", "stat_date") DO UPDATE SET');
    expect(sql).toContain('"register_cnt" = EXCLUDED."register_cnt"');
    expect(sql).toContain('"synced_at" = now()');
    // 参数化：2 行 × 5 列（3 维度 + 2 指标），无裸字面量拼接
    expect(values).toHaveLength(10);
    expect(values.slice(0, 5)).toEqual(["web", "us", "2026-09-04", 100, 42]);
  });

  it("空行/全部不可映射 → 返回 0 且不触达 DB", async () => {
    expect(await persistApiRowsToDataTable(ADJUST_MODEL, [])).toBe(0);
    expect(await persistApiRowsToDataTable(ADJUST_MODEL, [{ os_name: "ios" }])).toBe(0);
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it("部分指标请求：upsert 只更新响应实际返回的指标列，不污染其他列；DDL 仍建全列", async () => {
    executeRawMock.mockResolvedValue(1);
    const persisted = await persistApiRowsToDataTable(ADJUST_MODEL, [
      { day: "2026-09-04", network: "web", country_code: "us", register_events: 42 },
    ]);
    expect(persisted).toBe(1);
    const ddl: string = executeRawMock.mock.calls[0]![0];
    expect(ddl).toContain('"installs" NUMERIC(18,4) NOT NULL DEFAULT 0');   // 建表含全量指标列
    const [sql, ...values] = executeRawMock.mock.calls[1]!;
    expect(sql).not.toContain('"installs" = EXCLUDED');                     // 未请求指标不参与更新
    expect(sql).toContain('"register_cnt" = EXCLUDED."register_cnt"');
    expect(values).toEqual(["web", "us", "2026-09-04", 42]);
  });

  it("行数超过单次落库上限（MAX_INGEST_ROWS）→ 拒绝落库仅告警，不触达 DB", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const huge = Array.from({ length: MAX_INGEST_ROWS + 1 }, () => ROWS[0]!);
    await expect(persistApiRowsToDataTable(ADJUST_MODEL, huge)).resolves.toBe(0);
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("DB 异常仅告警返回 0，绝不抛出（落库失败不影响取数主流程）", async () => {
    executeRawMock.mockRejectedValue(new Error("connection refused"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(persistApiRowsToDataTable(ADJUST_MODEL, ROWS)).resolves.toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("非法标识符（模型表名注入）被拦截且不执行任何 SQL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const malicious: SemanticModelDef = { ...ADJUST_MODEL, table: 'x"; DROP TABLE users;--' };
    await expect(persistApiRowsToDataTable(malicious, ROWS)).resolves.toBe(0);
    expect(executeRawMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
