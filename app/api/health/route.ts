import { NextResponse } from "next/server";

/**
 * GET /api/health
 * 存活探针：仅确认进程与 HTTP 服务可用，不触达数据库 / Access / 模型网关
 * （单实例部署摘流量无意义，依赖故障由对应接口自身报错）
 * 消费方：docker healthcheck、ALB 目标组健康检查、verify.md
 */
export function GET(): NextResponse {
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
