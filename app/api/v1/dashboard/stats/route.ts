import { handleApiError, ok, requireActor } from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";

/**
 * GET /api/v1/dashboard/stats — 工作台统计（提问 / 洞察画布 / 深度研究概览）
 */
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);

    const [recentQuestions, recentInsights, insightCount, questionCount, researchCount] =
      await Promise.all([
        prisma.question.findMany({
          where: { userId: actor.id },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, content: true, status: true, createdAt: true },
        }),
        prisma.insightDoc.findMany({
          where: { createdBy: actor.id },
          orderBy: { updatedAt: "desc" },
          take: 5,
          select: { id: true, title: true, kind: true, status: true, createdAt: true },
        }),
        prisma.insightDoc.count({ where: { createdBy: actor.id } }),
        prisma.question.count({ where: { userId: actor.id } }),
        prisma.researchTask.count({ where: { question: { userId: actor.id } } }),
      ]);

    return ok({
      stats: {
        totalQuestions: questionCount,
        totalInsights: insightCount,
        totalResearch: researchCount,
      },
      recentQuestions,
      recentInsights,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
