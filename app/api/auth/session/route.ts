import { NextResponse } from "next/server";

import { ok } from "@/lib/server/api-runtime";
import { AccessUnavailableError } from "@/lib/server/auth/access-client";
import { getSessionActor } from "@/lib/server/auth/session";

/**
 * GET /api/auth/session
 * 当前登录身份（topbar 用户区消费）：未登录 401，Access 不可达 503（fail-closed）
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const actor = await getSessionActor(request);
    if (!actor) {
      return NextResponse.json(
        { ok: false, error: { code: "UNAUTHORIZED", message: "未登录或会话已失效", retryable: false } },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
    return ok({ id: actor.id, name: actor.name, email: actor.email, role: actor.role });
  } catch (error) {
    if (error instanceof AccessUnavailableError) {
      return NextResponse.json(
        { ok: false, error: { code: "ACCESS_UNAVAILABLE", message: error.message, retryable: true } },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    throw error;
  }
}
