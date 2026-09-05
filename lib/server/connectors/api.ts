/**
 * API 数据源连接器（design.md 5.1 数据接入层 · api 类型）
 *
 * 能力：
 * 1. testApiSource         — 连通性测试（GraphQL 用 { __typename } 探测，REST 用 GET 探测）
 * 2. executeRestRequest    — REST 请求（仅 GET/POST，path 不允许跨 host）
 * 3. executeGraphQLQuery   — GraphQL 查询（只读防护：拒绝 mutation/subscription）
 * 4. introspectGraphQLSchema — GraphQL Schema 内省（Query 根字段列表）
 *
 * 约束：
 * - endpoint 仅允许 http/https
 * - 超时 15s，响应体截断至 200KB
 * - 凭证（authToken/headers）仅在服务端使用，接口层不回显
 */

/** API 数据源配置（存于 data_sources.config） */
export interface ApiSourceConfig {
  /** REST base URL 或 GraphQL endpoint */
  endpoint: string;
  protocol: "rest" | "graphql";
  authType: "none" | "bearer" | "api_key" | "basic";
  /** bearer/basic 凭证或 api key 值 */
  authToken?: string;
  /** api_key 时的 header 名，默认 X-API-Key */
  apiKeyHeader?: string;
  /** 额外自定义 header */
  headers?: Record<string, string>;
}

const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 200 * 1024;

/** endpoint 协议校验 */
export function assertHttpUrl(url: string): { ok: boolean; reason?: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "仅支持 http/https 协议" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "URL 格式非法" };
  }
}

/** 按 authType 组装认证请求头 */
export function buildAuthHeaders(config: ApiSourceConfig): Record<string, string> {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  if (config.authType === "bearer" && config.authToken) {
    headers["authorization"] = `Bearer ${config.authToken}`;
  } else if (config.authType === "basic" && config.authToken) {
    headers["authorization"] = `Basic ${config.authToken}`;
  } else if (config.authType === "api_key" && config.authToken) {
    headers[config.apiKeyHeader || "X-API-Key"] = config.authToken;
  }
  return headers;
}

/**
 * 解析 Retry-After 响应头为毫秒数（纯函数）
 * 支持秒数（如 "120"）与 HTTP-date（如 "Wed, 21 Oct 2026 07:28:00 GMT"）两种格式；
 * 无法解析或已过期返回 undefined（官方建议：429 限流时优先遵循该头部）
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delay = dateMs - Date.now();
    return delay > 0 ? delay : undefined;
  }
  return undefined;
}

async function fetchWithLimits(
  url: string,
  init: RequestInit,
): Promise<{ status: number; contentType: string; body: string; truncated: boolean; retryAfterMs?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    const truncated = raw.length > MAX_BODY_BYTES;
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: truncated ? raw.slice(0, MAX_BODY_BYTES) : raw,
      truncated,
      // 仅限流/服务不可用时读取，供上层指数退避（Adjust 速率限制 50 req/s，超限返回 429）
      ...(response.status === 429 || response.status === 503
        ? { retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")) }
        : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 连接测试 ─────────────────────────────────────────────────────────────────

export interface ApiTestResult {
  ok: boolean;
  kind: "rest" | "graphql";
  latencyMs: number;
  statusCode?: number;
  error?: string;
  /** endpoint 可达但存在异常语义时的诊断提示（如 401 认证被拒、400 缺必填参数） */
  hint?: string;
}

/** REST 探测状态码 → 诊断提示（endpoint 可达但认证/参数异常时帮助定位，缺 token 时上游实际返 401 而非 400） */
function restTestHint(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return `endpoint 可达但认证被拒（HTTP ${status}）：请检查认证方式与 API Token 是否已配置且有效`;
  }
  if (status === 400) {
    return "endpoint 可达但探测请求被拒（HTTP 400）：endpoint 指向具体接口时通常为缺少必填参数（如 date_period），请在请求台带参验证";
  }
  if (status === 404) {
    return "根路径探测 404（未能验证认证有效性）：请在下方请求台用真实路径与参数验证";
  }
  return undefined;
}

/** 连通性测试：GraphQL 发 __typename 探测；REST 发 GET（status < 500 即视为可达） */
export async function testApiSource(config: ApiSourceConfig): Promise<ApiTestResult> {
  const check = assertHttpUrl(config.endpoint);
  const start = Date.now();
  if (!check.ok) {
    return { ok: false, kind: config.protocol, latencyMs: 0, error: check.reason };
  }
  try {
    if (config.protocol === "graphql") {
      const result = await fetchWithLimits(config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...buildAuthHeaders(config) },
        body: JSON.stringify({ query: "{ __typename }" }),
      });
      const ok = result.status < 400;
      return {
        ok,
        kind: "graphql",
        latencyMs: Date.now() - start,
        statusCode: result.status,
        error: ok
          ? undefined
          : result.status === 401 || result.status === 403
            ? `GraphQL endpoint 返回 HTTP ${result.status}（认证被拒，请检查 API Token 是否已配置且有效）`
            : `GraphQL endpoint 返回 HTTP ${result.status}`,
      };
    }
    const result = await fetchWithLimits(config.endpoint, {
      method: "GET",
      headers: buildAuthHeaders(config),
    });
    const ok = result.status < 500;
    return {
      ok,
      kind: "rest",
      latencyMs: Date.now() - start,
      statusCode: result.status,
      error: ok ? undefined : `endpoint 返回 HTTP ${result.status}`,
      hint: restTestHint(result.status),
    };
  } catch (error) {
    return {
      ok: false,
      kind: config.protocol,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── REST 请求 ────────────────────────────────────────────────────────────────

export interface RestRequestInput {
  method: "GET" | "POST";
  /** 相对路径（拼接到 endpoint），如 /v1/users */
  path?: string;
  /** query 参数 */
  params?: Record<string, string>;
  /** POST 请求体（JSON） */
  body?: unknown;
}

export interface ApiCallResult {
  status: number;
  contentType: string;
  /** 响应体（JSON 可解析时为对象，否则为文本） */
  body: unknown;
  elapsedMs: number;
  truncated: boolean;
  /** 429/503 时上游 Retry-After 头部解析结果（毫秒），供退避重试 */
  retryAfterMs?: number;
}

/**
 * 将 path 安全拼接到 endpoint（不允许换 host/协议）
 *
 * 拼接语义：保留 endpoint 的 base path——path 去除前导斜杠后追加到
 * endpoint 路径末尾（无尾斜杠自动补）。如 endpoint 为
 * `https://host/reports-service`、path 为 `/csv_report` 或 `csv_report`，
 * 均拼为 `https://host/reports-service/csv_report`（而非丢失 base path）。
 * endpoint 为纯域名时行为与标准相对路径解析一致。
 */
export function resolveRequestUrl(endpoint: string, path?: string, params?: Record<string, string>): string {
  const base = new URL(endpoint);
  let url = base;
  if (path && path.length > 0) {
    const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    url = new URL(basePath + path.replace(/^\/+/, ""), base.origin);
  }
  if (url.origin !== base.origin) {
    throw new Error("path 不允许指向其他主机");
  }
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** 响应体解析：JSON（按 content-type 或形态启发）可解析时返回对象，否则保留原文（如 CSV） */
export function parseBody(raw: string, contentType: string): unknown {
  if (/json/i.test(contentType) || /^[\[{]/.test(raw.trim())) {
    try {
      return JSON.parse(raw);
    } catch {
      /* 保留原文 */
    }
  }
  return raw;
}

/** 执行 REST 请求（仅 GET/POST） */
export async function executeRestRequest(
  config: ApiSourceConfig,
  input: RestRequestInput,
): Promise<ApiCallResult> {
  const check = assertHttpUrl(config.endpoint);
  if (!check.ok) throw new Error(check.reason);
  if (input.method !== "GET" && input.method !== "POST") {
    throw new Error("仅允许 GET / POST 请求");
  }
  const url = resolveRequestUrl(config.endpoint, input.path, input.params);
  const start = Date.now();
  const result = await fetchWithLimits(url, {
    method: input.method,
    headers: {
      accept: "application/json, text/plain, */*",
      ...(input.method === "POST" ? { "content-type": "application/json" } : {}),
      ...buildAuthHeaders(config),
    },
    body: input.method === "POST" && input.body !== undefined ? JSON.stringify(input.body) : undefined,
  });
  return {
    status: result.status,
    contentType: result.contentType,
    body: parseBody(result.body, result.contentType),
    elapsedMs: Date.now() - start,
    truncated: result.truncated,
    retryAfterMs: result.retryAfterMs,
  };
}

// ─── GraphQL ─────────────────────────────────────────────────────────────────

/**
 * 只读防护：解析文档首个操作关键字，拒绝 mutation/subscription。
 * 允许匿名查询（{ ... }）、query 操作与 fragment 前置定义。
 */
export function assertReadOnlyGraphQL(query: string): { ok: boolean; reason?: string } {
  // 去除注释与字符串，避免误判（如字段描述里出现 mutation 字样）
  const stripped = query
    .replace(/#[^\n]*/g, " ")
    .replace(/"([^"\\]|\\.)*"/g, '""');
  const match = stripped.match(/\b(query|mutation|subscription)\b/);
  const firstBrace = stripped.indexOf("{");
  if (match && (firstBrace === -1 || match.index! < firstBrace)) {
    if (match[1] === "mutation" || match[1] === "subscription") {
      return { ok: false, reason: `仅允许只读查询，禁止 ${match[1]} 操作` };
    }
  }
  return { ok: true };
}

export interface GraphQLResult {
  data: unknown;
  errors?: unknown[];
  elapsedMs: number;
  truncated: boolean;
}

/** 执行 GraphQL 查询（只读） */
export async function executeGraphQLQuery(
  config: ApiSourceConfig,
  input: { query: string; variables?: Record<string, unknown> },
): Promise<GraphQLResult> {
  const urlCheck = assertHttpUrl(config.endpoint);
  if (!urlCheck.ok) throw new Error(urlCheck.reason);
  const readonlyCheck = assertReadOnlyGraphQL(input.query);
  if (!readonlyCheck.ok) throw new Error(readonlyCheck.reason);

  const start = Date.now();
  const result = await fetchWithLimits(config.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...buildAuthHeaders(config) },
    body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
  });
  const parsed = parseBody(result.body, result.contentType);
  if (result.status >= 400) {
    throw new Error(`GraphQL endpoint 返回 HTTP ${result.status}`);
  }
  const payload = (parsed ?? {}) as { data?: unknown; errors?: unknown[] };
  return {
    data: payload.data ?? null,
    errors: payload.errors,
    elapsedMs: Date.now() - start,
    truncated: result.truncated,
  };
}

// ─── GraphQL Schema 内省 ──────────────────────────────────────────────────────

export interface GraphQLFieldMeta {
  name: string;
  description: string;
  args: Array<{ name: string; type: string }>;
  returnType: string;
}

/** 按指定 ofType 嵌套深度生成内省查询（部分网关如 GraphCDN 限制查询深度，需逐级降级） */
function buildIntrospectionQuery(ofTypeDepth: number): string {
  let typeRef = "kind name";
  for (let i = 0; i < ofTypeDepth; i++) {
    typeRef = `kind name ofType { ${typeRef} }`;
  }
  return `query IntrospectQueryRoot {
  __schema {
    queryType {
      fields {
        name
        description
        args { name type { ${typeRef} } }
        type { ${typeRef} }
      }
    }
  }
}`;
}

interface IntrospectionTypeRef {
  kind: string;
  name: string | null;
  ofType?: IntrospectionTypeRef | null;
}

/** 将 introspection TypeRef 渲染为可读类型名（如 [User!]!） */
function renderTypeRef(ref: IntrospectionTypeRef | null | undefined): string {
  if (!ref) return "Unknown";
  if (ref.kind === "NON_NULL") return `${renderTypeRef(ref.ofType)}!`;
  if (ref.kind === "LIST") return `[${renderTypeRef(ref.ofType)}]`;
  return ref.name ?? "Unknown";
}

/** 内省 GraphQL Schema，返回 Query 根字段列表（截断至前 80 个；深度受限时逐级降级重试） */
export async function introspectGraphQLSchema(config: ApiSourceConfig): Promise<GraphQLFieldMeta[]> {
  let lastError: unknown;
  for (const depth of [3, 2, 1]) {
    let result: GraphQLResult;
    try {
      result = await executeGraphQLQuery(config, { query: buildIntrospectionQuery(depth) });
    } catch (error) {
      lastError = error;
      continue;
    }
    const data = result.data as {
      __schema?: {
        queryType?: {
          fields?: Array<{
            name: string;
            description: string | null;
            args: Array<{ name: string; type: IntrospectionTypeRef }>;
            type: IntrospectionTypeRef;
          }>;
        };
      };
    } | null;
    const fields = data?.__schema?.queryType?.fields ?? [];
    if (fields.length === 0) {
      lastError = new Error(
        result.errors?.length
          ? `Schema 内省失败：${JSON.stringify(result.errors).slice(0, 300)}`
          : "Schema 内省未返回任何 Query 字段",
      );
      continue;
    }
    return fields.slice(0, 80).map((f) => ({
      name: f.name,
      description: (f.description ?? "").slice(0, 200),
      args: f.args.map((a) => ({ name: a.name, type: renderTypeRef(a.type) })),
      returnType: renderTypeRef(f.type),
    }));
  }
  throw lastError instanceof Error ? lastError : new Error("Schema 内省失败");
}
