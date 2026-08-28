import { handleApiError, ok, requireActor } from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";

/**
 * GET /api/v1/ask/[id] — 获取问答详情（含研究任务与会话线程）
 *
 * thread：沿 parentQuestionId 回溯的祖先问答链（不含自身，时间从早到晚），
 * 供前端以会话线程方式渲染多轮追问上下文（仅携带轻量字段，不含图表/表格）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;

    const question = await prisma.question.findUnique({
      where: { id },
      include: { researchTasks: { orderBy: { createdAt: "asc" } } },
    });

    if (!question) {
      return handleApiError({ status: 404, code: "QUESTION_NOT_FOUND", message_: "问答不存在" });
    }

    return ok({ ...question, thread: await buildThread(question.context) });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 沿父问答链回溯祖先轮次（最多 8 轮，防环；返回时间从早到晚） */
async function buildThread(context: unknown): Promise<
  Array<{ id: string; content: string; route: string | null; answerContent: string; createdAt: Date }>
> {
  const ctx = (context ?? {}) as { parentQuestionId?: string };
  const ancestors: Array<{ id: string; content: string; route: string | null; answerContent: string; createdAt: Date }> = [];
  let cursorId = ctx.parentQuestionId ?? null;
  const seen = new Set<string>();
  while (cursorId && ancestors.length < 8 && !seen.has(cursorId)) {
    seen.add(cursorId);
    const cursor = await prisma.question.findUnique({ where: { id: cursorId } });
    if (!cursor) break;
    const answer = (cursor.answer ?? {}) as { content?: string; route?: string };
    ancestors.unshift({
      id: cursor.id,
      content: cursor.content,
      route: answer.route ?? null,
      answerContent: answer.content ?? "",
      createdAt: cursor.createdAt,
    });
    const cursorCtx = (cursor.context ?? {}) as { parentQuestionId?: string };
    cursorId = cursorCtx.parentQuestionId ?? null;
  }
  return ancestors;
}

/**
 * DELETE /api/v1/ask/[id] — 删除问答
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;

    // 画布绑定收敛：指向该问答的实时绑定标记为源已删除
    // （卡片保留最后一次内容，不再显示"实时"也不再参与刷新）
    await prisma.canvasBinding.updateMany({
      where: { sourceType: "question", sourceId: id },
      data: { sourceStatus: "deleted" },
    });

    await prisma.researchTask.deleteMany({ where: { questionId: id } });
    await prisma.question.delete({ where: { id } });

    return ok({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
