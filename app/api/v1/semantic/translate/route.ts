import { handleApiError, ok, readJson, requireActor } from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { SemanticQueryV1Schema, translateToSql } from "@/lib/server/semantic/semantic-query";
import { listAllSemanticModels } from "@/lib/server/semantic/model-store";
import { executeReadOnlyQuery } from "@/lib/server/connectors/postgres";
import { resolveDataSource } from "@/lib/server/connectors/datasources";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/v1/semantic/translate — 语义查询试运行（design.md 4.1.3）
 * SemanticQueryV1 → SQL 转译（内置 + 自定义全量模型）→ 只读执行，返回 SQL + 结果集
 */
export async function POST(request: Request) {
  try {
    await requireActor(request);
    const input = SemanticQueryV1Schema.parse(await readJson<unknown>(request));

    const models = await listAllSemanticModels();
    const translated = translateToSql(input, models);

    // 执行目标：自定义模型按其数据源连接串执行，内置/演示库走 DATABASE_URL
    const customUrl = await resolveModelUrl(translated.model.id);

    const result = await executeReadOnlyQuery(customUrl ?? env.DATABASE_URL, translated.sql, {
      maxRows: 200,
      schema: translated.model.schema,
    });

    return ok({
      sql: translated.sql,
      model: { id: translated.model.id, name: translated.model.name },
      notes: translated.notes,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      elapsedMs: result.elapsedMs,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 自定义模型 → 其数据源连接串（内置 demo 模型返回 null） */
async function resolveModelUrl(modelId: string): Promise<string | null> {
  const record = await prisma.semanticModel.findUnique({ where: { id: modelId } });
  if (!record?.dataSourceId) return null;
  const source = await resolveDataSource(record.dataSourceId);
  return source?.url ?? null;
}
