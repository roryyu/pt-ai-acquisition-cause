import { z } from "zod";
import {
  ApiError,
  handleApiError,
  ok,
  readJson,
  requireActor,
} from "@/lib/server/api-runtime";
import { prisma, Prisma } from "@/lib/db";

const UpdateInsightSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
  /** tldraw store snapshot（editor.store.getSnapshot() 产物） */
  snapshot: z.record(z.string(), z.unknown()).optional(),
});

/** snapshot 体积上限（约 5MB JSON，防止粘贴超大图片撑爆存储） */
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/**
 * GET /api/v1/insights/[id] — 文档详情（含实时绑定 / 定时任务 / 投递记录）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;

    const doc = await prisma.insightDoc.findUnique({
      where: { id },
      include: {
        bindings: { orderBy: { createdAt: "asc" } },
        schedules: { orderBy: { createdAt: "desc" } },
        deliveries: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });
    if (!doc) {
      throw new ApiError(404, "INSIGHT_NOT_FOUND", "洞察文档不存在");
    }

    return ok(doc);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PUT /api/v1/insights/[id] — 保存画布 snapshot / 更新标题状态
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;
    const input = UpdateInsightSchema.parse(await readJson<unknown>(request));

    // snapshot 体积校验（用户粘贴大图可能导致体积膨胀）
    if (input.snapshot !== undefined) {
      const size = Buffer.byteLength(JSON.stringify(input.snapshot), "utf-8");
      if (size > MAX_SNAPSHOT_BYTES) {
        throw new ApiError(413, "SNAPSHOT_TOO_LARGE", "画布内容超过 5MB 上限，请移除大尺寸图片");
      }
    }

    const doc = await prisma.insightDoc.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.snapshot !== undefined
          ? { snapshot: input.snapshot as Prisma.InputJsonValue }
          : {}),
      },
    });

    return ok(doc);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/v1/insights/[id] — 删除文档（级联删除绑定/定时任务/投递记录）
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;

    await prisma.insightDoc.delete({ where: { id } });
    return ok({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
