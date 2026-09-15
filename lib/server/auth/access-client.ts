/**
 * Access access-app 内部接口客户端（/internal/session-activated、/internal/principal）
 * 设计见 doc/鉴权接入PT-AI-Access设计.md D5：
 * - 登录时刻 session-activated 实时调用（不缓存），entitlement 不过则拒绝建会话
 * - 请求期 principal 复核带 60s 内存缓存；Access 不可达时 fail-closed（拒绝而非放行）
 */
import { env } from "@/lib/env";

/** Access principal（结构对齐 access-app 的 formatUser） */
export interface AccessPrincipal {
  id: string;
  subject: string;
  username: string;
  usernameDisplay: string;
  email: string | null;
  displayName: string;
  status: string;
  accessRoles: string[];
  entitlements: string[];
}

/** Access 明确拒绝（403，带错误码：account_not_provisioned / account_disabled / entry_entitlement_required 等） */
export class AccessDeniedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

/** Access 不可达或异常（fail-closed：调用方应拒绝请求） */
export class AccessUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessUnavailableError";
  }
}

interface InternalEnvelope {
  principal?: AccessPrincipal;
  error?: { code?: string; message?: string };
}

async function callInternal(path: "/internal/session-activated" | "/internal/principal", subject: string): Promise<AccessPrincipal> {
  const url = `${env.ACCESS_INTERNAL_BASE_URL.replace(/\/$/, "")}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pt-access-internal-secret": env.ACCESS_INTERNAL_SECRET,
      },
      body: JSON.stringify({ subject, entryId: env.ACCESS_ENTRY_ID }),
      cache: "no-store",
    });
  } catch {
    throw new AccessUnavailableError(`无法连接 Access 内部接口（${url}），请确认 access-app / pt-access 模拟器已启动`);
  }
  const data = (await response.json().catch(() => null)) as InternalEnvelope | null;
  if (response.status === 403) {
    throw new AccessDeniedError(data?.error?.code ?? "access_denied", data?.error?.message ?? "Access 拒绝了该账号");
  }
  if (!response.ok || !data?.principal) {
    throw new AccessUnavailableError(`Access 内部接口异常：${data?.error?.message ?? `HTTP ${response.status}`}`);
  }
  return data.principal;
}

/** 登录回调时刻：Entry Gate 校验（账号开通 / 状态 / cause entitlement），实时不缓存 */
export function activateSession(subject: string): Promise<AccessPrincipal> {
  return callInternal("/internal/session-activated", subject);
}

// ─── 请求期复核（带缓存） ─────────────────────────────────────────────────
interface CacheEntry {
  at: number;
  principal: AccessPrincipal;
}
const principalCache = new Map<string, CacheEntry>();

/**
 * 请求期 principal 复核：缓存命中直接返回；未命中实时调用并回填。
 * Access 不可达时 fail-closed 抛 AccessUnavailableError（有 stale 缓存也不放行，
 * 避免权限撤销后仍可访问的窗口被无限拉长）。
 */
export async function fetchPrincipal(subject: string): Promise<AccessPrincipal> {
  const ttlMs = env.ACCESS_PRINCIPAL_CACHE_SECONDS * 1000;
  const cached = principalCache.get(subject);
  if (cached && Date.now() - cached.at < ttlMs) {
    return cached.principal;
  }
  const principal = await callInternal("/internal/principal", subject);
  principalCache.set(subject, { at: Date.now(), principal });
  return principal;
}

/** 登出/会话撤销时清理缓存 */
export function invalidatePrincipal(subject: string): void {
  principalCache.delete(subject);
}
