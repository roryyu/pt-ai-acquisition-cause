import { z } from "zod";
import {
  ApiError,
  handleApiError,
  ok,
  readJson,
  requireActor,
} from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";
import { createBinding, refreshBinding } from "@/lib/server/insights/bindings";

const CreateBindingSchema = z.object({
  /** 画布上形状 id（createShapeId 产物） */
  shapeId: z.string().min(1),
  sourceType: z.enum(["question", "research", "metric"]),
  sourceId: z.string().optional(),
});

/**
 * POST /api/v1/insights/[id]/bindings — 新增实时绑定（立即拉取一次源数据）
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;
    const input = CreateBindingSchema.parse(await readJson<unknown>(request));

    const doc = await prisma.insightDoc.findUnique({ where: { id } });
    if (!doc) throw new ApiError(404, "INSIGHT_NOT_FOUND", "洞察文档不存在");

    const binding = await createBinding({
      docId: id,
      shapeId: input.shapeId,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
    });

    return ok(binding, 201);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * GET /api/v1/insights/[id]/bindings — 绑定列表
 * ?refresh=1 时对仍在运行中的源重拉一次（画布轮询使用，保证"实时"）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";

    let bindings = await prisma.canvasBinding.findMany({
      where: { docId: id },
      orderBy: { createdAt: "asc" },
    });

    if (refresh) {
      // 仅刷新运行中的源；completed/failed 已定型，deleted 源已不存在
      const running = bindings.filter(
        (b) =>
          b.sourceStatus !== "completed" &&
          b.sourceStatus !== "failed" &&
          b.sourceStatus !== "deleted",
      );
      const refreshed = await Promise.all(
        running.map((b) => refreshBinding(b.id).catch(() => b)),
      );
      const byId = new Map(refreshed.map((b) => [b.id, b]));
      bindings = bindings.map((b) => byId.get(b.id) ?? b);
    }

    return ok({ bindings });
  } catch (error) {
    return handleApiError(error);
  }
}
