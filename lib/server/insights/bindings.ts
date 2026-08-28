/**
 * 画布实时绑定服务：创建 / 刷新绑定
 * 创建时立即从数据源拉取一次 payload；刷新时重拉并回填（源未完成的持续轮询场景）
 */
import { prisma, Prisma } from "@/lib/db";
import { newId } from "@/lib/server/ids";
import { ApiError } from "@/lib/server/api-runtime";
import { extractFromQuestion, extractFromResearch } from "./extract";

/** 从数据源解析最新 payload 与状态 */
async function resolveSource(
  sourceType: "question" | "research" | "metric",
  sourceId: string | null,
): Promise<{ payload: object; sourceStatus: string }> {
  if (sourceType === "question") {
    if (!sourceId) throw new ApiError(400, "INVALID_REQUEST", "问答绑定需提供 sourceId");
    const question = await prisma.question.findUnique({ where: { id: sourceId } });
    if (!question) throw new ApiError(404, "SOURCE_NOT_FOUND", "问答不存在");
    const { payload, sourceStatus } = extractFromQuestion(question);
    return { payload, sourceStatus };
  }

  if (sourceType === "research") {
    if (!sourceId) throw new ApiError(400, "INVALID_REQUEST", "研究绑定需提供 sourceId");
    const task = await prisma.researchTask.findUnique({
      where: { id: sourceId },
      include: { question: true },
    });
    if (!task) throw new ApiError(404, "SOURCE_NOT_FOUND", "研究任务不存在");
    const { payload, sourceStatus } = extractFromResearch(task, task.question);
    return { payload, sourceStatus };
  }

  // metric 来源预留：本期返回空负载
  return { payload: { kind: "text", title: "指标绑定（预留）" }, sourceStatus: "unknown" };
}

/** 创建绑定并立即拉取一次源数据 */
export async function createBinding(params: {
  docId: string;
  shapeId: string;
  sourceType: "question" | "research" | "metric";
  sourceId: string | null;
}) {
  const { payload, sourceStatus } = await resolveSource(params.sourceType, params.sourceId);

  return prisma.canvasBinding.create({
    data: {
      id: newId("binding"),
      docId: params.docId,
      shapeId: params.shapeId,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      payload: payload as Prisma.InputJsonValue,
      sourceStatus,
    },
  });
}

/** 刷新单条绑定：重拉源数据并回填（画布轮询调用） */
export async function refreshBinding(bindingId: string) {
  const binding = await prisma.canvasBinding.findUnique({ where: { id: bindingId } });
  if (!binding) throw new ApiError(404, "BINDING_NOT_FOUND", "绑定不存在");

  const { payload, sourceStatus } = await resolveSource(
    binding.sourceType as "question" | "research" | "metric",
    binding.sourceId,
  );

  return prisma.canvasBinding.update({
    where: { id: bindingId },
    data: { payload: payload as Prisma.InputJsonValue, sourceStatus },
  });
}
