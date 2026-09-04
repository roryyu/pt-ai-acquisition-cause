import { z } from "zod";
import { ApiError, handleApiError, ok, readJson, requireActor } from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";
import { DEMO_PG_ID, WEB_SOURCE_ID } from "@/lib/server/connectors/datasources";
import { assertHttpUrl } from "@/lib/server/connectors/api";

export const runtime = "nodejs";

/** 更新数据源请求（按类型生效对应字段；authToken 缺省表示保留原凭证，不回显） */
const UpdateDataSourceSchema = z.object({
  name: z.string().min(1, "名称不能为空").max(100).optional(),
  // api 类型
  endpoint: z.string().url("endpoint 必须是合法 URL").optional(),
  protocol: z.enum(["rest", "graphql"]).optional(),
  authType: z.enum(["none", "bearer", "api_key", "basic"]).optional(),
  /** 新凭证（如 Adjust API 识别码）；不传保留原值 */
  authToken: z.string().min(1, "凭证不能为空字符串").max(2000).optional(),
  apiKeyHeader: z.string().min(1).max(100).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  // bi 类型
  connectionUrl: z.string().min(1).optional(),
  // mcp 类型
  proxyUrl: z.string().url("proxyUrl 必须是合法 URL").optional(),
});

/**
 * PUT /api/v1/datasources/[id] — 更新自定义数据源（凭证配置入口：API Token 重置后可直接更新，无需删除重建）
 *
 * 安全约束（与注册接口一致）：
 * - 内置数据源不可修改；web / browser 类型不支持更新
 * - authToken 仅在提供新值时覆盖；authType 切回 none 时同步清除已存凭证，避免明文残留
 * - 凭证仅存服务端 config，响应不回显
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await requireActor(request);
    if (id === DEMO_PG_ID || id === WEB_SOURCE_ID) {
      throw new ApiError(403, "FORBIDDEN", "内置数据源不可修改");
    }
    const record = await prisma.dataSource.findUnique({ where: { id } });
    if (!record) {
      throw new ApiError(404, "DATA_SOURCE_NOT_FOUND", "数据源不存在");
    }
    if (record.type !== "api" && record.type !== "bi" && record.type !== "mcp") {
      throw new ApiError(400, "UNSUPPORTED", `${record.type} 类型数据源不支持更新`);
    }
    const input = UpdateDataSourceSchema.parse(await readJson<unknown>(request));

    // 基于现有 config 合并更新（保留未提及字段，如 authToken；值类型限 JSON 可序列化，满足 Prisma Json 入参）
    const config: Record<string, string | Record<string, string>> = {
      ...((record.config ?? {}) as Record<string, string | Record<string, string>>),
    };
    if (record.type === "api") {
      if (input.endpoint !== undefined) {
        const urlCheck = assertHttpUrl(input.endpoint);
        if (!urlCheck.ok) throw new ApiError(400, "INVALID_REQUEST", `endpoint 非法：${urlCheck.reason}`);
        config.endpoint = input.endpoint;
      }
      if (input.protocol !== undefined) config.protocol = input.protocol;
      if (input.authType !== undefined) {
        config.authType = input.authType;
        // 认证方式切回 none：同步清除凭证，避免不再使用的 token 明文残留
        if (input.authType === "none") {
          delete config.authToken;
          delete config.apiKeyHeader;
        }
      }
      if (input.authToken !== undefined) config.authToken = input.authToken;
      if (input.apiKeyHeader !== undefined) config.apiKeyHeader = input.apiKeyHeader;
      if (input.headers !== undefined) config.headers = input.headers;
    } else if (record.type === "bi") {
      if (input.connectionUrl !== undefined) config.connectionUrl = input.connectionUrl;
    } else {
      if (input.proxyUrl !== undefined) {
        const urlCheck = assertHttpUrl(input.proxyUrl);
        if (!urlCheck.ok) throw new ApiError(400, "INVALID_REQUEST", `proxyUrl 非法：${urlCheck.reason}`);
        config.proxyUrl = input.proxyUrl;
      }
      if (input.headers !== undefined) config.headers = input.headers;
    }

    await prisma.dataSource.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        config,
      },
    });
    return ok({ id, updated: true });
  } catch (error) {
    return handleApiError(error);
  }
}

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
