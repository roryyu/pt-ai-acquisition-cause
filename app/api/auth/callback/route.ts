import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import {
  AccessDeniedError,
  AccessUnavailableError,
  activateSession,
} from "@/lib/server/auth/access-client";
import { exchangeCodeForIdToken, OidcError } from "@/lib/server/auth/oidc";
import {
  buildSessionCookie,
  claimLoginTransaction,
  createSession,
  upsertUserFromPrincipal,
} from "@/lib/server/auth/session";

/** 错误码归一：失败一律 302 回登录页展示，不裸 500 */
function toErrorCode(error: unknown): string {
  if (error instanceof OidcError) return error.code;
  if (error instanceof AccessDeniedError) return error.code;
  if (error instanceof AccessUnavailableError) return "access_unavailable";
  return "internal_error";
}

function redirectToLogin(errorCode: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(errorCode)}`, env.APP_URL),
    302,
  );
}

/**
 * GET /api/auth/callback?code=xxx&state=xxx
 * OIDC 回跳（用户看不见的服务端链路）：
 * 1. state → 消费登录事务（防 CSRF/重放，一次性）
 * 2. code + PKCE verifier → identity token 端点兑换 ID Token，jose 验签 + nonce 比对
 * 3. sub → access-app /internal/session-activated（账号开通/状态/cause entitlement 三连检）
 * 4. 全过 → JIT 落地本地 User + 建 BFF 会话 → 种 httpOnly cookie → 302 业务页
 * 任何一步失败 → 302 /login?error=<code>
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  try {
    // identity 侧直接拒绝（如用户取消）
    const providerError = url.searchParams.get("error");
    if (providerError) {
      throw new OidcError("provider_denied", `Identity 返回错误：${providerError}`);
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      throw new OidcError("missing_params", "回调缺少 code 或 state");
    }

    const transaction = await claimLoginTransaction(state);
    if (!transaction) {
      throw new OidcError("invalid_state", "登录事务无效或已过期，请重新登录");
    }

    const claims = await exchangeCodeForIdToken({
      code,
      verifier: transaction.verifier,
      redirectUri: `${env.APP_URL}/api/auth/callback`,
      expectedNonce: transaction.nonce,
    });

    // Entry Gate：Access 实时校验 entitlement，403 抛 AccessDeniedError
    const principal = await activateSession(claims.sub);
    await upsertUserFromPrincipal(principal);

    const token = await createSession(principal.subject);
    const response = NextResponse.redirect(new URL(transaction.returnTo ?? "/", env.APP_URL), 302);
    response.cookies.set(buildSessionCookie(token));
    console.log(`[auth/callback] 登录成功 sub=${principal.subject} username=${principal.username}`);
    return response;
  } catch (error) {
    console.error("[auth/callback] 登录失败:", error);
    return redirectToLogin(toErrorCode(error));
  }
}
