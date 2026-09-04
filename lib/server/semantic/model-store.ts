import { z } from "zod";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/server/api-runtime";
import { DEMO_PG_ID, WEB_SOURCE_ID } from "@/lib/server/connectors/datasources";
import {
  DEMO_SEMANTIC_MODELS,
  type DimensionField,
  type MetricField,
  type SemanticModelDef,
} from "./semantic-query";

/**
 * 语义模型存取层（design.md 6.4.2 SemanticModelV1）
 *
 * 统一数据集合：所有语义模型彼此平级、无优先，共同描述各数据源同步入库的表。
 * - 默认种子模型：DEMO_SEMANTIC_MODELS（代码常量，只读）——对应 data schema 中
 *   将由 BI 中间表等来源同步入库的表，与任何自定义模型平级，非“演示/优先”层
 * - 自定义模型：cause.semantic_models 表（可增删改，如 Adjust 查询入库表）
 *   fields JSON 结构：{ description, timeColumn, metrics, dimensions }
 *   dataSourceId 为空表示默认经营库（data_source_demo_pg）
 */

/** SQL 标识符白名单（schema/表/列/字段 id 最终会拼入 SQL，须提前校验） */
export const IDENT_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const ident = z.string().regex(IDENT_PATTERN, "仅允许字母/数字/下划线，且以字母或下划线开头");

/** 指标字段入参 */
export const MetricFieldInputSchema = z.object({
  id: ident.max(64),
  name: z.string().min(1).max(50),
  column: ident.max(64),
  agg: z.enum(["sum", "avg", "count", "max", "min", "none"]),
  unit: z.string().max(20).optional(),
  description: z.string().max(200).default(""),
  /** 上游 API 指标 slug（挂载到 API 数据源的模型用，API 源直查时算子自动映射用） */
  apiSlug: ident.max(64).optional(),
});

/** 维度字段入参 */
export const DimensionFieldInputSchema = z.object({
  id: ident.max(64),
  name: z.string().min(1).max(50),
  column: ident.max(64),
  values: z.array(z.string().min(1).max(50)).max(100).optional(),
  description: z.string().max(200).default(""),
  /** 上游 API 维度 slug（挂载到 API 数据源的模型用，API 源直查时算子自动映射用） */
  apiSlug: ident.max(64).optional(),
});

/** 新建语义模型入参 */
export const CreateSemanticModelSchema = z.object({
  name: z.string().min(1).max(100),
  /** 省略或传默认 demo 源 ID → 使用默认经营库（与其它源平级） */
  dataSourceId: z.string().min(1).optional(),
  /** schema.table 形式 */
  tableRef: z.string().regex(/^\w+\.\w+$/, "须为 schema.table 形式"),
  timeColumn: ident.max(64).optional(),
  description: z.string().max(500).default(""),
  metrics: z.array(MetricFieldInputSchema).min(1, "至少定义一个指标"),
  dimensions: z.array(DimensionFieldInputSchema).default([]),
});

/** 更新语义模型入参（全字段可选，metrics/dimensions 传入即整体替换） */
export const UpdateSemanticModelSchema = CreateSemanticModelSchema.partial();

export type CreateSemanticModelInput = z.infer<typeof CreateSemanticModelSchema>;
export type UpdateSemanticModelInput = z.infer<typeof UpdateSemanticModelSchema>;

/** fields JSON 的结构化视图 */
export interface SemanticFieldsPayload {
  metrics?: MetricField[];
  dimensions?: DimensionField[];
  timeColumn?: string;
  description?: string;
}

/** 默认种子模型 ID 判定（代码常量，只读，不可经 API 编辑/删除） */
export function isBuiltinModelId(id: string): boolean {
  return DEMO_SEMANTIC_MODELS.some((m) => m.id === id);
}

/** 校验指标/维度字段 id 不重复 */
export function assertFieldIdsUnique(metrics: MetricField[], dimensions: DimensionField[]): void {
  const seen = new Set<string>();
  for (const f of [...metrics, ...dimensions]) {
    if (seen.has(f.id)) {
      throw new Error(`字段 id 重复：${f.id}`);
    }
    seen.add(f.id);
  }
}

/** DB 记录 → SemanticModelDef */
export function recordToModelDef(m: {
  id: string;
  name: string;
  tableRef: string;
  fields: unknown;
  dataSourceId: string | null;
  dataSource: { name: string } | null;
}): SemanticModelDef {
  const fields = (m.fields ?? {}) as SemanticFieldsPayload;
  const tableParts = m.tableRef.split(".");
  return {
    id: m.id,
    name: m.name,
    schema: tableParts[0] ?? "data",
    table: tableParts[1] ?? m.tableRef,
    timeColumn: fields.timeColumn ?? "created_at",
    metrics: fields.metrics ?? [],
    dimensions: fields.dimensions ?? [],
    description: fields.description ?? `自定义模型${m.dataSource ? `（数据源：${m.dataSource.name}）` : ""}`,
    dataSourceId: m.dataSourceId ?? null,
  };
}

/** 全量语义模型 = 默认种子 + DB 自定义（彼此平级；供列表展示与 SQL 转译定位） */
export async function listAllSemanticModels(): Promise<SemanticModelDef[]> {
  const records = await prisma.semanticModel.findMany({
    orderBy: { createdAt: "desc" },
    include: { dataSource: { select: { name: true } } },
  });
  return [...DEMO_SEMANTIC_MODELS, ...records.map(recordToModelDef)];
}

/**
 * 数据源归一化：省略或内置 demo 源 → null（免 FK，运行时走 DATABASE_URL），
 * 其余须为已注册的 bi（PostgreSQL）数据源
 */
export async function normalizeModelDataSourceId(dataSourceId?: string): Promise<string | null> {
  if (!dataSourceId || dataSourceId === DEMO_PG_ID) return null;
  if (dataSourceId === WEB_SOURCE_ID) {
    throw new ApiError(400, "UNSUPPORTED", "语义模型仅支持 PostgreSQL（bi）数据源");
  }
  const source = await prisma.dataSource.findUnique({ where: { id: dataSourceId } });
  if (!source) {
    throw new ApiError(404, "DATA_SOURCE_NOT_FOUND", "数据源不存在");
  }
  if (source.type !== "bi") {
    throw new ApiError(400, "UNSUPPORTED", "语义模型仅支持 PostgreSQL（bi）数据源");
  }
  return source.id;
}
