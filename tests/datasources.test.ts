import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertHttpUrl,
  assertReadOnlyGraphQL,
  buildAuthHeaders,
  resolveRequestUrl,
} from "@/lib/server/connectors/api";

// 注册接口测试：隔离 DB 与环境变量依赖
vi.mock("@/lib/db", () => ({
  prisma: {
    dataSource: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));
vi.mock("@/lib/env", () => ({
  env: { DATABASE_URL: "postgresql://localhost:5432/test?schema=cause" },
}));

import { GET as listGet, POST } from "@/app/api/v1/datasources/route";
import { PUT } from "@/app/api/v1/datasources/[id]/route";
import { prisma } from "@/lib/db";

describe("GraphQL 只读防护 assertReadOnlyGraphQL", () => {
  it("允许匿名查询与 query 操作", () => {
    expect(assertReadOnlyGraphQL("{ countries { name } }").ok).toBe(true);
    expect(assertReadOnlyGraphQL("query GetUsers { users { id } }").ok).toBe(true);
  });

  it("拒绝 mutation 操作", () => {
    const result = assertReadOnlyGraphQL('mutation { createUser(name: "x") { id } }');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("mutation");
  });

  it("拒绝 subscription 操作", () => {
    const result = assertReadOnlyGraphQL("subscription { onEvent { id } }");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("subscription");
  });

  it("注释与字符串中出现 mutation 字样不误判", () => {
    expect(assertReadOnlyGraphQL("# mutation 说明\n{ users { id } }").ok).toBe(true);
    expect(assertReadOnlyGraphQL('{ search(kw: "mutation") { id } }').ok).toBe(true);
  });
});

describe("REST 请求 URL 拼接 resolveRequestUrl", () => {
  it("相对 path 拼接到 endpoint 并附加 query 参数", () => {
    const url = resolveRequestUrl("https://api.example.com/v1/", "users", { page: "2" });
    expect(url).toBe("https://api.example.com/v1/users?page=2");
  });

  it("跨主机 path 写法被中和为同主机子路径（不会跨主机重定向）", () => {
    // base path 拼接语义下前导斜杠被剥离，绝对 URL / 协议相对路径均退化为子路径
    expect(resolveRequestUrl("https://api.example.com", "https://evil.com/steal")).toBe(
      "https://api.example.com/https://evil.com/steal",
    );
    expect(resolveRequestUrl("https://api.example.com", "//evil.com/x")).toBe(
      "https://api.example.com/evil.com/x",
    );
  });
});

describe("endpoint 协议与认证头", () => {
  it("仅允许 http/https 协议", () => {
    expect(assertHttpUrl("https://api.example.com").ok).toBe(true);
    expect(assertHttpUrl("ftp://api.example.com").ok).toBe(false);
    expect(assertHttpUrl("not-a-url").ok).toBe(false);
  });

  it("按 authType 组装认证头", () => {
    expect(
      buildAuthHeaders({ endpoint: "https://x", protocol: "rest", authType: "bearer", authToken: "t1" }),
    ).toMatchObject({ authorization: "Bearer t1" });
    expect(
      buildAuthHeaders({ endpoint: "https://x", protocol: "rest", authType: "api_key", authToken: "k1" }),
    ).toMatchObject({ "X-API-Key": "k1" });
  });
});

describe("数据源注册接口分类型校验 POST /api/v1/datasources", () => {
  beforeEach(() => {
    vi.mocked(prisma.dataSource.create).mockClear();
  });

  function post(body: unknown): Promise<Response> {
    return POST(
      new Request("http://localhost/api/v1/datasources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("api 类型缺少 endpoint 返回 400", async () => {
    const res = await post({ type: "api", name: "开放平台", protocol: "rest" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("INVALID_REQUEST");
  });

  it("mcp 类型缺少 proxyUrl 返回 400", async () => {
    const res = await post({ type: "mcp", name: "内部代理" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_REQUEST");
  });

  it("browser 类型返回 400 暂不支持", async () => {
    const res = await post({ type: "browser", name: "浏览器抓取" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("UNSUPPORTED");
    expect(json.error.message).toContain("暂不支持");
    expect(prisma.dataSource.create).not.toHaveBeenCalled();
  });

  it("合法 api 数据源注册成功并落库", async () => {
    const res = await post({
      type: "api",
      name: "Countries GraphQL",
      endpoint: "https://countries.trevorblades.com/graphql",
      protocol: "graphql",
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(prisma.dataSource.create).toHaveBeenCalledOnce();
    const createArg = vi.mocked(prisma.dataSource.create).mock.calls[0]![0];
    expect(createArg.data.config).toMatchObject({
      endpoint: "https://countries.trevorblades.com/graphql",
      protocol: "graphql",
      authType: "none",
    });
  });

  it("合法 mcp 数据源注册成功", async () => {
    const res = await post({
      type: "mcp",
      name: "内部 MCP 代理",
      proxyUrl: "https://mcp-proxy.internal/mcp",
      headers: { "X-Tenant-Id": "demo" },
    });
    expect(res.status).toBe(201);
    expect(prisma.dataSource.create).toHaveBeenCalledOnce();
  });
});

describe("更新数据源认证配置 PUT /api/v1/datasources/[id]", () => {
  /** 模拟已注册的 api 数据源记录（含现有 token） */
  const apiRecord = {
    id: "data_source_adjust",
    name: "Adjust 报告服务",
    type: "api" as const,
    connectorId: "api",
    config: {
      endpoint: "https://automate.adjust.com/reports-service",
      protocol: "rest",
      authType: "bearer",
      authToken: "old-token",
    },
    createdAt: new Date("2026-09-01T00:00:00Z"),
  };

  function put(id: string, body: unknown): Promise<Response> {
    return PUT(
      new Request(`http://localhost/api/v1/datasources/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  beforeEach(() => {
    vi.mocked(prisma.dataSource.findUnique).mockReset();
    vi.mocked(prisma.dataSource.update).mockReset().mockResolvedValue(apiRecord as never);
  });

  it("更新 authToken 时保留其余配置（endpoint/protocol 不丢）", async () => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue(apiRecord as never);
    const res = await put("data_source_adjust", { authToken: "new-token" });
    expect(res.status).toBe(200);
    const updateArg = vi.mocked(prisma.dataSource.update).mock.calls[0]![0];
    expect(updateArg.data.config).toMatchObject({
      endpoint: "https://automate.adjust.com/reports-service",
      protocol: "rest",
      authType: "bearer",
      authToken: "new-token",
    });
  });

  it("不传 authToken 时保留原凭证（合并语义）", async () => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue(apiRecord as never);
    await put("data_source_adjust", { name: "Adjust 报告服务（改名）" });
    const updateArg = vi.mocked(prisma.dataSource.update).mock.calls[0]![0];
    expect(updateArg.data.config).toMatchObject({ authToken: "old-token" });
    expect(updateArg.data.name).toBe("Adjust 报告服务（改名）");
  });

  it("authType 切回 none 时同步清除已存凭证", async () => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue(apiRecord as never);
    await put("data_source_adjust", { authType: "none" });
    const config = vi.mocked(prisma.dataSource.update).mock.calls[0]![0].data.config as Record<string, unknown>;
    expect(config).toMatchObject({ authType: "none", endpoint: "https://automate.adjust.com/reports-service" });
    expect("authToken" in config).toBe(false);
  });

  it("内置数据源不可修改（403）", async () => {
    const res = await put("data_source_demo_pg", { authToken: "x" });
    expect(res.status).toBe(403);
    expect(prisma.dataSource.update).not.toHaveBeenCalled();
  });

  it("数据源不存在返回 404", async () => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue(null);
    const res = await put("data_source_missing", { authToken: "x" });
    expect(res.status).toBe(404);
  });

  it("非法 endpoint 返回 400 且不落库", async () => {
    vi.mocked(prisma.dataSource.findUnique).mockResolvedValue(apiRecord as never);
    const res = await put("data_source_adjust", { endpoint: "not-a-url" });
    expect(res.status).toBe(400);
    expect(prisma.dataSource.update).not.toHaveBeenCalled();
  });
});

describe("数据源列表透出凭证配置状态 GET /api/v1/datasources", () => {
  beforeEach(() => {
    vi.mocked(prisma.dataSource.findMany).mockReset();
  });

  it("meta.authConfigured 反映凭证是否已配置（脱敏布尔值，不回显凭证）", async () => {
    vi.mocked(prisma.dataSource.findMany).mockResolvedValue([
      apiListRecord("data_source_a", "Adjust 报告服务", "bearer", "token-x"),
      apiListRecord("data_source_b", "开放平台", "bearer"),
      apiListRecord("data_source_c", "公共接口", "none"),
    ] as never);
    const res = await listGet(new Request("http://localhost/api/v1/datasources"));
    const json = await res.json();
    expect(json.ok).toBe(true);
    const byId = new Map(
      (json.data.dataSources as Array<{ id: string; meta: { authConfigured: boolean } | null }>).map(
        (s) => [s.id, s] as const,
      ),
    );
    expect(byId.get("data_source_a")!.meta!.authConfigured).toBe(true);
    expect(byId.get("data_source_b")!.meta!.authConfigured).toBe(false);
    // none 认证无需凭证，视为已配置
    expect(byId.get("data_source_c")!.meta!.authConfigured).toBe(true);
    // 凭证本身不回显
    expect(JSON.stringify(json)).not.toContain("token-x");
  });
});

/** 构造列表接口返回的 api 数据源记录 */
function apiListRecord(id: string, name: string, authType: string, authToken?: string) {
  return {
    id,
    name,
    type: "api" as const,
    connectorId: "api",
    config: {
      endpoint: "https://automate.adjust.com/reports-service",
      protocol: "rest",
      authType,
      ...(authToken ? { authToken } : {}),
    },
    createdAt: new Date("2026-09-01T00:00:00Z"),
  };
}
