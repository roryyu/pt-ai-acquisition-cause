import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { newId } from "@/lib/server/ids";
import {
  executeRestRequest, parseBody, resolveRequestUrl,
  type ApiCallResult, type ApiSourceConfig, type RestRequestInput,
} from "./api";

/**
 * API 查询缓存层（design.md 5.1.2 API 适配器「限流、缓存」能力）
 *
 * 落 PostgreSQL（design.md §6.3：Redis 未实施，PG 为当前替代实现）：
 * - cause.api_query_cache：cache_key = sha256(method + 完整 URL + params 按 key 排序)
 * - 命中未过期 → 直接返回（fromCache）；未命中 → 请求后写入
 * - 上游 429/5xx 先指数退避重试（优先遵循 Retry-After），仍失败且存在过期旧值 → 降级返回旧值（stale-while-error）
 * - 简单限流：同一数据源内存最小调用间隔（≥200ms），缓冲 Adjust 50 req/s 速率限制
 *
 * TTL 策略适配 Adjust 数据 T+1 特性（resolveTtlSeconds，纯函数可单测）：
 * - date_period 结束日早于昨天 → 7 天（历史数据已稳定）
 * - 含今天/昨天（yesterday、-Nd:-1d、today 等）→ 30 分钟（数据仍可能修正）
 * - 未识别 → 默认 1 小时
 */

/** 带缓存标注的 API 调用结果 */
export interface CachedApiCallResult extends ApiCallResult {
  /** 是否来自缓存（含 stale 降级） */
  fromCache: boolean;
  /** 缓存状态：fresh 命中 / stale 降级旧值 / miss 未命中实时请求 */
  cacheState: "fresh" | "stale" | "miss";
}

/** 缓存包装选项 */
export interface CachedRestRequestOptions {
  /** 数据源 ID（缓存归属与限流维度） */
  sourceId: string;
  /** 覆盖默认 TTL（秒）；缺省按 date_period 推断 */
  ttlSeconds?: number;
  /** 是否跳过限流等待（脚本/测试场景） */
  skipThrottle?: boolean;
  /** 放宽响应体截断限制（字节，缺省 200KB）：供算子落库扩维取数等大明细场景；
   * 未截断的大响应同样回写缓存（fresh 命中可复用，避免重复大请求） */
  maxBodyBytes?: number;
}

const DEFAULT_TTL_SECONDS = 3600;
const STABLE_TTL_SECONDS = 7 * 86400;
const RECENT_TTL_SECONDS = 1800;
/** 同一数据源最小调用间隔（ms）——单实例内存限流，够用且无外部依赖 */
const MIN_CALL_INTERVAL_MS = 200;
/** 429/5xx 指数退避重试次数（官方建议：指数退避 + 抖动，勿紧密循环重试） */
const MAX_RETRIES = 2;
/** 退避基准与上限（ms） */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const BACKOFF_JITTER_MS = 250;

/**
 * 计算退避等待时长（含随机抖动，避免多客户端同步重试）：
 * 优先遵循上游 Retry-After（retryAfterMs），否则指数退避 base × 2^attempt，上限 10s（纯函数）
 */
export function computeBackoffMs(attempt: number, retryAfterMs?: number): number {
  const jitter = Math.floor(Math.random() * BACKOFF_JITTER_MS);
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs + jitter, BACKOFF_MAX_MS);
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt + jitter, BACKOFF_MAX_MS);
}

const lastCallAt = new Map<string, number>();

/** 计算缓存键：method + endpoint + path + params（按 key 排序，保证稳定性） */
export function computeApiCacheKey(
  method: string,
  endpoint: string,
  path?: string,
  params?: Record<string, string>,
): string {
  const sortedParams = Object.entries(params ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const raw = `${method.toUpperCase()}|${endpoint}|${path ?? ""}|${sortedParams}`;
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * TTL 推断（纯函数）：按 date_period 判断数据是否已稳定
 * @param today 今日（YYYY-MM-DD，UTC），缺省取当前时间
 */
export function resolveTtlSeconds(params?: Record<string, string>, today?: string): number {
  const period = params?.["date_period"];
  if (!period) return DEFAULT_TTL_SECONDS;
  const todayStr = today ?? new Date().toISOString().slice(0, 10);

  // 别名区间：today 实时性强 → 短缓存；yesterday/last_* 含近日 → 短缓存
  if (/^today$/i.test(period)) return RECENT_TTL_SECONDS;
  if (/^(yesterday|last_|this_|-)/i.test(period)) {
    // 相对区间 -Nd:-Md：结束日 offset ≥ 2 天视为稳定
    const relMatch = period.match(/^-(\d+)d:-(\d+)d$/);
    if (relMatch) {
      return Number(relMatch[2]) >= 2 ? STABLE_TTL_SECONDS : RECENT_TTL_SECONDS;
    }
    return RECENT_TTL_SECONDS;
  }
  // 显式日期区间 YYYY-MM-DD:YYYY-MM-DD 或单日：结束日早于昨天 → 长缓存
  const dates = period.split(":").filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length > 0) {
    const end = dates[dates.length - 1]!;
    const yesterday = new Date(`${todayStr}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return end < yesterday.toISOString().slice(0, 10) ? STABLE_TTL_SECONDS : RECENT_TTL_SECONDS;
  }
  return DEFAULT_TTL_SECONDS;
}

/** 限流等待：同一 sourceId 两次调用间隔 ≥ MIN_CALL_INTERVAL_MS */
async function throttle(sourceId: string): Promise<void> {
  const last = lastCallAt.get(sourceId) ?? 0;
  const wait = MIN_CALL_INTERVAL_MS - (Date.now() - last);
  lastCallAt.set(sourceId, Date.now() + Math.max(0, wait));
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * 带缓存与限流的 REST 请求（query_api_source 工具与算子统一取数分流层的统一入口）
 * 缓存读写失败时降级为直连（console.warn，不阻断调用）
 */
export async function cachedRestRequest(
  config: ApiSourceConfig,
  input: RestRequestInput,
  options: CachedRestRequestOptions,
): Promise<CachedApiCallResult> {
  const cacheKey = computeApiCacheKey(input.method, config.endpoint, input.path, input.params);
  const url = resolveRequestUrl(config.endpoint, input.path, input.params);

  // 1. 查缓存（fresh 直接返回）
  let cached: { body: string; contentType: string; status: number; elapsedMs: number; expiresAt: Date } | null = null;
  try {
    const record = await prisma.apiQueryCache.findUnique({ where: { cacheKey } });
    if (record) {
      cached = record;
      if (record.expiresAt.getTime() > Date.now()) {
        await prisma.apiQueryCache.update({
          where: { cacheKey },
          data: { hitCount: { increment: 1 } },
        });
        return {
          status: record.status,
          contentType: record.contentType,
          body: parseBody(record.body, record.contentType),
          elapsedMs: 0,
          truncated: false,
          fromCache: true,
          cacheState: "fresh",
        };
      }
    }
  } catch (error) {
    console.warn("[api-cache] 缓存读取失败，降级直连:", error instanceof Error ? error.message : error);
  }

  // 2. 未命中 → 限流 + 实时请求（429/5xx 指数退避重试，优先遵循 Retry-After）
  if (!options.skipThrottle) await throttle(options.sourceId);
  let result: ApiCallResult;
  try {
    result = await executeRestRequest(config, input, { maxBodyBytes: options.maxBodyBytes });
    for (let attempt = 0; attempt < MAX_RETRIES && (result.status === 429 || result.status >= 500); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, computeBackoffMs(attempt, result.retryAfterMs)));
      result = await executeRestRequest(config, input, { maxBodyBytes: options.maxBodyBytes });
    }
  } catch (error) {
    // 网络异常且有旧缓存 → stale 降级
    if (cached) {
      return {
        status: cached.status,
        contentType: cached.contentType,
        body: parseBody(cached.body, cached.contentType),
        elapsedMs: 0,
        truncated: false,
        fromCache: true,
        cacheState: "stale",
      };
    }
    throw error;
  }

  // 3. 上游 429/5xx 且有旧缓存 → stale 降级
  if ((result.status === 429 || result.status >= 500) && cached) {
    return { ...result, fromCache: true, cacheState: "stale", body: parseBody(cached.body, cached.contentType), status: cached.status };
  }

  // 4. 成功响应（2xx）写入缓存；body 以原始文本存储
  if (result.status >= 200 && result.status < 300 && !result.truncated) {
    const ttl = options.ttlSeconds ?? resolveTtlSeconds(input.params);
    const rawBody = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
    try {
      await prisma.apiQueryCache.upsert({
        where: { cacheKey },
        create: {
          id: newId("api_cache"),
          sourceId: options.sourceId,
          cacheKey,
          method: input.method,
          url,
          status: result.status,
          contentType: result.contentType,
          body: rawBody,
          elapsedMs: result.elapsedMs,
          expiresAt: new Date(Date.now() + ttl * 1000),
        },
        update: {
          status: result.status,
          contentType: result.contentType,
          body: rawBody,
          elapsedMs: result.elapsedMs,
          hitCount: 0,
          expiresAt: new Date(Date.now() + ttl * 1000),
        },
      });
    } catch (error) {
      console.warn("[api-cache] 缓存写入失败（不影响本次结果）:", error instanceof Error ? error.message : error);
    }
  }
  return { ...result, fromCache: false, cacheState: "miss" };
}
