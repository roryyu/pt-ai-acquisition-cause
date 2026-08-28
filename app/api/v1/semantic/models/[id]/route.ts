import { ApiError, handleApiError, ok, readJson, requireActor } from "@/lib/server/api-runtime";
import { prisma, Prisma } from "@/lib/db";
import { DEMO_SEMANTIC_MODELS } from "@/lib/server/semantic/semantic-query";
import {
  UpdateSemanticModelSchema,
  assertFieldIdsUnique,
  isBuiltinModelId,
  normalizeModelDataSourceId,
  recordToModelDef,
  type SemanticFieldsPayload,
} from "@/lib/server/semantic/model-store";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/v1/semantic/models/[id] — 获取单个语义模型（内置模型可直接查看）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;

    const builtin = DEMO_SEMANTIC_MODELS.find((m) => m.id === id);
    if (builtin) {
      return ok({ ...builtin, builtin: true });
    }

    const record = await prisma.semanticModel.findUnique({
      where: { id },
      include: { dataSource: { select: { name: true } } },
    });
    if (!record) {
      throw new ApiError(404, "SEMANTIC_MODEL_NOT_FOUND", "语义模型不存在");
    }
    return ok({ ...recordToModelDef(record), builtin: false });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PUT /api/v1/semantic/models/[id] — 更新自定义语义模型
 * 内置模型只读；metrics/dimensions 传入即整体替换，未传字段保持原值
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;

    if (isBuiltinModelId(id)) {
      throw new ApiError(403, "FORBIDDEN", "内置语义模型为只读，请复制为自定义模型后修改");
    }
    const input = UpdateSemanticModelSchema.parse(await readJson<unknown>(request));

    const record = await prisma.semanticModel.findUnique({ where: { id } });
    if (!record) {
      throw new ApiError(404, "SEMANTIC_MODEL_NOT_FOUND", "语义模型不存在");
    }

    // 合并 fields：传入的指标/维度/时间列/描述整体替换，未传保持原值
    const fields = (record.fields ?? {}) as SemanticFieldsPayload;
    const metrics = input.metrics ?? fields.metrics ?? [];
    const dimensions = input.dimensions ?? fields.dimensions ?? [];
    assertFieldIdsUnique(metrics, dimensions);
    if (metrics.length === 0) {
      throw new ApiError(400, "INVALID_REQUEST", "至少定义一个指标");
    }

    const dataSourceId =
      input.dataSourceId !== undefined
        ? await normalizeModelDataSourceId(input.dataSourceId)
        : record.dataSourceId;

    const updated = await prisma.semanticModel.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.tableRef !== undefined ? { tableRef: input.tableRef } : {}),
        dataSourceId,
        fields: {
          description: input.description ?? fields.description ?? "",
          timeColumn: input.timeColumn ?? fields.timeColumn,
          metrics,
          dimensions,
        } satisfies SemanticFieldsPayload as unknown as Prisma.InputJsonValue,
      },
    });

    return ok({ ...recordToModelDef({ ...updated, dataSource: null }), builtin: false });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("字段 id 重复")) {
      return handleApiError(new ApiError(400, "INVALID_REQUEST", error.message));
    }
    return handleApiError(error);
  }
}

/**
 * DELETE /api/v1/semantic/models/[id] — 删除自定义语义模型（内置模型不可删除）
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireActor(request);
    const { id } = await params;

    if (isBuiltinModelId(id)) {
      throw new ApiError(403, "FORBIDDEN", "内置语义模型不可删除");
    }
    const result = await prisma.semanticModel.deleteMany({ where: { id } });
    if (result.count === 0) {
      throw new ApiError(404, "SEMANTIC_MODEL_NOT_FOUND", "语义模型不存在");
    }
    return ok({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
