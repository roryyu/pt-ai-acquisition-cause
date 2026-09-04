import { Pool, type PoolClient } from "pg";
import { env } from "@/lib/env";

/**
 * PostgreSQL 连接器（design.md 5.1.1 BI Connector）
 *
 * 职责：
 * 1. 外部数据源连接测试（任意 PG 连接串）
 * 2. Schema 内省（库/表/列/行数）
 * 3. 数据预览（安全 LIMIT）
 * 4. 只读 SQL 执行（SELECT-only 校验 + 超时 + 行数上限）
 *
 * 安全约束（design.md 5.1.1）：
 * - 只读：拒绝一切非 SELECT/WITH 语句（DDL/DML 拦截）
 * - 查询超时：statement_timeout 硬限制
 * - 结果集上限：最多 maxRows 行
 * - 连接池隔离：每个目标库独立 Pool，空闲回收
 */

// ─── 连接池管理 ────────────────────────────────────────────────────────────────

interface PooledTarget {
  pool: Pool;
  lastUsed: number;
}

const globalForPg = globalThis as unknown as {
  __pgPools?: Map<string, PooledTarget>;
};
const pools = (globalForPg.__pgPools ??= new Map<string, PooledTarget>());
const POOL_IDLE_MS = 10 * 60 * 1000;

/** 定期回收空闲连接池（首个请求触发注册，进程内单次） */
let sweeperRegistered = false;
function registerSweeper() {
  if (sweeperRegistered || typeof setInterval === "undefined") return;
  sweeperRegistered = true;
  setInterval(() => {
    const now = Date.now();
    for (const [key, target] of pools) {
      if (now - target.lastUsed > POOL_IDLE_MS) {
        target.pool.end().catch(() => {});
        pools.delete(key);
      }
    }
  }, 5 * 60 * 1000).unref?.();
}

/** 归一化连接串：去掉 ?schema= 等 Prisma 专用参数 */
function normalizeUrl(url: string): string {
  return url.split("?")[0] ?? url;
}

/** 获取目标库连接池（复用） */
export function getPool(url: string): Pool {
  registerSweeper();
  const key = normalizeUrl(url);
  const existing = pools.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.pool;
  }
  const pool = new Pool({
    connectionString: key,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  pools.set(key, { pool, lastUsed: Date.now() });
  return pool;
}

/** 平台主库连接池（DATABASE_URL） */
export function platformPool(): Pool {
  return getPool(env.DATABASE_URL);
}

// ─── 连接测试 ─────────────────────────────────────────────────────────────────

export interface TestResult {
  ok: boolean;
  serverVersion?: string;
  latencyMs?: number;
  database?: string;
  schemas?: string[];
  error?: string;
}

/** 测试数据源连通性：返回服务器版本 + 可访问 schema */
export async function testConnection(url: string): Promise<TestResult> {
  const start = Date.now();
  let client: PoolClient | null = null;
  try {
    const pool = new Pool({
      connectionString: normalizeUrl(url),
      max: 1,
      connectionTimeoutMillis: 8_000,
      statement_timeout: 8_000,
    });
    client = await pool.connect();
    const version = await client.query<{ version: string }>("SELECT version()");
    const db = await client.query<{ current_database: string }>("SELECT current_database()");
    const schemas = await client.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog','information_schema')
       ORDER BY schema_name`,
    );
    await client.release();
    await pool.end();
    return {
      ok: true,
      serverVersion: version.rows[0]?.version?.split(" ").slice(0, 2).join(" "),
      database: db.rows[0]?.current_database,
      schemas: schemas.rows.map((r) => r.schema_name),
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    client?.release();
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - start,
    };
  }
}

// ─── Schema 内省 ──────────────────────────────────────────────────────────────

export interface TableMeta {
  schema: string;
  table: string;
  tableType: string;
  rowCount?: number;
  sizePretty?: string;
  columns: ColumnMeta[];
}

export interface ColumnMeta {
  name: string;
  dataType: string;
  nullable: boolean;
  default?: string | null;
  comment?: string | null;
}

/** 列出指定 schema（或全部业务 schema）的表与列结构 */
export async function introspectSchema(
  url: string,
  schemaFilter?: string,
): Promise<TableMeta[]> {
  const pool = getPool(url);
  const client = await pool.connect();
  try {
    const schemas = schemaFilter
      ? [schemaFilter]
      : ["data", "cause", "public"];
    const tables = await client.query<{
      table_schema: string;
      table_name: string;
      table_type: string;
      row_count: number | null;
      size_pretty: string | null;
    }>(
      `SELECT c.table_schema, c.table_name, c.table_type,
              COALESCE(s.n_live_tup, NULL) AS row_count,
              pg_size_pretty(pg_total_relation_size(quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))) AS size_pretty
       FROM information_schema.tables c
       LEFT JOIN pg_stat_user_tables s
         ON s.schemaname = c.table_schema AND s.relname = c.table_name
       WHERE c.table_schema = ANY($1::text[])
         AND c.table_name NOT LIKE 'pg_%'
         AND c.table_name NOT LIKE '_prisma_%'
       ORDER BY c.table_schema, c.table_name`,
      [schemas],
    );

    const allColumns = await client.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = ANY($1::text[])
       ORDER BY table_schema, table_name, ordinal_position`,
      [schemas],
    );

    const colMap = new Map<string, ColumnMeta[]>();
    for (const col of allColumns.rows) {
      const key = `${col.table_schema}.${col.table_name}`;
      const list = colMap.get(key) ?? [];
      list.push({
        name: col.column_name,
        dataType: col.data_type,
        nullable: col.is_nullable === "YES",
        default: col.column_default,
      });
      colMap.set(key, list);
    }

    return tables.rows.map((t) => ({
      schema: t.table_schema,
      table: t.table_name,
      tableType: t.table_type,
      rowCount: t.row_count ?? undefined,
      sizePretty: t.size_pretty ?? undefined,
      columns: colMap.get(`${t.table_schema}.${t.table_name}`) ?? [],
    }));
  } finally {
    client.release();
  }
}

// ─── 只读查询执行 ─────────────────────────────────────────────────────────────

/** 危险语句拦截：仅允许单条 SELECT / WITH 开头语句 */
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|call|do|merge)\b/i;

export function assertReadOnlySql(sql: string): { ok: boolean; reason?: string } {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed) return { ok: false, reason: "SQL 为空" };
  if (trimmed.includes(";")) return { ok: false, reason: "仅允许单条语句" };
  if (FORBIDDEN.test(trimmed)) return { ok: false, reason: "仅允许只读查询（SELECT/WITH）" };
  if (!/^(select|with)\b/i.test(trimmed)) return { ok: false, reason: "仅允许 SELECT 或 WITH 开头的查询" };
  return { ok: true };
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

/** 执行只读查询（默认上限 500 行 / 30s 超时） */
export async function executeReadOnlyQuery(
  url: string,
  sql: string,
  options?: { maxRows?: number; timeoutMs?: number; schema?: string },
): Promise<QueryResult> {
  const guard = assertReadOnlySql(sql);
  if (!guard.ok) {
    throw new Error(guard.reason ?? "SQL 校验失败");
  }
  const maxRows = Math.min(options?.maxRows ?? 500, 5000);
  const timeoutMs = Math.min(options?.timeoutMs ?? 30_000, 60_000);

  const pool = getPool(url);
  const client = await pool.connect();
  const start = Date.now();
  try {
    // 超时 + 行数硬限制 + 只读事务
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    if (options?.schema) {
      await client.query(`SET LOCAL search_path = ${JSON.stringify(options.schema)}, public`);
    }
    await client.query("BEGIN READ ONLY");
    const result = await client.query(`${sql}`, []);
    await client.query("COMMIT");

    const rows = result.rows as Record<string, unknown>[];
    const truncated = rows.length > maxRows;
    return {
      columns: result.fields?.map((f) => f.name) ?? Object.keys(rows[0] ?? {}),
      rows: rows.slice(0, maxRows),
      rowCount: rows.length,
      truncated,
      elapsedMs: Date.now() - start,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** 表数据预览（安全 LIMIT） */
export async function previewTable(
  url: string,
  schema: string,
  table: string,
  limit = 50,
): Promise<QueryResult> {
  // 表名/Schema 白名单校验，防注入
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error("非法的 schema 或表名");
  }
  const safeLimit = Math.min(Math.max(1, limit), 200);
  return executeReadOnlyQuery(
    url,
    `SELECT * FROM ${JSON.stringify(schema)}.${JSON.stringify(table)} LIMIT ${safeLimit}`,
    { maxRows: safeLimit },
  );
}
