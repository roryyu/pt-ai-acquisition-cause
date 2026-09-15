import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { buildLogoutUrl } from "@/lib/server/auth/oidc";
import { buildSessionCookie, revokeCurrentSession } from "@/lib/server/auth/session";

/**
 * POST /api/auth/logout
 * 登出：撤销本地 BFF 会话 + 清 cookie，返回 identity 登出 URL 由前端跳转
 * （前端 fetch 收到 302 会跨域自动跟随，故返回 JSON 让浏览器整页跳转）
 */
export async function POST(request: Request): Promise<NextResponse> {
  await revokeCurrentSession(request);
  const logoutUrl = await buildLogoutUrl(`${env.APP_URL}/login`);
  const response = NextResponse.json({ ok: true, data: { logoutUrl } });
  response.cookies.set(buildSessionCookie(null));
  return response;
}
