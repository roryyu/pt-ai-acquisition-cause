import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { authFailureCode, logAuthRouteFailure } from "@/lib/server/auth/log";
import { buildAuthorizationUrl } from "@/lib/server/auth/oidc";
import { safeRelativeReturnTo } from "@/lib/server/auth/safe-return-to";
import { createLoginTransaction } from "@/lib/server/auth/session";

/**
 * GET /api/auth/login?returnTo=/xxx
 * 发起 OIDC 登录：建登录事务（state/nonce/PKCE 落库）→ 302 到 identity 授权页
 * 用户在 Keycloak/模拟器登录页输密码，之后 identity 带 code 回跳 /api/auth/callback
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const returnTo = safeRelativeReturnTo(url.searchParams.get("returnTo"), "/");
  try {
    const { state, nonce, codeChallenge } = await createLoginTransaction(returnTo);
    const authorizationUrl = await buildAuthorizationUrl({
      state,
      nonce,
      codeChallenge,
      redirectUri: `${env.APP_URL}/api/auth/callback`,
    });
    return NextResponse.redirect(authorizationUrl, 302);
  } catch (error) {
    // identity 不可达等：回登录页展示分类错误，不裸 500
    logAuthRouteFailure(url.pathname, error);
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(authFailureCode(error))}&returnTo=${encodeURIComponent(returnTo)}`, env.APP_URL),
      302,
    );
  }
}
