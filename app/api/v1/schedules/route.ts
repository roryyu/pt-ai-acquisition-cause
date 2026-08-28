import { z } from "zod";
import {
  ApiError,
  handleApiError,
  ok,
  readJson,
  requireActor,
} from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";
import { newId } from "@/lib/server/ids";
import { isValidCron, nextRunDate } from "@/lib/server/scheduler";

const CreateScheduleSchema = z.object({
  docId: z.string().min(1),
  action: z.enum(["email", "export"]).default("email"),
  /** 标准 5 段 cron 表达式，例：0 9 * * *（每天 9 点） */
  cronExpr: z.string().min(9).max(100),
  recipients: z.array(z.string().email()).default([]),
  enabled: z.boolean().default(true),
});

/**
 * GET /api/v1/schedules — 定时任务列表（?docId= 过滤指定文档）
 */
export async function GET(request: Request) {
  try {
    await requireActor(request);
    const docId = new URL(request.url).searchParams.get("docId");

    const jobs = await prisma.scheduleJob.findMany({
      where: docId ? { docId } : {},
      orderBy: { createdAt: "desc" },
      include: { doc: { select: { id: true, title: true, kind: true } } },
    });

    return ok({ jobs });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST /api/v1/schedules — 创建定时任务（校验 cron 表达式并计算首次执行时间）
 */
export async function POST(request: Request) {
  try {
    await requireActor(request);
    const input = CreateScheduleSchema.parse(await readJson<unknown>(request));

    if (!isValidCron(input.cronExpr)) {
      throw new ApiError(400, "INVALID_CRON", "cron 表达式不合法，示例：0 9 * * *");
    }

    const doc = await prisma.insightDoc.findUnique({ where: { id: input.docId } });
    if (!doc) throw new ApiError(404, "INSIGHT_NOT_FOUND", "洞察文档不存在");

    const job = await prisma.scheduleJob.create({
      data: {
        id: newId("schedule"),
        docId: input.docId,
        action: input.action,
        cronExpr: input.cronExpr,
        recipients: input.recipients,
        enabled: input.enabled,
        nextRunAt: nextRunDate(input.cronExpr),
      },
    });

    return ok(job, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
