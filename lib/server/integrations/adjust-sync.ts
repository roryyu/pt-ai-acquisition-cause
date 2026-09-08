/**
 * Adjust 报告服务数据同步 —— API → 本地 PG → 语义层（可复用核心模块）
 *
 * 对接文档：doc/Adjust官网API与MCP对接指南-20260902.md
 * 指标/维度对齐依据：doc/adjust-metrics-optimization-plan.md（活体 API 探活为准）
 * 调用方：
 * - `scripts/sync-adjust-data.ts`（CLI 手动/外部 cron 直跑，支持 --days / --from+--to / --reset）
 * - `POST /api/v1/syncs/adjust`（服务内触发，外部定时任务驱动，如：
 *   `30 9 * * * curl -X POST http://localhost:3000/api/v1/syncs/adjust`，
 *   Adjust 数据 T+1，每日上午拉昨日 + 默认回补 3 天覆盖修正窗口）
 *
 * 链路：
 * 1. 事件 slug 动态校验：拉 `/events` 终端比对自定义事件 slug（上游改名预警，不阻断）
 * 2. 建表（幂等；reset 时先 DROP 再按最新 5 维 DDL 重建 —— PK 变更/全量回补用）
 * 3. **按天分块**拉取 `/csv_report`（day×network×country_code×os_name×campaign_network 5 维粒度，
 *    16 个可加指标；单日 5 维实测 ~24s，故 1 天/请求，超时 90s；429/5xx 指数退避重试）
 * 4. CSV 解析（connectors/csv.ts，去 BOM + 数值推断）→ 幂等 upsert 至 data.adjust_daily_metrics
 * 5. 挂载自定义语义模型「Adjust 投放日指标」（cause.semantic_models，16 指标/5 维）
 * 6. 补录 Adjust 口径指标定义（cause.metrics，含派生率 formula 目录，ON CONFLICT 幂等）
 *
 * 依赖 .env：ADJUST_API_TOKEN（必填）、DATABASE_URL、
 *           ADJUST_RS_API_BASE_URL（可选）、ADJUST_RS_UTC_OFFSET（可选，缺省 +08:00）
 * 幂等：重复执行为 upsert / 先删后插，可安全重跑；单日失败不阻断整批回补（记 warning 续跑）。
 */
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { parseCsvTable, csvTableToObjects } from "@/lib/server/connectors/csv";
import { computeBackoffMs } from "@/lib/server/connectors/api-cache";
import { parseRetryAfterMs } from "@/lib/server/connectors/api";

/**
 * Adjust 上游指标 slug（16 个可加指标）——经活体 API 探活确认本账号有数：
 * 漏斗/拆分/事件/DAU/反欺诈为 BIGINT 计数，cost/adjust_cost/network_cost 为 NUMERIC 花费。
 * 说明：network_cost 该账号未对接渠道成本 API，恒为 0，保留以对齐官方三口径（接入后自动有数）；
 * 收入/ROAS/eCPI 类为权限门控（loc=revenue/ecpm），无法接入，故不在此列。
 */
export const ADJUST_METRIC_COLUMNS = [
  "impressions", "clicks", "installs", "sessions", "base_sessions",
  "organic_installs", "non_organic_installs", "reattributions",
  "register_events", "firstdeposit_events", "recalldeposit_events",
  "daus", "rejected_installs",
  "cost", "adjust_cost", "network_cost",
] as const;

/** 同步粒度维度（上游 slug）：day×network×country_code×os_name×campaign_network（5 维主键） */
export const ADJUST_DIMENSION_COLUMNS = [
  "day", "network", "country_code", "os_name", "campaign_network",
] as const;

/** 缺省报告时区：与本地经营数据（UTC+8）对齐，避免跨日错位 */
export const DEFAULT_UTC_OFFSET = "+08:00";

const MODEL_ID = "semantic_model_adjust_daily";
/** 单日 5 维请求实测 ~24s，留足余量（旧 30s 在数据高峰会超时） */
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RETRIES = 3;

/**
 * 本地列 ← 上游 slug + 落库转换（顺序 = INSERT 列顺序：5 维在前、16 指标在后）。
 * dim=文本主键，int=BIGINT 计数（Math.round），num=NUMERIC 花费（原样）。
 */
const COLUMN_SOURCES: ReadonlyArray<{ col: string; slug: string; kind: "dim" | "int" | "num" }> = [
  { col: "stat_date", slug: "day", kind: "dim" },
  { col: "network", slug: "network", kind: "dim" },
  { col: "country_code", slug: "country_code", kind: "dim" },
  { col: "os_name", slug: "os_name", kind: "dim" },
  { col: "campaign_network", slug: "campaign_network", kind: "dim" },
  { col: "impressions", slug: "impressions", kind: "int" },
  { col: "clicks", slug: "clicks", kind: "int" },
  { col: "installs", slug: "installs", kind: "int" },
  { col: "sessions", slug: "sessions", kind: "int" },
  { col: "base_sessions", slug: "base_sessions", kind: "int" },
  { col: "organic_installs", slug: "organic_installs", kind: "int" },
  { col: "non_organic_installs", slug: "non_organic_installs", kind: "int" },
  { col: "reattributions", slug: "reattributions", kind: "int" },
  { col: "register_cnt", slug: "register_events", kind: "int" },
  { col: "first_deposit_cnt", slug: "firstdeposit_events", kind: "int" },
  { col: "recall_deposit_cnt", slug: "recalldeposit_events", kind: "int" },
  { col: "daus", slug: "daus", kind: "int" },
  { col: "rejected_installs", slug: "rejected_installs", kind: "int" },
  { col: "cost", slug: "cost", kind: "num" },
  { col: "adjust_cost", slug: "adjust_cost", kind: "num" },
  { col: "network_cost", slug: "network_cost", kind: "num" },
];
/** 主键维度列数（前 5 列为 ON CONFLICT 目标） */
const DIM_COUNT = 5;
const INSERT_COLS = COLUMN_SOURCES.map((c) => c.col);
const BATCH = 400;

/** 同步配置错误（凭证缺失等，调用方映射为 503） */
export class AdjustSyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdjustSyncConfigError";
  }
}

export interface AdjustSyncOptions {
  /** 回补天数（默认 3：昨日 + 回补 2 天，覆盖 Adjust T+1 数据修正窗口）；与 from/to 互斥 */
  days?: number;
  /** 绝对区间起（YYYY-MM-DD，含端点）；与 to 同时提供时按绝对日期回补，优先于 days */
  from?: string;
  /** 绝对区间止（YYYY-MM-DD，含端点）；须与 from 同时提供 */
  to?: string;
  /** 覆盖缺省时区（一般留空走 ADJUST_RS_UTC_OFFSET） */
  utcOffset?: string;
  /** 清空重建：DROP TABLE 后按最新 5 维 DDL 重建再回补（PK 变更/全量重同步用） */
  reset?: boolean;
  /** 进度日志回调（CLI / API 各自的输出通道） */
  onLog?: (message: string) => void;
}

export interface AdjustSyncResult {
  ok: boolean;
  /** 整体回补窗口（相对 -Nd:-1d 或绝对 from:to） */
  datePeriod: string;
  utcOffset: string;
  /** 本次 upsert 行数（各分块累加） */
  upserted: number;
  /** 分块（天）总数 */
  chunks: number;
  /** 重试后仍失败、已跳过的分块（可单独重跑） */
  failedDays: string[];
  /** 204（区间无数据）等合法跳过原因 */
  skipped?: string;
  /** 非阻断预警（如事件 slug 上游改名、校验端点不可用、单日分块失败） */
  warnings: string[];
  /** 同步后库内汇总（验证） */
  totals?: { days: number; rows: number; installs: number; firstDeposits: number; cost: number };
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

/** 组装单个分块的 /csv_report 请求参数（维度/指标/区间/时区/排序） */
export function buildSyncReportParams(datePeriod: string, utcOffset: string): Record<string, string> {
  return {
    dimensions: ADJUST_DIMENSION_COLUMNS.join(","),
    metrics: ADJUST_METRIC_COLUMNS.join(","),
    date_period: datePeriod,
    utc_offset: utcOffset,
    sort: "-installs",
  };
}

/**
 * 把回补窗口拆成单日 date_period 列表（days=3 → ["-3d:-3d","-2d:-2d","-1d:-1d"]，旧→新）。
 * 5 维粒度下单日 ~8.6k 行/24s，多日合并必超时，故按天分块；沿用 Adjust 相对日期，
 * 由上游按 utc_offset 处理时区，避免本地时区换算误差。
 */
export function buildDayChunks(days: number): string[] {
  const n = Math.max(1, Math.floor(days));
  const chunks: string[] = [];
  for (let i = n; i >= 1; i--) chunks.push(`-${i}d:-${i}d`);
  return chunks;
}

/** 合法绝对日期（YYYY-MM-DD）格式 */
const ABS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 把绝对日期区间 [from, to]（YYYY-MM-DD，含端点）拆成单日 date_period 列表，旧→新。
 * 相对 buildDayChunks 只能覆盖「今日往前 N 天」，无法只补历史中段（如已同步到 5/31，
 * 再补 5/1~5/30）；本函数发绝对日期 chunk，由上游按 utc_offset 解释。
 * 同相对分块：5 维粒度下单日 ~8.6k 行/24s，多日合并必超时，故仍按天分块。
 */
export function buildDateRangeChunks(from: string, to: string): string[] {
  if (!ABS_DATE_RE.test(from) || !ABS_DATE_RE.test(to)) {
    throw new Error(`非法日期（需 YYYY-MM-DD）：from=${from} to=${to}`);
  }
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(`非法日期（无法解析）：from=${from} to=${to}`);
  }
  if (start > end) {
    throw new Error(`起始日期 ${from} 晚于结束日期 ${to}`);
  }
  const chunks: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    chunks.push(`${d}:${d}`);
  }
  return chunks;
}

/** CSV 记录 → 按 COLUMN_SOURCES 顺序的落库值数组（维度取字符串，计数四舍五入，花费原样） */
function recordToValues(record: Record<string, unknown>): unknown[] {
  return COLUMN_SOURCES.map(({ slug, kind }) => {
    const raw = record[slug];
    if (kind === "dim") return String(raw ?? "");
    const n = Number(raw ?? 0);
    const v = Number.isFinite(n) ? n : 0;
    return kind === "int" ? Math.round(v) : v;
  });
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

/** 提取 undici 网络异常的真实原因（fetch failed 的 cause，如 ECONNRESET/socket hang up） */
function networkErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : "";
    return causeMsg ? `${error.message}（cause: ${causeMsg}）` : error.message;
  }
  return String(error);
}

/**
 * 请求 RS API 终端：429/5xx 与网络层异常（fetch failed/ECONNRESET/超时）均指数退避重试，
 * 优先遵循 Retry-After；官方速率限制 50 req/s 突发 100，超限返回 429。
 * 重试耗尽后：HTTP 响应（含 4xx/5xx）原样返回交调用方判定；网络异常则抛出（带 cause）。
 */
async function rsFetch(base: string, path: string, params: Record<string, string>, token: string): Promise<Response> {
  const url = new URL(`${base}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let lastErr: unknown;
  let retryAfterMs: number | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, computeBackoffMs(attempt - 1, retryAfterMs)));
    }
    try {
      const res = await fetchWithTimeout(url, token);
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        continue;
      }
      return res;
    } catch (error) {
      lastErr = error; // 网络层失败（fetch failed / abort / ECONNRESET），退避后重试
    }
  }
  throw new Error(`请求 ${path} 失败（已重试 ${MAX_RETRIES} 次）：${networkErrorMessage(lastErr)}`);
}

// ─── 落库（建表 + 批量 upsert） ────────────────────────────────────────────────

/** 幂等建表：5 维主键 + 16 指标列（计数 BIGINT、花费 NUMERIC）；已存在则跳过 */
async function ensureTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS data.adjust_daily_metrics (
      stat_date            DATE NOT NULL,
      network              TEXT NOT NULL,
      country_code         TEXT NOT NULL,
      os_name              TEXT NOT NULL DEFAULT '',
      campaign_network     TEXT NOT NULL DEFAULT '',
      impressions          BIGINT NOT NULL DEFAULT 0,
      clicks               BIGINT NOT NULL DEFAULT 0,
      installs             BIGINT NOT NULL DEFAULT 0,
      sessions             BIGINT NOT NULL DEFAULT 0,
      base_sessions        BIGINT NOT NULL DEFAULT 0,
      organic_installs     BIGINT NOT NULL DEFAULT 0,
      non_organic_installs BIGINT NOT NULL DEFAULT 0,
      reattributions       BIGINT NOT NULL DEFAULT 0,
      register_cnt         BIGINT NOT NULL DEFAULT 0,
      first_deposit_cnt    BIGINT NOT NULL DEFAULT 0,
      recall_deposit_cnt   BIGINT NOT NULL DEFAULT 0,
      daus                 BIGINT NOT NULL DEFAULT 0,
      rejected_installs    BIGINT NOT NULL DEFAULT 0,
      cost                 NUMERIC(18,4) NOT NULL DEFAULT 0,
      adjust_cost          NUMERIC(18,4) NOT NULL DEFAULT 0,
      network_cost         NUMERIC(18,4) NOT NULL DEFAULT 0,
      synced_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (stat_date, network, country_code, os_name, campaign_network)
    )
  `);
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_adm_date ON data.adjust_daily_metrics(stat_date)");
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_adm_network ON data.adjust_daily_metrics(network)");
}

/** 批量幂等 upsert（ON CONFLICT 5 维 DO UPDATE 全 16 指标）；返回受影响行数 */
async function upsertRecords(records: Record<string, unknown>[]): Promise<number> {
  const colCount = COLUMN_SOURCES.length;
  const insertCols = [...INSERT_COLS, "synced_at"].join(", ");
  const conflictCols = INSERT_COLS.slice(0, DIM_COUNT).join(", ");
  const updateSet = [
    ...INSERT_COLS.slice(DIM_COUNT).map((c) => `${c} = EXCLUDED.${c}`),
    "synced_at = now()",
  ].join(", ");
  let upserted = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const values: unknown[] = [];
    const placeholders = chunk
      .map((_, ri) => `(${Array.from({ length: colCount }, (_, ci) => `$${ri * colCount + ci + 1}`).join(",")}, now())`)
      .join(",");
    for (const r of chunk) values.push(...recordToValues(r));
    upserted += await prisma.$executeRawUnsafe(
      `INSERT INTO data.adjust_daily_metrics (${insertCols})
       VALUES ${placeholders}
       ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateSet}`,
      ...values,
    );
  }
  return upserted;
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
  // 回补窗口：绝对区间（from/to，补任意历史中段）优先，否则相对天数（-Nd:-1d，覆盖到今日往前）
  const useRange = options.from !== undefined || options.to !== undefined;
  if (useRange && (options.from === undefined || options.to === undefined)) {
    throw new Error("from 与 to 必须同时提供（绝对日期区间回补，格式 YYYY-MM-DD）");
  }
  const days = Math.max(1, options.days ?? 3);
  const chunks = useRange ? buildDateRangeChunks(options.from!, options.to!) : buildDayChunks(days);
  const datePeriod = useRange ? `${options.from}:${options.to}` : `-${days}d:-1d`;
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

  // ─── 2. 建表（reset 时先 DROP，PK 3→5 维迁移必须重建） ───────────────────
  if (options.reset) {
    log("→ reset：DROP TABLE data.adjust_daily_metrics（清空重同步，按 5 维 DDL 重建）...");
    await prisma.$executeRawUnsafe("DROP TABLE IF EXISTS data.adjust_daily_metrics");
  }
  log("→ 确保 data.adjust_daily_metrics 表存在（5 维主键 + 16 指标）...");
  await ensureTable();

  // ─── 3. 按天分块拉取 CSV 报告 + upsert（单日失败不阻断整批） ──────────────
  log(`→ 按天分块拉取 ${chunks.length} 天（${chunks[0]} … ${chunks[chunks.length - 1]}），5 维粒度 day×network×country_code×os_name×campaign_network ...`);
  let upserted = 0;
  const failedDays: string[] = [];
  for (const chunk of chunks) {
    try {
      const reportRes = await rsFetch(base, "csv_report", buildSyncReportParams(chunk, utcOffset), token);
      if (reportRes.status === 204) {
        log(`   ${chunk}：204 区间无数据，跳过`);
        continue;
      }
      if (!reportRes.ok) {
        throw new Error(`Adjust API HTTP ${reportRes.status}: ${(await reportRes.text()).slice(0, 200)}`);
      }
      const table = parseCsvTable(await reportRes.text());
      // 主键关键列（day/network/country_code）缺失的行剔除；os_name/campaign_network 允许空串
      const records = csvTableToObjects(table).filter((r) => r["day"] && r["network"] && r["country_code"]);
      if (records.length === 0) {
        log(`   ${chunk}：无有效数据行，跳过`);
        continue;
      }
      const n = await upsertRecords(records);
      upserted += n;
      log(`   ${chunk}：解析 ${records.length} 行，upsert ${n} 行`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failedDays.push(chunk);
      warnings.push(`分块 ${chunk} 同步失败（已跳过，可单独重跑）：${msg}`);
      log(`   ⚠️ ${chunk} 失败：${msg}`);
    }
  }

  // ─── 4. 语义模型挂载（先删后插，幂等；16 指标 / 5 维） ────────────────────
  log("→ 挂载语义模型「Adjust 投放日指标」（cause.semantic_models）...");
  const fields = {
    description:
      "Adjust 归因平台真实投放数据：日×渠道(network)×国家(country_code)×系统(os_name)×计划(campaign_network) 5 维粒度的" +
      "安装/会话/自然量拆分/自定义事件/DAU/反欺诈/花费指标，由 Adjust 同步（scripts/sync-adjust-data.ts 或 " +
      "POST /api/v1/syncs/adjust）按天分块从报告服务 API 同步（T+1）",
    timeColumn: "stat_date",
    metrics: [
      // apiSlug：上游 Adjust API 的指标 slug（API 源直查时算子自动映射，与本地字段名不同时用）；同名指标缺省
      { id: "installs", name: "安装量", column: "installs", agg: "sum", unit: "次", description: "Adjust 归因安装数（install 事件）" },
      { id: "clicks", name: "点击量", column: "clicks", agg: "sum", unit: "次", description: "广告点击数" },
      { id: "impressions", name: "展示量", column: "impressions", agg: "sum", unit: "次", description: "广告展示数（部分渠道不回传，可能为 0）" },
      { id: "sessions", name: "会话数", column: "sessions", agg: "sum", unit: "次", description: "应用会话总数（含安装/再归因会话）" },
      { id: "base_sessions", name: "基础会话数", column: "base_sessions", agg: "sum", unit: "次", description: "基础会话数（不含安装与再归因会话）" },
      { id: "organic_installs", name: "自然安装", column: "organic_installs", agg: "sum", unit: "次", description: "自然量（非付费）安装数" },
      { id: "non_organic_installs", name: "付费安装", column: "non_organic_installs", agg: "sum", unit: "次", description: "非自然（付费）安装数" },
      { id: "reattributions", name: "再归因数", column: "reattributions", agg: "sum", unit: "次", description: "已安装用户被重新归因的次数" },
      { id: "register_cnt", name: "注册数", column: "register_cnt", agg: "sum", unit: "人", apiSlug: "register_events", description: "Register 自定义事件数" },
      { id: "first_deposit_cnt", name: "首存数（FD）", column: "first_deposit_cnt", agg: "sum", unit: "人", apiSlug: "firstdeposit_events", description: "FirstDeposit 自定义事件数" },
      { id: "recall_deposit_cnt", name: "复存数（RD）", column: "recall_deposit_cnt", agg: "sum", unit: "人", apiSlug: "recalldeposit_events", description: "RecallDeposit 自定义事件数" },
      { id: "daus", name: "日活跃用户", column: "daus", agg: "sum", unit: "人", description: "日活跃用户数（按归因来源拆分；跨日汇总为人日累加口径，求平均日活需除以天数）" },
      { id: "rejected_installs", name: "拒绝安装（反欺诈）", column: "rejected_installs", agg: "sum", unit: "次", description: "Adjust 判定为欺诈而拒绝的安装数" },
      { id: "cost", name: "广告花费", column: "cost", agg: "sum", unit: "美元", description: "广告总花费（click+impression+install+event cost）" },
      { id: "adjust_cost", name: "归因花费", column: "adjust_cost", agg: "sum", unit: "美元", description: "Adjust 归因口径花费" },
      { id: "network_cost", name: "渠道花费", column: "network_cost", agg: "sum", unit: "美元", description: "渠道 API 上报花费（该账号未对接，恒为 0；保留对齐官方三口径）" },
    ],
    dimensions: [
      { id: "network", name: "投放渠道", column: "network", description: "Adjust network 名称（如 web/gadmobe-apk/Organic）" },
      { id: "country_code", name: "国家码", column: "country_code", description: "ISO 3166-1 alpha-2 小写国家码" },
      { id: "os_name", name: "操作系统", column: "os_name", description: "设备操作系统（android/ios/windows…；未知为空串）" },
      { id: "campaign_network", name: "投放计划", column: "campaign_network", description: "渠道内投放计划名/ID（自然量等无计划时为空串）" },
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

  // ─── 5. 指标口径补录（幂等；派生率以 formula 登记目录，实际经多指标语义查询从基列计算） ──
  log("→ 补录 Adjust 口径指标定义（cause.metrics）...");
  await prisma.$executeRawUnsafe(
    "INSERT INTO cause.users(id, email, name, role) VALUES ('user_dev_default', 'dev@example.com', '开发用户', 'admin') ON CONFLICT (id) DO NOTHING",
  );
  const metrics: Array<[string, string, string, string, string]> = [
    // 基指标（可加，直接对应落库列）
    ["metric_adjust_installs", "Adjust 安装量", "Adjust 归因口径的应用安装数", "SUM(installs)", "次"],
    ["metric_adjust_register", "Adjust 注册数", "Register 自定义事件数", "SUM(register_cnt)", "人"],
    ["metric_adjust_fd", "Adjust 首存数（FD）", "FirstDeposit 自定义事件数", "SUM(first_deposit_cnt)", "人"],
    ["metric_adjust_rd", "Adjust 复存数（RD）", "RecallDeposit 自定义事件数", "SUM(recall_deposit_cnt)", "人"],
    ["metric_adjust_cost", "Adjust 广告花费", "广告总花费（cost 口径，有真实数据）", "SUM(cost)", "美元"],
    ["metric_adjust_daus", "Adjust 日活", "日活跃用户数", "SUM(daus)", "人"],
    ["metric_adjust_rejected", "Adjust 拒绝安装", "反欺诈拒绝安装数", "SUM(rejected_installs)", "次"],
    // 派生率目录（formula 仅供口径参考，不被执行；比率经多指标语义查询从已落库基列计算）
    ["metric_adjust_fd_rate", "Adjust FD转化率", "首存数 / 注册数", "first_deposit_cnt / register_cnt", "%"],
    ["metric_adjust_ctr", "Adjust CTR", "点击率 = 点击 / 展示", "clicks / impressions", "%"],
    ["metric_adjust_ccr", "Adjust 点击转化率", "CCR = 安装 / 点击", "installs / clicks", "%"],
    ["metric_adjust_icr", "Adjust 展示转化率", "ICR = 安装 / 展示", "installs / impressions", "%"],
    ["metric_adjust_ecpi", "Adjust eCPI", "有效安装成本 = 花费 / 安装", "cost / installs", "美元"],
    ["metric_adjust_rejected_rate", "Adjust 拒绝安装率", "拒绝安装 / 安装", "rejected_installs / installs", "%"],
  ];
  for (const [id, name, desc, formula, unit] of metrics) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO cause.metrics(id, name, description, formula, unit, owner_id, status, version, updated_at)
       VALUES ($1,$2,$3,$4,$5,'user_dev_default','published',1, now())
       ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, formula=$4, unit=$5, updated_at=now()`,
      id, name, desc, formula, unit,
    );
  }

  // ─── 6. 验证 ────────────────────────────────────────────────────────────
  log("→ 验证同步结果 ...");
  const [totals] = await prisma.$queryRawUnsafe<Array<{ days: number; rows: bigint; installs: bigint; fd: bigint; cost: number }>>(`
    SELECT COUNT(DISTINCT stat_date) AS days, COUNT(*) AS rows,
           SUM(installs) AS installs, SUM(first_deposit_cnt) AS fd, SUM(cost) AS cost
    FROM data.adjust_daily_metrics
  `);
  const totalsOut = totals
    ? {
        days: Number(totals.days),
        rows: Number(totals.rows),
        installs: Number(totals.installs ?? 0),
        firstDeposits: Number(totals.fd ?? 0),
        cost: Number(totals.cost ?? 0),
      }
    : undefined;
  log(
    `✅ 同步完成：库内 ${totalsOut?.days ?? 0} 天 / ${totalsOut?.rows ?? 0} 行 / 总安装 ${totalsOut?.installs.toLocaleString() ?? 0}` +
    ` / 总FD ${totalsOut?.firstDeposits.toLocaleString() ?? 0} / 总花费 $${(totalsOut?.cost ?? 0).toFixed(2)}` +
    `（本次 ${chunks.length} 分块 upsert ${upserted} 行，失败 ${failedDays.length} 天）`,
  );
  for (const warning of warnings) log(`⚠️ ${warning}`);

  const skipped = upserted === 0 && failedDays.length === 0 ? "区间无数据" : undefined;
  return {
    ok: failedDays.length < chunks.length,
    datePeriod, utcOffset, upserted,
    chunks: chunks.length, failedDays,
    ...(skipped ? { skipped } : {}),
    warnings, totals: totalsOut,
  };
}
