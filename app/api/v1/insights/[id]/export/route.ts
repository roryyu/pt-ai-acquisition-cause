import { z } from "zod";
import {
  ApiError,
  handleApiError,
  ok,
  readJson,
  requireActor,
} from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";
import { deliver, saveExportPng } from "@/lib/server/delivery";

const ExportSchema = z.object({
  /** PNG 图片（data:image/png;base64,... 或纯 base64） */
  pngBase64: z.string().min(100),
});

/**
 * POST /api/v1/insights/[id]/export — 存档画布导出 PNG
 * 客户端 editor 导出 PNG 后调用，落盘 public/exports 并记 image 投递流水
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;
    const input = ExportSchema.parse(await readJson<unknown>(request));

    const doc = await prisma.insightDoc.findUnique({ where: { id } });
    if (!doc) throw new ApiError(404, "INSIGHT_NOT_FOUND", "洞察文档不存在");

    const imagePath = await saveExportPng(id, input.pngBase64);
    if (!imagePath) {
      throw new ApiError(413, "EXPORT_TOO_LARGE", "导出图片为空或超过 5MB 上限");
    }

    const record = await deliver("image", {
      docId: id,
      title: doc.title,
      recipients: [],
      imagePath,
    });

    return ok({ imagePath, deliveryId: record.id, status: record.status }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
