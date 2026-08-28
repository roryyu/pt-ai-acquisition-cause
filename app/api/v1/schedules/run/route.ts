import { handleApiError, ok, requireActor } from "@/lib/server/api-runtime";
import { runDueJobs } from "@/lib/server/scheduler";

/**
 * POST /api/v1/schedules/run — 触发到期任务执行
 * 两种驱动方式：
 * 1. UI「立即检查执行」按钮手动触发
 * 2. 外部 cron 每分钟调用（如：* * * * * curl -X POST http://localhost:3000/api/v1/schedules/run）
 */
export async function POST(request: Request) {
  try {
    await requireActor(request);

    const results = await runDueJobs(new Date());
    return ok({ executed: results.length, results });
  } catch (error) {
    return handleApiError(error);
  }
}
