import {
  handleApiError,
  ok,
  requireActor,
} from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";
import { refreshBinding } from "@/lib/server/insights/bindings";

/**
 * GET /api/v1/insights/bindings/[id] — 手动刷新单条绑定（重拉源数据）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;

    const binding = await refreshBinding(id);
    return ok(binding);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/v1/insights/bindings/[id] — 删除绑定（画布上形状可保留为静态内容）
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;

    await prisma.canvasBinding.delete({ where: { id } });
    return ok({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
