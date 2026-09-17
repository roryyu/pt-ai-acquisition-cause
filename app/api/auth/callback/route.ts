import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { activateSession } from "@/lib/server/auth/access-client";
import { authFailureCode, logAuthRouteFailure } from "@/lib/server/auth/log";
import { exchangeCodeForIdToken, OidcError } from "@/lib/server/auth/oidc";
import { safeRelativeReturnTo } from "@/lib/server/auth/safe-return-to";
import {
  buildSessionCookie,
  claimLoginTransaction,
  createSession,
  upsertUserFromPrincipal,
} from "@/lib/server/auth/session";

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
  // 登录事务里存的回跳目标：失败时一并带回登录页，用户重试后仍落回原页面
  let returnTo = "/";
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
    returnTo = safeRelativeReturnTo(transaction.returnTo, "/");

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
    const response = NextResponse.redirect(new URL(returnTo, env.APP_URL), 302);
    response.cookies.set(buildSessionCookie(token));
    console.log(`[auth/callback] 登录成功 sub=${principal.subject} username=${principal.username}`);
    return response;
  } catch (error) {
    // 失败一律 302 回登录页展示分类错误（不裸 500），并留结构化日志便于排障
    logAuthRouteFailure(url.pathname, error);
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent(authFailureCode(error))}&returnTo=${encodeURIComponent(returnTo)}`,
        env.APP_URL,
      ),
      302,
    );
  }
}
