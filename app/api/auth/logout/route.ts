import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { logAuthRouteFailure } from "@/lib/server/auth/log";
import { buildLogoutUrl } from "@/lib/server/auth/oidc";
import { buildSessionCookie, revokeCurrentSession } from "@/lib/server/auth/session";

/**
 * POST /api/auth/logout
 * 登出：撤销本地 BFF 会话 + 清 cookie，返回 identity 登出 URL 由前端跳转
 * （前端 fetch 收到 302 会跨域自动跟随，故返回 JSON 让浏览器整页跳转）
 *
 * 撤销失败也要把 cookie 清掉并放用户走——本地会话失效是登出的底线，
 * identity 侧登出只是附加动作，拿不到 logoutUrl 时前端回落 /login?signedOut=1。
 */
export async function POST(request: Request): Promise<NextResponse> {
  let logoutUrl: string | null = null;
  try {
    await revokeCurrentSession(request);
    // 落地带 signedOut=1：登录页据此渲染「已退出」态，而不是又自动发起一次 OIDC
    logoutUrl = await buildLogoutUrl(`${env.APP_URL}/login?signedOut=1`);
  } catch (error) {
    logAuthRouteFailure("/api/auth/logout", error);
  }
  const response = NextResponse.json({ ok: true, data: { logoutUrl } });
  response.cookies.set(buildSessionCookie(null));
  return response;
}
