import { describe, it, expect, vi } from "vitest";

// API 连接器 / CSV 解析 / 查询缓存：纯函数隔离测试（不触网、不触达 DB）
vi.mock("@/lib/env", () => ({
  env: {
    DATABASE_URL: "postgresql://localhost:5432/test?schema=cause",
    MODEL_GATEWAY_BASE_URL: "https://gateway.test/v1",
    MODEL_GATEWAY_API_KEY: "test-key",
    MODEL_GATEWAY_DEFAULT_MODEL: "test-model",
    MODEL_GATEWAY_TIMEOUT_MS: 30000,
  },
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { resolveRequestUrl } from "@/lib/server/connectors/api";
import { parseCsvTable, csvTableToObjects } from "@/lib/server/connectors/csv";
import { computeApiCacheKey, resolveTtlSeconds } from "@/lib/server/connectors/api-cache";

// ─── resolveRequestUrl：base path 保留（20260902 缺陷修复回归） ──────────────

describe("resolveRequestUrl（base path 拼接语义）", () => {
  it("endpoint 含 base path 时三种 path 写法均保留 base path", () => {
    const endpoint = "https://rs.adjust.com/reports-service";
    expect(resolveRequestUrl(endpoint, "csv_report")).toBe("https://rs.adjust.com/reports-service/csv_report");
    expect(resolveRequestUrl(endpoint, "/csv_report")).toBe("https://rs.adjust.com/reports-service/csv_report");
    expect(resolveRequestUrl(`${endpoint}/`, "csv_report")).toBe("https://rs.adjust.com/reports-service/csv_report");
  });

  it("纯域名 endpoint 行为与标准相对路径解析一致", () => {
    expect(resolveRequestUrl("https://api.example.com", "/v1/users")).toBe("https://api.example.com/v1/users");
  });

  it("query 参数逐个注入", () => {
    const url = resolveRequestUrl("https://rs.adjust.com/reports-service", "csv_report", {
      dimensions: "day,network",
      date_period: "-7d:-1d",
    });
    expect(url).toContain("dimensions=day%2Cnetwork");
    expect(url).toContain("date_period=-7d%3A-1d");
  });

  it("无 path 时返回 endpoint 本身（含已有 query 不丢失）", () => {
    expect(resolveRequestUrl("https://api.example.com/base?token=x")).toBe("https://api.example.com/base?token=x");
  });

  it("绝对 URL / 协议相对路径的 path 被中和为同主机子路径（不会跨主机重定向）", () => {
    expect(resolveRequestUrl("https://api.example.com", "//evil.com/x")).toBe("https://api.example.com/evil.com/x");
    expect(resolveRequestUrl("https://api.example.com", "https://evil.com/x")).toBe("https://api.example.com/https://evil.com/x");
  });
});

// ─── parseCsvTable：BOM / 引号感知 / 数值推断 ────────────────────────────────

describe("parseCsvTable（CSV 结构化）", () => {
  it("剥离 UTF-8 BOM 并解析表头与数据行", () => {
    const table = parseCsvTable("\uFEFFday,network,installs\n2026-09-01,web,100\n");
    expect(table.header).toEqual(["day", "network", "installs"]);
    expect(table.rows).toHaveLength(1);
  });

  it("数值列整列推断为 number，混合列保持 string", () => {
    const table = parseCsvTable("day,network,installs\n2026-09-01,web,100\n2026-09-02,gadmobe-apk,200\n");
    expect(table.numericColumns).toEqual([false, false, true]);
    expect(table.rows[0]?.[2]).toBe(100);
    expect(table.rows[1]?.[2]).toBe(200);
  });

  it("引号内逗号与换行不切断字段/记录，转义双引号还原", () => {
    const table = parseCsvTable('name,value\n"Meta, Inc.",1\n"line1\nline2",2\n"say ""hi""",3\n');
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]?.[0]).toBe("Meta, Inc.");
    expect(table.rows[1]?.[0]).toBe("line1\nline2");
    expect(table.rows[2]?.[0]).toBe('say "hi"');
  });

  it("空文本返回空表；空行被过滤", () => {
    expect(parseCsvTable("  ")).toEqual({ header: [], rows: [], numericColumns: [] });
    const table = parseCsvTable("a,b\n1,2\n\n3,4\n");
    expect(table.rows).toHaveLength(2);
  });

  it("csvTableToObjects 按表头名转对象行", () => {
    const objects = csvTableToObjects(parseCsvTable("day,installs\n2026-09-01,100\n"));
    expect(objects).toEqual([{ day: "2026-09-01", installs: 100 }]);
  });
});

// ─── 查询缓存：键计算与 TTL 推断 ─────────────────────────────────────────────

describe("computeApiCacheKey / resolveTtlSeconds（缓存策略）", () => {
  it("缓存键与 params 插入顺序无关", () => {
    const k1 = computeApiCacheKey("GET", "https://rs.adjust.com/reports-service", "csv_report", { a: "1", b: "2" });
    const k2 = computeApiCacheKey("GET", "https://rs.adjust.com/reports-service", "csv_report", { b: "2", a: "1" });
    expect(k1).toBe(k2);
  });

  it("path / method 不同则缓存键不同", () => {
    const base = computeApiCacheKey("GET", "https://rs.adjust.com/reports-service", "csv_report");
    expect(computeApiCacheKey("GET", "https://rs.adjust.com/reports-service", "report")).not.toBe(base);
    expect(computeApiCacheKey("POST", "https://rs.adjust.com/reports-service", "csv_report")).not.toBe(base);
  });

  it("含今天的区间 → 30 分钟短缓存", () => {
    expect(resolveTtlSeconds({ date_period: "today" }, "2026-09-02")).toBe(1800);
    expect(resolveTtlSeconds({ date_period: "yesterday" }, "2026-09-02")).toBe(1800);
    expect(resolveTtlSeconds({ date_period: "-7d:-1d" }, "2026-09-02")).toBe(1800);
  });

  it("结束日距今 ≥2 天的历史区间 → 7 天长缓存（Adjust 数据 T+1 已稳定）", () => {
    expect(resolveTtlSeconds({ date_period: "-9d:-2d" }, "2026-09-02")).toBe(7 * 86400);
    expect(resolveTtlSeconds({ date_period: "2026-08-01:2026-08-25" }, "2026-09-02")).toBe(7 * 86400);
  });

  it("显式区间结束日为昨天 → 短缓存；无 date_period → 默认 1 小时", () => {
    expect(resolveTtlSeconds({ date_period: "2026-08-01:2026-09-01" }, "2026-09-02")).toBe(1800);
    expect(resolveTtlSeconds({}, "2026-09-02")).toBe(3600);
    expect(resolveTtlSeconds(undefined, "2026-09-02")).toBe(3600);
  });
});
