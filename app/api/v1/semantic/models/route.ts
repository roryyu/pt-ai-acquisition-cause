import { ApiError, handleApiError, ok, readJson, requireActor } from "@/lib/server/api-runtime";
import { prisma, Prisma } from "@/lib/db";
import { newId } from "@/lib/server/ids";
import { DEMO_SEMANTIC_MODELS } from "@/lib/server/semantic/semantic-query";
import {
  CreateSemanticModelSchema,
  assertFieldIdsUnique,
  normalizeModelDataSourceId,
  recordToModelDef,
} from "@/lib/server/semantic/model-store";
import { DEMO_PG_ID } from "@/lib/server/connectors/datasources";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/v1/semantic/models — 语义模型列表（内置 demo 模型 + 自定义模型）
 * 返回模型/维度/指标定义，供语义层管理 UI 渲染
 */
export async function GET(request: Request) {
  try {
    await requireActor(request);

    const records = await prisma.semanticModel.findMany({
      orderBy: { createdAt: "desc" },
      include: { dataSource: { select: { name: true } } },
    });

    const builtin = DEMO_SEMANTIC_MODELS.map((m) => ({
      ...m,
      builtin: true,
      dataSourceId: DEMO_PG_ID,
      dataSourceName: "演示经营库（PostgreSQL）",
      updatedAt: null as string | null,
    }));
    const custom = records.map((r) => ({
      ...recordToModelDef(r),
      builtin: false,
      dataSourceId: r.dataSourceId ?? DEMO_PG_ID,
      dataSourceName: r.dataSource?.name ?? "演示经营库（PostgreSQL）",
      updatedAt: r.updatedAt.toISOString(),
    }));

    return ok({
      models: [...builtin, ...custom].map((m) => ({
        id: m.id,
        name: m.name,
        schema: m.schema,
        table: m.table,
        timeColumn: m.timeColumn,
        description: m.description,
        metricCount: m.metrics.length,
        dimensionCount: m.dimensions.length,
        metrics: m.metrics,
        dimensions: m.dimensions,
        builtin: m.builtin,
        dataSourceId: m.dataSourceId,
        dataSourceName: m.dataSourceName,
        updatedAt: m.updatedAt,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST /api/v1/semantic/models — 新建自定义语义模型
 * dataSourceId 省略或为内置 demo 源时挂载内置演示经营库，否则须为已注册的 bi 数据源
 */
export async function POST(request: Request) {
  try {
    await requireActor(request);
    const input = CreateSemanticModelSchema.parse(await readJson<unknown>(request));
    assertFieldIdsUnique(input.metrics, input.dimensions);

    // 数据源归一化：内置 demo 源 → null（免 FK），其余须为已注册 bi 源
    const dataSourceId = await normalizeModelDataSourceId(input.dataSourceId);

    const id = newId("semantic_model");
    const record = await prisma.semanticModel.create({
      data: {
        id,
        name: input.name,
        dataSourceId,
        tableRef: input.tableRef,
        fields: {
          description: input.description,
          timeColumn: input.timeColumn,
          metrics: input.metrics,
          dimensions: input.dimensions,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return ok(
      { ...recordToModelDef({ ...record, dataSource: null }), builtin: false },
      201,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("字段 id 重复")) {
      return handleApiError(new ApiError(400, "INVALID_REQUEST", error.message));
    }
    return handleApiError(error);
  }
}
