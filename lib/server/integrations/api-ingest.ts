/**
 * API 查询结果分解落库（统一取数分流层的落库延伸）
 *
 * 背景：cachedRestRequest 的查询缓存（cause.api_query_cache）仅存原始响应字符串，
 * 命中要求查询条件完全一致，API 数据无法被本地 SQL/算子复用。本模块在缓存未命中
 * （真实请求上游）时，把解析出的表格行分解为本地列结构，幂等 upsert 至语义模型
 * 对应的物理表（data schema），使 API 数据沉淀为本地可查的明细：
 * - 与 adjust-sync 定时同步的表结构/粒度完全兼容（同主键，按主键互相幂等覆盖）
 * - 落库后数据字典「本地数据范围」（runtimeTablesHint 实时查表）自动扩展
 *
 * 落库条件（由调用方 fetchApiReportRows 判定，全部满足才落）：
 * - 缓存未命中（miss）且 2xx、未截断、行数 > 0
 * - 请求维度 slug 覆盖模型全部维度（行粒度与表主键一致）；部分聚合结果不落
 *
 * 安全性：标识符一律经 IDENT_PATTERN 校验并双引号包裹，值全部参数化；
 * 内部异常仅 console.warn，绝不抛出——落库是延伸能力，不得影响取数主流程。
 */
import { prisma } from "@/lib/db";
import { IDENT_PATTERN } from "@/lib/server/semantic/model-store";
import type { SemanticModelDef } from "@/lib/server/semantic/semantic-query";

/** 批量 upsert 每批行数（与 adjust-sync 保持一致） */
const BATCH = 400;

/** 单次落库行数上限：超过视为异常大响应（保护 DB 与内存），拒绝落库仅告警 */
export const MAX_INGEST_ROWS = 50_000;

/** SQL 标识符引用（先校验再双引号包裹，杜绝注入） */
function q(ident: string): string {
  if (!IDENT_PATTERN.test(ident)) throw new Error(`非法标识符: ${ident}`);
  return `"${ident}"`;
}

/** CSV/JSON 值安全转数值（指标列落库用） */
function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 模型全部维度的上游 slug（含时间维度；apiSlug 缺省视为与本地列同名） */
export function modelDimensionSlugs(model: SemanticModelDef): string[] {
  return model.dimensions.map((d) => d.apiSlug ?? d.column);
}

/**
 * 判定响应行是否可落库：请求维度 slug 覆盖模型全部维度（行粒度与表主键一致）。
 * 部分聚合结果（如单维度分组）粒度不足，落库会污染明细表，一律拒绝。
 */
export function shouldPersist(model: SemanticModelDef, requestDimSlugs: string[]): boolean {
  if (model.dimensions.length === 0) return false;
  const provided = new Set(requestDimSlugs);
  return modelDimensionSlugs(model).every((slug) => provided.has(slug));
}

/** slug → 本地列名映射后的表结构视图 */
export interface MappedApiTable {
  /** 全维度列（含时间列），顺序 = model.dimensions 顺序，即主键顺序 */
  dimColumns: string[];
  /** 模型全部可聚合指标列（建表 DDL 用，保证表结构完整不随本次请求指标而变） */
  allMetricColumns: string[];
  /** 本次响应实际返回的指标列（upsert 只更新这些列，避免未请求的指标被覆盖为 0；
   * agg=none 的派生比率类不落库，API 报表亦不返回） */
  metricColumns: string[];
  /** 键为本地列名的行（主键值缺失的行已剔除） */
  rows: Record<string, unknown>[];
}

/**
 * 上游 slug → 本地列名反查（语义模型 dimensions/metrics 的 apiSlug 映射，
 * 如 day→stat_date、register_events→register_cnt）；无法映射的列与主键值缺失的行丢弃。
 */
export function mapRowsToLocalColumns(
  model: SemanticModelDef,
  rows: Record<string, unknown>[],
): MappedApiTable {
  const dimColumns = model.dimensions.map((d) => d.column);
  const aggregatable = model.metrics.filter((m) => m.agg !== "none");
  const allMetricColumns = aggregatable.map((m) => m.column);
  // 响应中实际出现的 slug 集合：仅这些指标列参与 upsert（部分指标请求不污染其他列）
  const presentSlugs = new Set<string>();
  for (const row of rows) {
    for (const slug of Object.keys(row)) presentSlugs.add(slug);
  }
  const metricColumns = aggregatable
    .filter((m) => presentSlugs.has(m.apiSlug ?? m.column))
    .map((m) => m.column);
  // slug → column：维度优先，指标 slug 与维度同名时以维度为准（正常建模不会同名）
  const colBySlug = new Map<string, string>();
  for (const d of model.dimensions) colBySlug.set(d.apiSlug ?? d.column, d.column);
  for (const m of model.metrics) {
    if (m.agg === "none") continue;
    const slug = m.apiSlug ?? m.column;
    if (!colBySlug.has(slug)) colBySlug.set(slug, m.column);
  }
  const mapped: Record<string, unknown>[] = [];
  for (const row of rows) {
    const out: Record<string, unknown> = {};
    for (const [slug, value] of Object.entries(row)) {
      const column = colBySlug.get(slug);
      if (column) out[column] = value;
    }
    // 主键值缺失的行无法 upsert（会互相覆盖），剔除
    if (dimColumns.every((c) => out[c] !== undefined && out[c] !== null && String(out[c]) !== "")) {
      mapped.push(out);
    }
  }
  return { dimColumns, allMetricColumns, metricColumns, rows: mapped };
}

/** 幂等建表：表已存在（如定时同步链路已创建）时 CREATE TABLE IF NOT EXISTS 自动跳过；
 * 指标列按模型全量创建，不随本次响应实际返回的指标而缺列 */
async function ensureDataTable(model: SemanticModelDef, table: MappedApiTable): Promise<void> {
  const columnDefs = table.dimColumns.map(
    (c) => `${q(c)} ${c === model.timeColumn ? "DATE" : "TEXT"} NOT NULL`,
  );
  for (const c of table.allMetricColumns) columnDefs.push(`${q(c)} NUMERIC(18,4) NOT NULL DEFAULT 0`);
  columnDefs.push(`"synced_at" TIMESTAMPTZ NOT NULL DEFAULT now()`);
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS ${q(model.schema)}.${q(model.table)} (\n  ${columnDefs.join(",\n  ")},\n  PRIMARY KEY (${table.dimColumns.map(q).join(", ")})\n)`,
  );
}

/**
 * 将 API 响应行分解落库（主入口）：映射本地列名 → 幂等建表 → 批量
 * INSERT ... ON CONFLICT (全维度) DO UPDATE。返回实际 upsert 行数；
 * 任何失败仅告警并返回 0，不抛出。
 */
export async function persistApiRowsToDataTable(
  model: SemanticModelDef,
  rows: Record<string, unknown>[],
): Promise<number> {
  try {
    if (rows.length > MAX_INGEST_ROWS) {
      console.warn(`[api-ingest] 响应 ${rows.length} 行超过单次落库上限 ${MAX_INGEST_ROWS}，跳过落库`);
      return 0;
    }
    const table = mapRowsToLocalColumns(model, rows);
    if (table.rows.length === 0 || table.metricColumns.length === 0) return 0;
    await ensureDataTable(model, table);
    const columns = [...table.dimColumns, ...table.metricColumns];
    const conflictTarget = table.dimColumns.map(q).join(", ");
    const updates = [
      ...table.metricColumns.map((c) => `${q(c)} = EXCLUDED.${q(c)}`),
      `"synced_at" = now()`,
    ].join(", ");
    let persisted = 0;
    for (let i = 0; i < table.rows.length; i += BATCH) {
      const chunk = table.rows.slice(i, i + BATCH);
      const values: unknown[] = [];
      const placeholders = chunk
        .map((_, ri) => `(${Array.from({ length: columns.length }, (_, ci) => `$${ri * columns.length + ci + 1}`).join(",")}, now())`)
        .join(",");
      for (const r of chunk) {
        for (const c of table.dimColumns) values.push(r[c]);
        for (const c of table.metricColumns) values.push(toNum(r[c]));
      }
      persisted += await prisma.$executeRawUnsafe(
        `INSERT INTO ${q(model.schema)}.${q(model.table)} (${columns.map(q).join(", ")}, "synced_at")
         VALUES ${placeholders}
         ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updates}`,
        ...values,
      );
    }
    return persisted;
  } catch (error) {
    console.warn(
      `[api-ingest] 分解落库 ${model.schema}.${model.table} 失败（不影响本次取数）:`,
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
}
