/**
 * Adjust 报告服务数据同步 —— API → 本地 PG → 语义层（可复用核心模块）
 *
 * 对接文档：doc/Adjust官网API与MCP对接指南-20260902.md
 * 调用方：
 * - `scripts/sync-adjust-data.ts`（CLI 手动/外部 cron 直跑）
 * - `POST /api/v1/syncs/adjust`（服务内触发，外部定时任务驱动，如：
 *   `30 9 * * * curl -X POST http://localhost:3000/api/v1/syncs/adjust`，
 *   Adjust 数据 T+1，每日上午拉昨日 + 默认回补 3 天覆盖修正窗口）
 *
 * 链路：
 * 1. 事件 slug 动态校验：拉 `/events` 终端比对自定义事件 slug（上游改名预警，不阻断）
 * 2. 拉取 `/csv_report`（day×network×country_code 粒度，带 utc_offset 时区口径；
 *    429/5xx 指数退避重试，优先遵循 Retry-After）
 * 3. CSV 解析（connectors/csv.ts，去 BOM + 数值推断）
 * 4. 幂等 upsert 至 data.adjust_daily_metrics（任务问答本地主链路）
 * 5. 挂载自定义语义模型「Adjust 投放日指标」（cause.semantic_models，
 *    关联已注册的「Adjust 报告服务」API 数据源；未注册时 data_source_id=null
 *    走内置演示库）→ run_operator 指标目录自动纳入
 * 6. 补录 Adjust 口径指标定义（cause.metrics，ON CONFLICT 幂等）
 *
 * 依赖 .env：ADJUST_API_TOKEN（必填）、DATABASE_URL、
 *           ADJUST_RS_API_BASE_URL（可选）、ADJUST_RS_UTC_OFFSET（可选，缺省 +08:00）
 * 幂等：重复执行为 upsert / 先删后插，可安全重跑。
 */
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { parseCsvTable, csvTableToObjects } from "@/lib/server/connectors/csv";
import { computeBackoffMs } from "@/lib/server/connectors/api-cache";
import { parseRetryAfterMs } from "@/lib/server/connectors/api";

/** Adjust CSV 列 → 本地表列（维度 + 指标 slug 对齐） */
export const ADJUST_METRIC_COLUMNS = [
  "impressions", "clicks", "installs", "sessions",
  "register_events", "firstdeposit_events", "recalldeposit_events", "network_cost",
] as const;

/** 缺省报告时区：与本地经营数据（UTC+8）对齐，避免跨日错位 */
export const DEFAULT_UTC_OFFSET = "+08:00";

const MODEL_ID = "semantic_model_adjust_daily";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

/** 同步配置错误（凭证缺失等，调用方映射为 503） */
export class AdjustSyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdjustSyncConfigError";
  }
}

export interface AdjustSyncOptions {
  /** 回补天数（默认 3：昨日 + 回补 2 天，覆盖 Adjust T+1 数据修正窗口） */
  days?: number;
  /** 覆盖缺省时区（一般留空走 ADJUST_RS_UTC_OFFSET） */
  utcOffset?: string;
  /** 进度日志回调（CLI / API 各自的输出通道） */
  onLog?: (message: string) => void;
}

export interface AdjustSyncResult {
  ok: boolean;
  datePeriod: string;
  utcOffset: string;
  /** 本次 upsert 行数 */
  upserted: number;
  /** 204（区间无数据）等合法跳过原因 */
  skipped?: string;
  /** 非阻断预警（如事件 slug 上游改名、校验端点不可用） */
  warnings: string[];
  /** 同步后库内汇总（验证） */
  totals?: { days: number; rows: number; installs: number; firstDeposits: number };
}

// ─── 纯函数（可单测） ─────────────────────────────────────────────────────────

/**
 * 从 /events 终端响应提取事件 id 列表（宽容解析：优先按 JSON 数组取各项 id，
 * 解析失败回退为全文匹配事件名字符串）。
 * 实测结构：`[{ id, name, app_token, tokens, ... }]`，
 * 报表指标 slug 约定为 `{事件id}_events`（如 register_events ← 事件 register）
 */
export function parseEventIds(body: string): string[] {
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) {
      // JSON 数组解析成功即信任其结构（即使无有效 id 也不回退全文匹配，避免误报）
      return [
        ...new Set(
          parsed
            .map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : undefined))
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      ];
    }
  } catch {
    /* 非 JSON 结构回退全文匹配 */
  }
  return [...new Set(body.match(/\b[a-z][a-z0-9]+\b/g) ?? [])];
}

/** 组装同步拉数的 /csv_report 请求参数（维度/指标/区间/时区/排序） */
export function buildSyncReportParams(datePeriod: string, utcOffset: string): Record<string, string> {
  return {
    dimensions: "day,network,country_code",
    metrics: ADJUST_METRIC_COLUMNS.join(","),
    date_period: datePeriod,
    utc_offset: utcOffset,
    sort: "-installs",
  };
}

// ─── HTTP（直连 fetch：不经连接器 200KB 截断，批量同步场景） ───────────────────

async function fetchWithTimeout(url: URL, token: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 请求 RS API 终端（429/5xx 指数退避重试，优先遵循 Retry-After；
 * 官方速率限制 50 req/s 突发 100，超限返回 429）
 */
async function rsFetch(base: string, path: string, params: Record<string, string>, token: string): Promise<Response> {
  const url = new URL(`${base}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let res = await fetchWithTimeout(url, token);
  for (let attempt = 0; attempt < MAX_RETRIES && (res.status === 429 || res.status >= 500); attempt++) {
    const waitMs = computeBackoffMs(attempt, parseRetryAfterMs(res.headers.get("retry-after")));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    res = await fetchWithTimeout(url, token);
  }
  return res;
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

export async function runAdjustSync(options: AdjustSyncOptions = {}): Promise<AdjustSyncResult> {
  const log = options.onLog ?? (() => undefined);
  const token = env.ADJUST_API_TOKEN;
  if (!token) {
    throw new AdjustSyncConfigError("缺少 ADJUST_API_TOKEN，请在 .env 中配置（Adjust 控制面板 → 账户设置 → 个人档案）");
  }
  const base = env.ADJUST_RS_API_BASE_URL;
  const utcOffset = options.utcOffset ?? env.ADJUST_RS_UTC_OFFSET ?? DEFAULT_UTC_OFFSET;
  const days = Math.max(1, options.days ?? 3);
  const datePeriod = `-${days}d:-1d`;
  const warnings: string[] = [];

  // ─── 1. 事件 slug 动态校验（上游改名预警，不阻断同步） ──────────────────
  // 报表指标 slug 约定：{事件id}_events；/events 终端返回事件 id（无 _events 后缀）
  log("→ 校验自定义事件 slug（/events 终端）...");
  const requiredEvents = ADJUST_METRIC_COLUMNS
    .filter((c) => c.endsWith("_events"))
    .map((c) => c.slice(0, -"_events".length));
  try {
    const eventsRes = await rsFetch(base, "events", {}, token);
    if (!eventsRes.ok) {
      warnings.push(`/events 终端返回 ${eventsRes.status}，本次跳过事件 slug 校验`);
    } else {
      const upstream = new Set(parseEventIds(await eventsRes.text()));
      const missing = requiredEvents.filter((eventId) => !upstream.has(eventId));
      if (missing.length > 0) {
        warnings.push(
          `以下事件在 /events 终端未找到（可能已被上游改名，对应指标将同步为 0）：${missing.map((e) => `${e}_events`).join(", ")}`,
        );
      } else {
        log(`   事件 slug 校验通过（${requiredEvents.map((e) => `${e}_events`).join(", ")}）`);
      }
    }
  } catch (error) {
    warnings.push(`/events 终端请求失败（${error instanceof Error ? error.message : String(error)}），本次跳过事件 slug 校验`);
  }

  // ─── 2. 拉取 CSV 报告 ───────────────────────────────────────────────────
  log(`→ 拉取 Adjust CSV 报告（date_period=${datePeriod}，utc_offset=${utcOffset}，day×network×country_code）...`);
  const reportRes = await rsFetch(base, "csv_report", buildSyncReportParams(datePeriod, utcOffset), token);
  if (reportRes.status === 204) {
    log("✅ API 返回 204（区间无数据），本次无同步");
    return { ok: true, datePeriod, utcOffset, upserted: 0, skipped: "204 区间无数据", warnings };
  }
  if (!reportRes.ok) {
    throw new Error(`Adjust API HTTP ${reportRes.status}: ${(await reportRes.text()).slice(0, 300)}`);
  }
  const table = parseCsvTable(await reportRes.text());
  const records = csvTableToObjects(table).filter((r) => r["day"] && r["network"] && r["country_code"]);
  log(`   解析 ${records.length} 行（表头：${table.header.join(", ")}）`);
  if (records.length === 0) {
    return { ok: true, datePeriod, utcOffset, upserted: 0, skipped: "无有效数据行", warnings };
  }

  // ─── 3. 建表（幂等） ────────────────────────────────────────────────────
  log("→ 确保 data.adjust_daily_metrics 表存在 ...");
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS data.adjust_daily_metrics (
      stat_date            DATE NOT NULL,
      network              TEXT NOT NULL,
      country_code         TEXT NOT NULL,
      impressions          BIGINT NOT NULL DEFAULT 0,
      clicks               BIGINT NOT NULL DEFAULT 0,
      installs             BIGINT NOT NULL DEFAULT 0,
      sessions             BIGINT NOT NULL DEFAULT 0,
      register_cnt         BIGINT NOT NULL DEFAULT 0,
      first_deposit_cnt    BIGINT NOT NULL DEFAULT 0,
      recall_deposit_cnt   BIGINT NOT NULL DEFAULT 0,
      network_cost         NUMERIC(14,4) NOT NULL DEFAULT 0,
      synced_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (stat_date, network, country_code)
    )
  `);
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_adm_date ON data.adjust_daily_metrics(stat_date)");
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_adm_network ON data.adjust_daily_metrics(network)");

  // ─── 4. 批量 upsert ─────────────────────────────────────────────────────
  log("→ 幂等 upsert（ON CONFLICT (stat_date, network, country_code) DO UPDATE）...");
  const BATCH = 400;
  let upserted = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const values: unknown[] = [];
    const placeholders = chunk
      .map((_, ri) => `(${Array.from({ length: 11 }, (_, ci) => `$${ri * 11 + ci + 1}`).join(",")}, now())`)
      .join(",");
    for (const r of chunk) {
      values.push(
        String(r["day"]), String(r["network"]), String(r["country_code"]),
        Number(r["impressions"] ?? 0), Number(r["clicks"] ?? 0),
        Number(r["installs"] ?? 0), Number(r["sessions"] ?? 0),
        Number(r["register_events"] ?? 0), Number(r["firstdeposit_events"] ?? 0),
        Number(r["recalldeposit_events"] ?? 0), Number(r["network_cost"] ?? 0),
      );
    }
    const count = await prisma.$executeRawUnsafe(
      `INSERT INTO data.adjust_daily_metrics
         (stat_date, network, country_code, impressions, clicks, installs, sessions,
          register_cnt, first_deposit_cnt, recall_deposit_cnt, network_cost, synced_at)
       VALUES ${placeholders}
       ON CONFLICT (stat_date, network, country_code) DO UPDATE SET
         impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks,
         installs = EXCLUDED.installs,
         sessions = EXCLUDED.sessions,
         register_cnt = EXCLUDED.register_cnt,
         first_deposit_cnt = EXCLUDED.first_deposit_cnt,
         recall_deposit_cnt = EXCLUDED.recall_deposit_cnt,
         network_cost = EXCLUDED.network_cost,
         synced_at = now()`,
      ...values,
    );
    upserted += count;
  }
  log(`   upsert ${upserted} 行`);

  // ─── 5. 语义模型挂载（先删后插，幂等） ───────────────────────────────────
  log("→ 挂载语义模型「Adjust 投放日指标」（cause.semantic_models）...");
  const fields = {
    description:
      "Adjust 归因平台真实投放数据：渠道(network)×国家(country_code)×日 粒度的安装/会话/注册/首存(FD)/复存(RD)漏斗，" +
      "由 Adjust 同步（scripts/sync-adjust-data.ts 或 POST /api/v1/syncs/adjust）每日从报告服务 API 同步（T+1）",
    timeColumn: "stat_date",
    metrics: [
      // apiSlug：上游 Adjust API 的指标 slug（API 源直查时算子自动映射，与本地字段名不同时用）；同名指标缺省
      { id: "installs", name: "安装量", column: "installs", agg: "sum", unit: "次", description: "Adjust 归因安装数（install 事件）" },
      { id: "clicks", name: "点击量", column: "clicks", agg: "sum", unit: "次", description: "广告点击数" },
      { id: "impressions", name: "展示量", column: "impressions", agg: "sum", unit: "次", description: "广告展示数（部分渠道不回传，可能为 0）" },
      { id: "sessions", name: "会话数", column: "sessions", agg: "sum", unit: "次", description: "应用会话数（含老用户活跃）" },
      { id: "register_cnt", name: "注册数", column: "register_cnt", agg: "sum", unit: "人", apiSlug: "register_events", description: "Register 自定义事件数" },
      { id: "first_deposit_cnt", name: "首存数（FD）", column: "first_deposit_cnt", agg: "sum", unit: "人", apiSlug: "firstdeposit_events", description: "FirstDeposit 自定义事件数" },
      { id: "recall_deposit_cnt", name: "复存数（RD）", column: "recall_deposit_cnt", agg: "sum", unit: "人", apiSlug: "recalldeposit_events", description: "RecallDeposit 自定义事件数" },
      { id: "network_cost", name: "渠道花费", column: "network_cost", agg: "sum", unit: "美元", description: "渠道回传成本（未配置支出数据时为 0）" },
    ],
    dimensions: [
      { id: "network", name: "投放渠道", column: "network", description: "Adjust network 名称（如 web/gadmobe-apk/Organic）" },
      { id: "country_code", name: "国家码", column: "country_code", description: "ISO 3166-1 alpha-2 小写国家码" },
      { id: "stat_date", name: "日期", column: "stat_date", apiSlug: "day", description: `统计日期（报告时区 ${utcOffset}）` },
    ],
  };
  await prisma.$executeRawUnsafe("DELETE FROM cause.semantic_models WHERE id = $1", MODEL_ID);
  // 关联已注册的 Adjust API 数据源（血缘可追溯）；未注册时为 NULL 走内置演示库
  const adjustSource = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    "SELECT id FROM cause.data_sources WHERE name = $1 AND type = $2 LIMIT 1",
    "Adjust 报告服务", "api",
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO cause.semantic_models(id, name, data_source_id, table_ref, fields, created_at, updated_at)
     VALUES ($1, 'Adjust 投放日指标', $3, 'data.adjust_daily_metrics', $2::jsonb, now(), now())`,
    MODEL_ID, JSON.stringify(fields), adjustSource[0]?.id ?? null,
  );

  // ─── 6. 指标口径补录（幂等） ───────────────────────────────────────────
  log("→ 补录 Adjust 口径指标定义（cause.metrics）...");
  await prisma.$executeRawUnsafe(
    "INSERT INTO cause.users(id, email, name, role) VALUES ('user_dev_default', 'dev@example.com', '开发用户', 'admin') ON CONFLICT (id) DO NOTHING",
  );
  const metrics: Array<[string, string, string, string, string]> = [
    ["metric_adjust_installs", "Adjust 安装量", "Adjust 归因口径的应用安装数", "SUM(installs)", "次"],
    ["metric_adjust_register", "Adjust 注册数", "Register 自定义事件数", "SUM(register_cnt)", "人"],
    ["metric_adjust_fd", "Adjust 首存数（FD）", "FirstDeposit 自定义事件数", "SUM(first_deposit_cnt)", "人"],
    ["metric_adjust_rd", "Adjust 复存数（RD）", "RecallDeposit 自定义事件数", "SUM(recall_deposit_cnt)", "人"],
    ["metric_adjust_fd_rate", "Adjust FD转化率", "首存数 / 注册数", "first_deposit_cnt / register_cnt", "%"],
  ];
  for (const [id, name, desc, formula, unit] of metrics) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO cause.metrics(id, name, description, formula, unit, owner_id, status, version, updated_at)
       VALUES ($1,$2,$3,$4,$5,'user_dev_default','published',1, now())
       ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, formula=$4, unit=$5, updated_at=now()`,
      id, name, desc, formula, unit,
    );
  }

  // ─── 7. 验证 ────────────────────────────────────────────────────────────
  log("→ 验证同步结果 ...");
  const [totals] = await prisma.$queryRawUnsafe<Array<{ days: number; rows: bigint; installs: bigint; fd: bigint }>>(`
    SELECT COUNT(DISTINCT stat_date) AS days, COUNT(*) AS rows,
           SUM(installs) AS installs, SUM(first_deposit_cnt) AS fd
    FROM data.adjust_daily_metrics
  `);
  const totalsOut = totals
    ? { days: Number(totals.days), rows: Number(totals.rows), installs: Number(totals.installs ?? 0), firstDeposits: Number(totals.fd ?? 0) }
    : undefined;
  log(
    `✅ 同步完成：库内 ${totalsOut?.days ?? 0} 天 / ${totalsOut?.rows ?? 0} 行 / 总安装 ${totalsOut?.installs.toLocaleString() ?? 0} / 总FD ${totalsOut?.firstDeposits.toLocaleString() ?? 0}（本次 upsert ${upserted} 行）`,
  );
  for (const warning of warnings) log(`⚠️ ${warning}`);

  return { ok: true, datePeriod, utcOffset, upserted, warnings, totals: totalsOut };
}
