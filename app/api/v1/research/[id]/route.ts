import { handleApiError, ok, requireActor } from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";

/**
 * GET /api/v1/research/[id] — 深度研究任务详情（主任务 + 子任务 + 报告）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;

    const task = await prisma.researchTask.findUnique({
      where: { id },
      include: {
        question: { select: { id: true, content: true, answer: true, status: true } },
      },
    });
    if (!task) {
      return handleApiError({ status: 404, code: "TASK_NOT_FOUND", message_: "研究任务不存在" });
    }

    const subTasks = await prisma.researchTask.findMany({
      where: { parentTaskId: id },
      orderBy: { createdAt: "asc" },
    });

    return ok({
      task: {
        id: task.id,
        questionId: task.question?.id ?? null,
        question: task.question?.content ?? "",
        status: task.status,
        agentType: task.agentType,
        input: task.input,
        output: task.output,
        citations: task.citations,
        createdAt: task.createdAt,
        completedAt: task.completedAt,
        answer: task.question?.answer ?? null,
      },
      subTasks: subTasks.map((s) => ({
        id: s.id,
        agentType: s.agentType,
        status: s.status,
        input: s.input,
        output: s.output,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/v1/research/[id] — 删除研究任务（含子任务与关联问答）
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;

    const task = await prisma.researchTask.findUnique({ where: { id } });
    if (!task) {
      return handleApiError({ status: 404, code: "TASK_NOT_FOUND", message_: "研究任务不存在" });
    }

    // 画布绑定收敛：指向该研究任务及其关联问答的实时绑定标记为源已删除
    await prisma.canvasBinding.updateMany({
      where: {
        OR: [
          { sourceType: "research", sourceId: id },
          ...(task.questionId
            ? [{ sourceType: "question" as const, sourceId: task.questionId }]
            : []),
        ],
      },
      data: { sourceStatus: "deleted" },
    });

    await prisma.researchTask.deleteMany({ where: { parentTaskId: id } });
    await prisma.researchTask.delete({ where: { id } });
    if (task.questionId) {
      await prisma.question.delete({ where: { id: task.questionId } }).catch(() => {});
    }

    return ok({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
