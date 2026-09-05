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
  DEFAULT_UTC_OFFSET,
  buildSyncReportParams,
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
  it("维度/指标/区间/时区/排序齐备，指标与落库列对齐", () => {
    const params = buildSyncReportParams("-3d:-1d", DEFAULT_UTC_OFFSET);
    expect(params["dimensions"]).toBe("day,network,country_code");
    expect(params["metrics"]).toBe(ADJUST_METRIC_COLUMNS.join(","));
    expect(params["date_period"]).toBe("-3d:-1d");
    expect(params["utc_offset"]).toBe("+08:00");
    expect(params["sort"]).toBe("-installs");
  });

  it("自定义时区原样透传", () => {
    expect(buildSyncReportParams("yesterday", "-05:00")["utc_offset"]).toBe("-05:00");
  });
});
