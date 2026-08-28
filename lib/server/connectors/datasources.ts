import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import type { ApiSourceConfig } from "./api";
import type { McpSourceConfig } from "./mcp";

/**
 * 数据源注册与解析（design.md 5.1 数据接入层）
 *
 * 内置数据源（平台随环境自动可用）：
 * - demo_pg：演示 PostgreSQL 库（env.DATABASE_URL，含 demo/cause/public schema）
 * - web：互联网检索源（Bing/DuckDuckGo，无需连接串）
 *
 * 自定义数据源（存于 data_sources 表）：
 * - bi：PostgreSQL 连接串
 * - api：外部开放平台 API（REST / GraphQL）
 * - mcp：内部 MCP 代理（streamable HTTP）
 */

/** 自定义数据源 config 联合类型 */
export type DataSourceConfig =
  | { connectionUrl?: string }
  | ApiSourceConfig
  | McpSourceConfig;

export interface ResolvedDataSource {
  id: string;
  name: string;
  type: "bi" | "api" | "mcp" | "web" | "browser";
  /** postgresql 连接串（bi 类型） */
  url?: string;
  /** api 类型配置 */
  apiConfig?: ApiSourceConfig;
  /** mcp 类型配置 */
  mcpConfig?: McpSourceConfig;
  builtin: boolean;
  createdAt?: string;
}

/** 解析 data_sources.config → 类型化字段 + 状态 */
function parseCustomConfig(
  type: ResolvedDataSource["type"],
  config: Record<string, unknown>,
): Pick<ResolvedDataSource, "url" | "apiConfig" | "mcpConfig"> & { status: string } {
  if (type === "api") {
    const api = config as unknown as ApiSourceConfig;
    return { apiConfig: api, status: api.endpoint ? "active" : "misconfigured" };
  }
  if (type === "mcp") {
    const mcp = config as unknown as McpSourceConfig;
    return { mcpConfig: mcp, status: mcp.proxyUrl ? "active" : "misconfigured" };
  }
  const url = (config as { connectionUrl?: string }).connectionUrl;
  return { url, status: url ? "active" : "misconfigured" };
}

/** 内置演示 PG 数据源 ID */
export const DEMO_PG_ID = "data_source_demo_pg";
/** 内置 Web 检索源 ID */
export const WEB_SOURCE_ID = "data_source_web";

/** 列出全部数据源（内置 + 自定义） */
export async function listDataSources(): Promise<Array<ResolvedDataSource & { status: string }>> {
  const custom = await prisma.dataSource.findMany({ orderBy: { createdAt: "desc" } });
  return [
    {
      id: DEMO_PG_ID,
      name: "演示经营库（PostgreSQL）",
      type: "bi",
      url: env.DATABASE_URL,
      builtin: true,
      status: "active",
    },
    {
      id: WEB_SOURCE_ID,
      name: "互联网检索（Bing / DuckDuckGo）",
      type: "web",
      builtin: true,
      status: "active",
    },
    ...custom.map((d) => {
      const parsed = parseCustomConfig(d.type, (d.config ?? {}) as Record<string, unknown>);
      return {
        id: d.id,
        name: d.name,
        type: d.type,
        ...parsed,
        builtin: false,
        createdAt: d.createdAt.toISOString(),
      } satisfies ResolvedDataSource & { status: string };
    }),
  ];
}

/** 解析单个数据源：内置 ID 直连 env，否则查库 */
export async function resolveDataSource(id: string): Promise<ResolvedDataSource | null> {
  if (id === DEMO_PG_ID) {
    return { id, name: "演示经营库（PostgreSQL）", type: "bi", url: env.DATABASE_URL, builtin: true };
  }
  if (id === WEB_SOURCE_ID) {
    return { id, name: "互联网检索（Bing / DuckDuckGo）", type: "web", builtin: true };
  }
  const record = await prisma.dataSource.findUnique({ where: { id } });
  if (!record) return null;
  const parsed = parseCustomConfig(record.type, (record.config ?? {}) as Record<string, unknown>);
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    url: parsed.url,
    apiConfig: parsed.apiConfig,
    mcpConfig: parsed.mcpConfig,
    builtin: false,
    createdAt: record.createdAt.toISOString(),
  };
}

/** 数据源对外展示的脱敏 endpoint */
export function displayEndpoint(source: ResolvedDataSource): string {
  if (source.type === "web") return "bing.com / duckduckgo.com";
  if (source.type === "api") return maskUrl(source.apiConfig?.endpoint);
  if (source.type === "mcp") return maskUrl(source.mcpConfig?.proxyUrl);
  return maskUrl(source.url);
}

/** 脱敏展示：连接串仅保留 host/db */
export function maskUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url.split("?")[0] ?? url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "***";
  }
}
