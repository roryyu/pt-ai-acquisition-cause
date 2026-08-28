import { z } from "zod";
import {
  ApiError,
  handleApiError,
  ok,
  readJson,
  requireActor,
} from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";
import { isValidCron, nextRunDate } from "@/lib/server/scheduler";

const UpdateScheduleSchema = z.object({
  cronExpr: z.string().min(9).max(100).optional(),
  recipients: z.array(z.string().email()).optional(),
  enabled: z.boolean().optional(),
});

/**
 * PUT /api/v1/schedules/[id] — 更新定时任务（修改 cron 时重算下次执行时间）
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;
    const input = UpdateScheduleSchema.parse(await readJson<unknown>(request));

    if (input.cronExpr !== undefined && !isValidCron(input.cronExpr)) {
      throw new ApiError(400, "INVALID_CRON", "cron 表达式不合法，示例：0 9 * * *");
    }

    const job = await prisma.scheduleJob.update({
      where: { id },
      data: {
        ...(input.cronExpr !== undefined
          ? { cronExpr: input.cronExpr, nextRunAt: nextRunDate(input.cronExpr) }
          : {}),
        ...(input.recipients !== undefined ? { recipients: input.recipients } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
    });

    return ok(job);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/v1/schedules/[id] — 删除定时任务
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;

    await prisma.scheduleJob.delete({ where: { id } });
    return ok({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
