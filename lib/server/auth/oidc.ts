/**
 * OIDC 客户端（Authorization Code + PKCE，对接 Access identity 容器）
 * 设计见 doc/鉴权接入PT-AI-Access设计.md：不依赖 @pt-ai/bff-auth（appId 硬枚举不含 cause），
 * 仅用 jose 做 ID Token RS256 验签；token 全部留在服务端，浏览器只见一次性 code。
 */
import { createHash, randomBytes } from "node:crypto";

import { createRemoteJWKSet, jwtVerify } from "jose";

import { env } from "@/lib/env";

/** ID Token 载荷：cause 消费的最小 claim 集 */
export interface IdTokenClaims {
  sub: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  nonce?: string;
}

interface OidcEndpoints {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

/** OIDC 流程错误（code 用于登录页展示定位） */
export class OidcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OidcError";
  }
}

// ─── discovery（内存缓存 1 小时，重启/换 issuer 后自动刷新） ────────────────
let endpointsCache: { at: number; endpoints: OidcEndpoints } | null = null;
const DISCOVERY_TTL_MS = 3_600_000;

export async function getOidcEndpoints(): Promise<OidcEndpoints> {
  if (endpointsCache && Date.now() - endpointsCache.at < DISCOVERY_TTL_MS) {
    return endpointsCache.endpoints;
  }
  const url = `${env.OIDC_ISSUER.replace(/\/$/, "")}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch {
    throw new OidcError("discovery_unreachable", `无法连接 Identity 服务（${url}），请确认 pt-access / Keycloak 已启动`);
  }
  if (!response.ok) {
    throw new OidcError("discovery_failed", `OIDC discovery 返回 ${response.status}`);
  }
  const data = (await response.json()) as Partial<OidcEndpoints>;
  if (!data.authorization_endpoint || !data.token_endpoint || !data.jwks_uri) {
    throw new OidcError("discovery_invalid", "OIDC discovery 响应缺少必要端点");
  }
  const endpoints: OidcEndpoints = {
    issuer: data.issuer ?? env.OIDC_ISSUER,
    authorization_endpoint: data.authorization_endpoint,
    token_endpoint: data.token_endpoint,
    jwks_uri: data.jwks_uri,
    end_session_endpoint: data.end_session_endpoint,
  };
  endpointsCache = { at: Date.now(), endpoints };
  return endpoints;
}

// ─── 基础工具 ────────────────────────────────────────────────────────────
/** 生成 base64url 随机串（state / nonce / verifier / session token 通用） */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** SHA-256 十六进制摘要（敏感值入库前统一哈希，明文不落库） */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** PKCE S256：code_verifier → code_challenge */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ─── 授权请求 ────────────────────────────────────────────────────────────
/** 构造跳转 identity 授权端点的 URL（用户在 Keycloak 登录页输密码） */
export async function buildAuthorizationUrl(params: {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}): Promise<string> {
  const endpoints = await getOidcEndpoints();
  const url = new URL(endpoints.authorization_endpoint);
  url.searchParams.set("client_id", env.OIDC_CLIENT_ID);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ─── code 兑换 + ID Token 验签 ───────────────────────────────────────────
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * 用授权码兑换 ID Token 并验签（RS256 + iss/aud/exp + nonce 比对）
 * client_secret_post 认证；任何一步失败都抛 OidcError，绝不带病建会话
 */
export async function exchangeCodeForIdToken(params: {
  code: string;
  verifier: string;
  redirectUri: string;
  expectedNonce: string;
}): Promise<IdTokenClaims> {
  const endpoints = await getOidcEndpoints();
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: env.OIDC_CLIENT_ID,
    client_secret: env.OIDC_CLIENT_SECRET,
    code_verifier: params.verifier,
  });
  let response: Response;
  try {
    response = await fetch(endpoints.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      cache: "no-store",
    });
  } catch {
    throw new OidcError("token_unreachable", `无法连接 token 端点（${endpoints.token_endpoint}）`);
  }
  const data = (await response.json().catch(() => null)) as {
    id_token?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (!response.ok || !data?.id_token) {
    throw new OidcError(
      "token_exchange_failed",
      `授权码兑换失败：${data?.error_description ?? data?.error ?? `HTTP ${response.status}`}`,
    );
  }

  let jwks = jwksCache.get(endpoints.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(endpoints.jwks_uri));
    jwksCache.set(endpoints.jwks_uri, jwks);
  }
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(data.id_token, jwks, {
      issuer: endpoints.issuer,
      audience: env.OIDC_CLIENT_ID,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    throw new OidcError("id_token_invalid", `ID Token 验签失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (payload.nonce !== params.expectedNonce) {
    throw new OidcError("nonce_mismatch", "ID Token nonce 与登录事务不一致（疑似重放）");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new OidcError("subject_missing", "ID Token 缺少 sub");
  }
  return {
    sub: payload.sub,
    name: typeof payload.name === "string" ? payload.name : undefined,
    preferred_username: typeof payload.preferred_username === "string" ? payload.preferred_username : undefined,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}

// ─── 登出 ────────────────────────────────────────────────────────────────
/** 构造 identity 登出 URL（登出后回跳 cause 登录页；无 end_session_endpoint 时返回 null） */
export async function buildLogoutUrl(postLogoutRedirectUri: string): Promise<string | null> {
  const endpoints = await getOidcEndpoints().catch(() => null);
  if (!endpoints?.end_session_endpoint) return null;
  const url = new URL(endpoints.end_session_endpoint);
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
  url.searchParams.set("client_id", env.OIDC_CLIENT_ID);
  return url.toString();
}
