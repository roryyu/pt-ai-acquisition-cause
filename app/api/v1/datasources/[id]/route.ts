import { ApiError, handleApiError, ok, requireActor } from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";
import { DEMO_PG_ID, WEB_SOURCE_ID } from "@/lib/server/connectors/datasources";

export const runtime = "nodejs";

/**
 * DELETE /api/v1/datasources/[id] — 删除自定义数据源（内置数据源不可删除）
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await requireActor(request);
    if (id === DEMO_PG_ID || id === WEB_SOURCE_ID) {
      throw new ApiError(403, "FORBIDDEN", "内置数据源不可删除");
    }
    const record = await prisma.dataSource.findUnique({ where: { id } });
    if (!record) {
      throw new ApiError(404, "DATA_SOURCE_NOT_FOUND", "数据源不存在");
    }
    await prisma.dataSource.delete({ where: { id } });
    return ok({ id, deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
