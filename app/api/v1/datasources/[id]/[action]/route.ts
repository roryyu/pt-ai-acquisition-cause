import { z } from "zod";
import { ApiError, handleApiError, ok, readJson, requireActor } from "@/lib/server/api-runtime";
import { resolveDataSource, type ResolvedDataSource } from "@/lib/server/connectors/datasources";
import { webSearch } from "@/lib/server/connectors/web";
import {
  testConnection,
  introspectSchema,
  executeReadOnlyQuery,
  previewTable,
} from "@/lib/server/connectors/postgres";
import {
  testApiSource,
  executeRestRequest,
  executeGraphQLQuery,
  introspectGraphQLSchema,
} from "@/lib/server/connectors/api";
import { listMcpTools, callMcpTool, runMcpReactAgent } from "@/lib/server/connectors/mcp";

export const runtime = "nodejs";
export const maxDuration = 120;

/** SQL 查询请求 */
const QueryRequestSchema = z.object({
  sql: z.string().min(1, "SQL 不能为空").max(8000),
  schema: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "schema 名非法").default("data"),
  maxRows: z.number().int().min(1).max(300).default(100),
});

/** REST 请求调试 */
const RestRequestSchema = z.object({
  method: z.enum(["GET", "POST"]).default("GET"),
  path: z.string().max(2000).optional(),
  params: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});

/** GraphQL 查询调试 */
const GraphQLRequestSchema = z.object({
  query: z.string().min(1, "query 不能为空").max(20_000),
  variables: z.record(z.string(), z.unknown()).optional(),
});

/** MCP 单工具调用 */
const McpInvokeSchema = z.object({
  tool: z.string().min(1, "tool 不能为空").max(200),
  args: z.record(z.string(), z.unknown()).default({}),
});

/** MCP ReAct Agent 任务 */
const McpAgentSchema = z.object({
  task: z.string().min(2, "task 不能为空").max(4000),
});

function requireApiConfig(source: ResolvedDataSource) {
  if (source.type !== "api" || !source.apiConfig?.endpoint) {
    throw new ApiError(400, "UNSUPPORTED", "该操作仅支持已配置 endpoint 的 api 数据源");
  }
  return source.apiConfig;
}

function requireMcpConfig(source: ResolvedDataSource) {
  if (source.type !== "mcp" || !source.mcpConfig?.proxyUrl) {
    throw new ApiError(400, "UNSUPPORTED", "该操作仅支持已配置 proxyUrl 的 mcp 数据源");
  }
  return source.mcpConfig;
}

function requirePgUrl(source: ResolvedDataSource): string {
  if (!source.url) {
    throw new ApiError(400, "MISCONFIGURED", "数据源未配置连接串");
  }
  return source.url;
}

/** 连接器抛出的普通 Error → 结构化 400（只读拦截、上游异常等，避免落入 500 分支） */
async function runConnector<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      400,
      "CONNECTOR_ERROR",
      error instanceof Error ? error.message : "连接器执行失败",
    );
  }
}

/**
 * 数据源操作统一入口：
 * - POST /api/v1/datasources/[id]/test     连接测试（bi / web / api / mcp）
 * - POST /api/v1/datasources/[id]/query    只读 SQL 查询（bi，SELECT-only）
 * - POST /api/v1/datasources/[id]/request  REST 请求调试（api·rest）
 * - POST /api/v1/datasources/[id]/graphql  GraphQL 查询调试（api·graphql，只读）
 * - POST /api/v1/datasources/[id]/invoke   MCP 单工具调用（mcp）
 * - POST /api/v1/datasources/[id]/agent    MCP ReAct Agent 执行（mcp）
 * - GET  /api/v1/datasources/[id]/schema   Schema 内省（bi 表结构 / api·graphql 内省）
 * - GET  /api/v1/datasources/[id]/preview  表数据预览（bi）
 * - GET  /api/v1/datasources/[id]/tools    MCP 工具列表（mcp）
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await params;
  try {
    await requireActor(request);
    const source = await resolveDataSource(id);
    if (!source) {
      throw new ApiError(404, "DATA_SOURCE_NOT_FOUND", "数据源不存在");
    }

    if (action === "test") {
      // web 源：探测搜索可用性
      if (source.type === "web") {
        const results = await webSearch("数据连通性测试", 1);
        return ok({ ok: results.length > 0, kind: "web", sampleCount: results.length });
      }
      // api 源：REST/GraphQL 连通探测
      if (source.type === "api") {
        return ok(await testApiSource(requireApiConfig(source)));
      }
      // mcp 源：连接代理并统计工具数
      if (source.type === "mcp") {
        const config = requireMcpConfig(source);
        try {
          const tools = await listMcpTools(config);
          return ok({ ok: true, kind: "mcp", toolCount: tools.length });
        } catch (error) {
          return ok({ ok: false, kind: "mcp", error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (!source.url) {
        return ok({ ok: false, kind: "postgres", error: "数据源未配置连接串" });
      }
      const result = await testConnection(source.url);
      return ok(result);
    }

    if (action === "query") {
      if (source.type !== "bi") {
        throw new ApiError(400, "UNSUPPORTED", `${source.type} 数据源不支持 SQL 查询`);
      }
      const input = QueryRequestSchema.parse(await readJson<unknown>(request));
      const result = await executeReadOnlyQuery(requirePgUrl(source), input.sql, {
        maxRows: input.maxRows,
        schema: input.schema,
      });
      return ok(result);
    }

    if (action === "request") {
      const config = requireApiConfig(source);
      if (config.protocol !== "rest") {
        throw new ApiError(400, "UNSUPPORTED", "GraphQL 数据源请使用 graphql 操作");
      }
      const input = RestRequestSchema.parse(await readJson<unknown>(request));
      return ok(await runConnector(() => executeRestRequest(config, input)));
    }

    if (action === "graphql") {
      const config = requireApiConfig(source);
      if (config.protocol !== "graphql") {
        throw new ApiError(400, "UNSUPPORTED", "REST 数据源请使用 request 操作");
      }
      const input = GraphQLRequestSchema.parse(await readJson<unknown>(request));
      return ok(await runConnector(() => executeGraphQLQuery(config, input)));
    }

    if (action === "invoke") {
      const config = requireMcpConfig(source);
      const input = McpInvokeSchema.parse(await readJson<unknown>(request));
      return ok(await runConnector(() => callMcpTool(config, input.tool, input.args)));
    }

    if (action === "agent") {
      const config = requireMcpConfig(source);
      const input = McpAgentSchema.parse(await readJson<unknown>(request));
      return ok(await runConnector(() => runMcpReactAgent(config, input.task)));
    }

    throw new ApiError(404, "ACTION_NOT_FOUND", `未知操作：${action}`);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await params;
  try {
    await requireActor(request);
    const source = await resolveDataSource(id);
    if (!source) {
      throw new ApiError(404, "DATA_SOURCE_NOT_FOUND", "数据源不存在");
    }

    const url = new URL(request.url);

    if (action === "schema") {
      // api·graphql 源：Schema 内省（Query 根字段）
      if (source.type === "api") {
        const config = requireApiConfig(source);
        if (config.protocol !== "graphql") {
          throw new ApiError(400, "UNSUPPORTED", "REST 数据源无 Schema 内省能力");
        }
        return ok({ fields: await runConnector(() => introspectGraphQLSchema(config)) });
      }
      if (source.type !== "bi") {
        throw new ApiError(400, "UNSUPPORTED", `${source.type} 数据源无 Schema 概念`);
      }
      const schemaFilter = url.searchParams.get("schema") ?? undefined;
      const tables = await introspectSchema(requirePgUrl(source), schemaFilter);
      return ok({ tables });
    }

    if (action === "tools") {
      const config = requireMcpConfig(source);
      return ok({ tools: await runConnector(() => listMcpTools(config)) });
    }

    if (action === "preview") {
      if (source.type !== "bi") {
        throw new ApiError(400, "UNSUPPORTED", `${source.type} 数据源不支持表预览`);
      }
      const schema = url.searchParams.get("schema") ?? "data";
      const table = url.searchParams.get("table") ?? "";
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
        throw new ApiError(400, "INVALID_REQUEST", "表名非法");
      }
      const result = await previewTable(requirePgUrl(source), schema, table, limit);
      return ok(result);
    }

    throw new ApiError(404, "ACTION_NOT_FOUND", `未知操作：${action}`);
  } catch (error) {
    return handleApiError(error);
  }
}
