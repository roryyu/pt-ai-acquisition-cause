/**
 * Adjust 报告服务 API（Reporting Service API）连通性与功能测试
 *
 * 对接文档：doc/Adjust官网API与MCP对接指南-20260902.md
 * 官方参考：https://dev.adjust.com/zh/api/rs-api
 *
 * 说明：
 * - 本测试为真实网络请求（非 mock），依赖 .env 中的 ADJUST_API_TOKEN；
 * - 未配置 Token 时自动跳过，不阻塞 CI / 本地全量测试；
 * - 响应码约定：200 成功、204 无数据、400 参数错误、401 未授权、429 超速率限制。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

// vitest 不会自动加载 .env，此处显式加载项目根目录的 .env（已加载过则忽略）
try {
  process.loadEnvFile(path.join(import.meta.dirname, "..", ".env"));
} catch {
  // .env 不存在时依赖外部环境变量
}

const TOKEN = process.env.ADJUST_API_TOKEN ?? "";
const BASE_URL =
  process.env.ADJUST_RS_API_BASE_URL ?? "https://automate.adjust.com/reports-service";

/** 未配置 Token 时跳过整组测试 */
const describeWithToken = TOKEN ? describe : describe.skip;

/** 发起报告服务 API 请求（Bearer Token 认证） */
async function rsFetch(
  endpoint: string,
  params: Record<string, string>,
  token: string = TOKEN,
): Promise<Response> {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** 解析 CSV 文本为 { 表头, 数据行 }（去除 UTF-8 BOM） */
function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  return {
    header: (lines[0] ?? "").split(","),
    rows: lines.slice(1).map((line) => line.split(",")),
  };
}

describeWithToken(
  "Adjust 报告服务 API",
  { timeout: 60_000 },
  () => {
  it(
    "非法 Token 应返回 401 未授权",
    async () => {
      const res = await rsFetch(
        "csv_report",
        { dimensions: "day", metrics: "installs", date_period: "yesterday" },
        "invalid-token-for-test",
      );
      expect(res.status).toBe(401);
    },
  );

  it(
    "CSV 终端：按天查询安装量，返回 200/204 且表头包含请求的维度与指标",
    async () => {
      const res = await rsFetch("csv_report", {
        dimensions: "day",
        metrics: "installs",
        date_period: "yesterday",
      });
      expect([200, 204]).toContain(res.status);
      if (res.status === 204) return; // 无数据属合法响应

      const csv = parseCsv(await res.text());
      // 默认列标题为参数 slug（未传 readable_names）
      expect(csv.header).toContain("day");
      expect(csv.header).toContain("installs");
      // 昨日应有至少一行数据
      expect(csv.rows.length).toBeGreaterThanOrEqual(1);
      for (const row of csv.rows) {
        expect(row).toHaveLength(csv.header.length);
        // installs 列应为非负数值
        const installs = Number(row[csv.header.indexOf("installs")]);
        expect(Number.isFinite(installs) && installs >= 0).toBe(true);
      }
    },
  );

  it(
    "CSV 终端：多维（日期+渠道）与 read­able_names=true 均生效",
    async () => {
      const res = await rsFetch("csv_report", {
        dimensions: "day,network",
        metrics: "installs,clicks",
        date_period: "-7d:-1d",
        readable_names: "true",
        sort: "-installs",
      });
      expect([200, 204]).toContain(res.status);
      if (res.status === 204) return;

      const csv = parseCsv(await res.text());
      // readable_names=true 时列标题为本地化人类可读名称（中文账号下如「日 (日期),渠道 (归因),安装,点击」），而非参数 slug
      expect(csv.header).toHaveLength(4);
      expect(csv.header).not.toContain("day");
      expect(csv.header).not.toContain("installs");
      expect(csv.header.some((h) => /安装|install/i.test(h))).toBe(true);
      expect(csv.header.some((h) => /点击|click/i.test(h))).toBe(true);
    },
  );

  it(
    "CSV 终端：维度过滤操作符 country_code__in 与指标过滤 __gte 生效",
    async () => {
      const res = await rsFetch("csv_report", {
        dimensions: "country_code,day",
        metrics: "installs",
        date_period: "yesterday",
        country_code__in: "ph,th",
        installs__gte: "0",
      });
      expect([200, 204]).toContain(res.status);
      if (res.status === 204) return;

      const csv = parseCsv(await res.text());
      const idx = csv.header.indexOf("country_code");
      expect(idx).toBeGreaterThanOrEqual(0);
      // 所有返回行的国家码都应在过滤列表内
      for (const row of csv.rows) {
        expect(["ph", "th"]).toContain((row[idx] ?? "").toLowerCase());
      }
    },
  );

  it(
    "JSON 终端（/report）：返回 rows + totals 结构",
    async () => {
      const res = await rsFetch("report", {
        dimensions: "day",
        metrics: "installs",
        date_period: "yesterday",
      });
      expect([200, 204]).toContain(res.status);
      if (res.status === 204) return;

      const data = (await res.json()) as {
        rows: Record<string, string>[];
        totals: Record<string, number>;
      };
      expect(Array.isArray(data.rows)).toBe(true);
      expect(data.rows.length).toBeGreaterThanOrEqual(1);
      // 每行包含请求的维度与指标字段
      const firstRow = data.rows[0];
      expect(firstRow).toBeDefined();
      expect(Object.keys(firstRow ?? {})).toEqual(["day", "installs"]);
      // totals 汇总对象包含指标总量
      expect(typeof data.totals.installs).toBe("number");
    },
  );

  it(
    "透视终端（/pivot_report）：以 index 维度为键返回嵌套结构",
    async () => {
      const res = await rsFetch("pivot_report", {
        dimensions: "day,network",
        metrics: "installs",
        date_period: "yesterday",
        index: "network",
      });
      expect([200, 204]).toContain(res.status);
      if (res.status === 204) return;

      const data = (await res.json()) as { rows: Record<string, unknown>[] };
      expect(Array.isArray(data.rows)).toBe(true);
      expect(data.rows.length).toBeGreaterThanOrEqual(1);
      // 每个透视项以 index 维度值（如 web/Organic）为键，含汇总指标与子 rows
      const firstPivotItem = data.rows[0] ?? {};
      const firstKey = Object.keys(firstPivotItem)[0] ?? "";
      const pivot = firstPivotItem[firstKey] as { installs: number; rows: unknown[] };
      expect(pivot).toBeDefined();
      expect(typeof pivot.installs).toBe("number");
      expect(Array.isArray(pivot.rows)).toBe(true);
    },
  );

  it(
    "Parquet 终端（/parquet_report）：返回 Parquet 二进制（PAR1 魔数）",
    async () => {
      const res = await rsFetch("parquet_report", {
        dimensions: "day",
        metrics: "installs",
        date_period: "yesterday",
      });
      expect([200, 204]).toContain(res.status);
      if (res.status === 204) return;

      const buf = Buffer.from(await res.arrayBuffer());
      // Parquet 文件以 PAR1 魔数开头和结尾
      expect(buf.subarray(0, 4).toString("ascii")).toBe("PAR1");
      expect(buf.subarray(-4).toString("ascii")).toBe("PAR1");
    },
  );

  it(
    "错误参数：非法 metrics 应返回 400",
    async () => {
      const res = await rsFetch("csv_report", {
        dimensions: "day",
        metrics: "not_a_real_metric_xyz",
        date_period: "yesterday",
      });
      expect(res.status).toBe(400);
    },
  );
  },
);
