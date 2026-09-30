import { NextResponse } from "next/server";

/**
 * GET /api/health/live
 * 存活探针：仅确认进程与 HTTP 服务可用，不触达数据库 / Access / 模型网关
 * （与 /api/health 同语义，供 K8s livenessProbe 等编排平台约定路径使用）
 */
export function GET(): NextResponse {
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
