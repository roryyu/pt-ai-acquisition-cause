import { describe, expect, it, vi } from "vitest";

// 隔离 DB 与环境变量依赖（与 operators.test.ts 同模式）
vi.mock("@/lib/env", () => ({
  env: {
    DATABASE_URL: "postgresql://localhost:5432/test?schema=cause",
    ADJUST_RS_API_BASE_URL: "https://automate.adjust.com/reports-service",
  },
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  ADJUST_METRIC_COLUMNS,
  ADJUST_DIMENSION_COLUMNS,
  DEFAULT_UTC_OFFSET,
  buildSyncReportParams,
  buildDayChunks,
  buildDateRangeChunks,
  parseEventIds,
} from "@/lib/server/integrations/adjust-sync";

// ─── parseEventIds：/events 终端响应解析（事件 slug 动态校验） ───────────────

describe("parseEventIds（事件 slug 动态校验）", () => {
  it("按实测结构（事件对象数组）提取事件 id 并去重", () => {
    const body = JSON.stringify([
      { id: "register", name: "Register", tokens: ["abc"] },
      { id: "firstdeposit", name: "FirstDeposit" },
      { id: "register" },
    ]);
    expect(parseEventIds(body)).toEqual(["register", "firstdeposit"]);
  });

  it("忽略无 id / 非字符串 id 的项；非 JSON 回退全文匹配", () => {
    expect(parseEventIds(JSON.stringify([{ name: "no-id" }, { id: 123 }]))).toEqual([]);
    expect(parseEventIds("events: register firstdeposit").sort()).toEqual(["events", "firstdeposit", "register"]);
  });
});

// ─── buildSyncReportParams：同步拉数参数组装（含时区口径） ─────────────────────

describe("buildSyncReportParams（同步请求参数）", () => {
  it("5 维粒度 + 16 指标 + 区间/时区/排序齐备，指标与落库列对齐", () => {
    const params = buildSyncReportParams("-3d:-3d", DEFAULT_UTC_OFFSET);
    expect(params["dimensions"]).toBe("day,network,country_code,os_name,campaign_network");
    expect(params["dimensions"]).toBe(ADJUST_DIMENSION_COLUMNS.join(","));
    expect(params["metrics"]).toBe(ADJUST_METRIC_COLUMNS.join(","));
    expect(params["date_period"]).toBe("-3d:-3d");
    expect(params["utc_offset"]).toBe("+08:00");
    expect(params["sort"]).toBe("-installs");
  });

  it("指标集含真实花费口径 cost/adjust_cost（修成本盲区）与新增漏斗/DAU/反欺诈指标", () => {
    const metrics = ADJUST_METRIC_COLUMNS as readonly string[];
    for (const m of [
      "cost", "adjust_cost", "network_cost", "base_sessions",
      "organic_installs", "non_organic_installs", "reattributions",
      "daus", "rejected_installs",
    ]) {
      expect(metrics).toContain(m);
    }
    expect(metrics).toHaveLength(16);
  });

  it("自定义时区原样透传", () => {
    expect(buildSyncReportParams("yesterday", "-05:00")["utc_offset"]).toBe("-05:00");
  });
});

// ─── buildDayChunks：回补窗口按天分块（避免 5 维多日合并超时） ──────────────────

describe("buildDayChunks（按天分块）", () => {
  it("days=3 拆成 3 个单日窗口，旧→新排序", () => {
    expect(buildDayChunks(3)).toEqual(["-3d:-3d", "-2d:-2d", "-1d:-1d"]);
  });

  it("days=1 仅昨日单块；非法/小数向下取整且至少 1 块", () => {
    expect(buildDayChunks(1)).toEqual(["-1d:-1d"]);
    expect(buildDayChunks(0)).toEqual(["-1d:-1d"]);
    expect(buildDayChunks(2.9)).toEqual(["-2d:-2d", "-1d:-1d"]);
  });
});

// ─── buildDateRangeChunks：绝对日期区间按天分块（回补历史中段） ─────────────

describe("buildDateRangeChunks（绝对区间按天分块）", () => {
  it("[from,to] 含端点拆成单日窗口，旧→新排序", () => {
    expect(buildDateRangeChunks("2026-05-01", "2026-05-03")).toEqual([
      "2026-05-01:2026-05-01",
      "2026-05-02:2026-05-02",
      "2026-05-03:2026-05-03",
    ]);
  });

  it("单日区间 from==to 只 1 块；跨月正确进位", () => {
    expect(buildDateRangeChunks("2026-05-30", "2026-05-30")).toEqual(["2026-05-30:2026-05-30"]);
    expect(buildDateRangeChunks("2026-04-29", "2026-05-02")).toEqual([
      "2026-04-29:2026-04-29",
      "2026-04-30:2026-04-30",
      "2026-05-01:2026-05-01",
      "2026-05-02:2026-05-02",
    ]);
  });

  it("5/1~5/30 恰好 30 块（本次回补区间）；chunk 可直接喂给 buildSyncReportParams", () => {
    const chunks = buildDateRangeChunks("2026-05-01", "2026-05-30");
    expect(chunks).toHaveLength(30);
    expect(buildSyncReportParams(chunks[0] ?? "", DEFAULT_UTC_OFFSET)["date_period"]).toBe("2026-05-01:2026-05-01");
  });

  it("非法格式 / from 晚于 to 抛错", () => {
    expect(() => buildDateRangeChunks("2026/05/01", "2026-05-03")).toThrow(/YYYY-MM-DD/);
    expect(() => buildDateRangeChunks("2026-05-10", "2026-05-01")).toThrow(/晚于/);
  });
});
