/**
 * 客户端统一请求封装。
 *
 * 服务端（见 lib/server/api-runtime.ts）约定：
 * - 成功：HTTP 200 + `{ ok: true, data }`
 * - 失败：真实 HTTP 状态码（4xx/5xx）+ `{ ok: false, error: { code, message, ... } }`
 *
 * `fetch()` 在 4xx/5xx 时并不会 reject，若直接 `await res.json()`：
 * 1. 会把 HTTP 错误体当成成功响应处理；
 * 2. 遇到网关/代理返回的非 JSON 错误页（如 502 HTML）时 `res.json()` 直接抛错。
 *
 * 本封装统一：检查 `res.ok`、安全解析响应体、把网络异常与非 JSON 错误页
 * 归一为 `{ ok: false, error }` 信封，使调用点保持原有的 `if (json.ok)` 控制流。
 */

/** 服务端错误体（与 api-runtime 的 handleApiError 输出对齐） */
export interface ApiErrorBody {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: unknown;
}

/** 统一响应信封：成功携带 data，失败携带 error */
export type ApiEnvelope<T = any> =
  | { ok: true; data: T; error?: undefined }
  | { ok: false; error: ApiErrorBody; data?: undefined };

/** 由 HTTP 状态码合成一个错误信封（服务端未返回标准错误体时使用） */
function httpErrorEnvelope(status: number): ApiEnvelope {
  return {
    ok: false,
    error: {
      code: `HTTP_${status}`,
      message: `请求失败（HTTP ${status}）`,
      retryable: status >= 500,
    },
  };
}

/** 401 跳转去重：并发请求同时失败时只触发一次整页跳转 */
let redirectingToLogin = false;

/** 会话失效统一处理：整页跳转发起 OIDC 登录，带回跳地址 */
function redirectToLogin(): void {
  if (redirectingToLogin || typeof window === "undefined") return;
  redirectingToLogin = true;
  const returnTo = window.location.pathname + window.location.search;
  window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
}

/**
 * 发起请求并返回统一信封，永不 reject（网络异常/非 JSON 响应均归一为 `{ ok: false }`）。
 *
 * 用法（与原 `fetch` + `res.json()` 完全兼容）：
 * ```ts
 * const json = await apiFetch("/api/v1/xxx", { method: "POST", body: ... });
 * if (json.ok) use(json.data);
 * else setError(json.error?.message ?? "失败");
 * ```
 */
export async function apiFetch<T = any>(
  url: string,
  init?: RequestInit,
): Promise<ApiEnvelope<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    // 网络层异常（断网、CORS、超时等）
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: error instanceof Error ? error.message : "网络请求失败",
        retryable: true,
      },
    };
  }

  // 安全解析响应体：网关/代理错误页可能不是 JSON
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    // 401（会话失效/未登录）：整页跳转发起 OIDC 登录；auth 自身接口除外，避免死循环
    if (res.status === 401 && !url.startsWith("/api/auth/")) {
      redirectToLogin();
    }
    // 优先采用服务端返回的标准错误信封，否则按状态码合成
    const envelope = body as ApiEnvelope<T> | null;
    if (envelope && envelope.ok === false && envelope.error) {
      return envelope;
    }
    return httpErrorEnvelope(res.status) as ApiEnvelope<T>;
  }

  // res.ok：正常应为 { ok: true, data }
  if (body && typeof body === "object" && "ok" in body) {
    return body as ApiEnvelope<T>;
  }
  return {
    ok: false,
    error: { code: "EMPTY_RESPONSE", message: "响应体为空或格式异常", retryable: false },
  };
}
