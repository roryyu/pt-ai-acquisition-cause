import { z } from "zod";
import {
  ApiError,
  handleApiError,
  ok,
  readJson,
  requireActor,
} from "@/lib/server/api-runtime";
import {
  AdjustSyncConfigError,
  runAdjustSync,
} from "@/lib/server/integrations/adjust-sync";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SyncAdjustSchema = z
  .object({
    /** 回补天数（默认 3：昨日 + 回补 2 天，覆盖 Adjust T+1 数据修正窗口；全量回补可放大） */
    days: z.number().int().min(1).max(400).optional(),
    /** 绝对区间起（YYYY-MM-DD，含端点）；与 to 同时提供时按绝对日期回补历史中段，优先于 days */
    from: z.string().regex(ISO_DATE).optional(),
    /** 绝对区间止（YYYY-MM-DD，含端点）；须与 from 同时提供 */
    to: z.string().regex(ISO_DATE).optional(),
    /** 清空重建：DROP 后按最新 5 维 DDL 重建再回补（PK 变更/全量重同步用，默认 false 走幂等 upsert） */
    reset: z.boolean().optional(),
  })
  .refine((d) => Boolean(d.from) === Boolean(d.to), {
    message: "from 与 to 必须同时提供",
    path: ["from"],
  });

/**
 * POST /api/v1/syncs/adjust — 触发 Adjust 报告服务数据同步（API → 本地 PG → 语义层）
 *
 * 定时驱动方式（项目无常驻定时器，与 /api/v1/schedules/run 同一约定）：
 * 外部 cron 每日调用，如：
 *   30 9 * * * curl -X POST http://localhost:3000/api/v1/syncs/adjust -d '{"days":3}'
 * （Adjust 数据 T+1，每日上午拉昨日数据并回补 3 天覆盖修正窗口；幂等可重跑）
 * 回补历史中段用绝对区间：-d '{"from":"2026-05-01","to":"2026-05-30"}'
 */
export async function POST(request: Request) {
  try {
    await requireActor(request);
    const input = SyncAdjustSchema.parse(await readJson<unknown>(request).catch(() => ({})));

    const result = await runAdjustSync(input);
    return ok(result);
  } catch (error) {
    if (error instanceof AdjustSyncConfigError) {
      return handleApiError(new ApiError(503, "ADJUST_NOT_CONFIGURED", error.message));
    }
    return handleApiError(error);
  }
}
