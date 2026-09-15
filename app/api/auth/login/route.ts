import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { buildAuthorizationUrl } from "@/lib/server/auth/oidc";
import { createLoginTransaction } from "@/lib/server/auth/session";

/** 只放行站内相对路径，防开放重定向 */
function safeReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

/**
 * GET /api/auth/login?returnTo=/xxx
 * 发起 OIDC 登录：建登录事务（state/nonce/PKCE 落库）→ 302 到 identity 授权页
 * 用户在 Keycloak/模拟器登录页输密码，之后 identity 带 code 回跳 /api/auth/callback
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
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
    // identity 不可达等：回登录页展示错误，不裸 500
    console.error("[auth/login]", error);
    const code = error instanceof Error && "code" in error ? String((error as { code: string }).code) : "login_failed";
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(code)}`, env.APP_URL), 302);
  }
}
