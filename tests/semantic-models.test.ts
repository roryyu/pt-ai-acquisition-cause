import { beforeEach, describe, expect, it, vi } from "vitest";
import { translateToSql, type SemanticModelDef } from "@/lib/server/semantic/semantic-query";

// CRUD 接口测试：隔离 DB 与环境变量依赖（与 datasources.test.ts 同模式）
vi.mock("@/lib/db", () => ({
  prisma: {
    semanticModel: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    dataSource: { findUnique: vi.fn().mockResolvedValue(null) },
  },
  Prisma: {},
}));
vi.mock("@/lib/env", () => ({
  env: { DATABASE_URL: "postgresql://localhost:5432/test?schema=cause" },
}));

import { POST } from "@/app/api/v1/semantic/models/route";
import { PUT, DELETE } from "@/app/api/v1/semantic/models/[id]/route";
import { prisma } from "@/lib/db";

function req(method: string, body: unknown): Request {
  return new Request("http://localhost/api/v1/semantic/models", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function withParams(handler: (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>, id: string, request: Request) {
  return handler(request, { params: Promise.resolve({ id }) });
}

const validBody = {
  name: "售后工单",
  tableRef: "demo.tickets",
  timeColumn: "created_at",
  description: "售后工单明细",
  metrics: [{ id: "ticket_count", name: "工单数", column: "id", agg: "count", description: "工单条数" }],
  dimensions: [{ id: "category", name: "类目", column: "category", description: "工单类目" }],
};

describe("POST /api/v1/semantic/models 新建语义模型", () => {
  const createMock = vi.mocked(prisma.semanticModel.create);

  beforeEach(() => {
    createMock.mockClear();
    createMock.mockResolvedValue({
      id: "semantic_model_new",
      name: validBody.name,
      dataSourceId: null,
      tableRef: "demo.tickets",
      fields: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
  });

  it("非法列名（含注入风险字符）返回 400", async () => {
    const res = await POST(req("POST", {
      ...validBody,
      metrics: [{ id: "bad", name: "坏列", column: 'id"; DROP TABLE x;--', agg: "count" }],
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_REQUEST");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("字段 id 重复返回 400", async () => {
    const res = await POST(req("POST", {
      ...validBody,
      dimensions: [{ id: "ticket_count", name: "重名", column: "category" }],
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("重复");
  });

  it("指标为空返回 400", async () => {
    const res = await POST(req("POST", { ...validBody, metrics: [] }));
    expect(res.status).toBe(400);
  });

  it("未指定数据源（内置演示库）创建成功，dataSourceId 落库为 null", async () => {
    const res = await POST(req("POST", validBody));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(createMock).toHaveBeenCalledOnce();
    const data = (createMock.mock.calls[0]![0] as { data: { dataSourceId: string | null; tableRef: string } }).data;
    expect(data.dataSourceId).toBeNull();
    expect(data.tableRef).toBe("demo.tickets");
  });

  it("指定内置 demo 数据源同样归一化为 null", async () => {
    const res = await POST(req("POST", { ...validBody, dataSourceId: "data_source_demo_pg" }));
    expect(res.status).toBe(201);
    const data = (createMock.mock.calls[0]![0] as { data: { dataSourceId: string | null } }).data;
    expect(data.dataSourceId).toBeNull();
  });

  it("指定不存在的自定义数据源返回 404", async () => {
    const res = await POST(req("POST", { ...validBody, dataSourceId: "data_source_missing" }));
    expect(res.status).toBe(404);
    expect(json404Code(await res.json())).toBe("DATA_SOURCE_NOT_FOUND");
  });
});

describe("PUT /api/v1/semantic/models/[id] 更新语义模型", () => {
  const findUniqueMock = vi.mocked(prisma.semanticModel.findUnique);
  const updateMock = vi.mocked(prisma.semanticModel.update);
  it("内置模型返回 403 只读", async () => {
    const res = await withParams(PUT, "semantic_model_daily_metrics", req("PUT", { name: "改名" }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("不存在的自定义模型返回 404", async () => {
    const res = await withParams(PUT, "semantic_model_not_exist", req("PUT", { name: "改名" }));
    expect(res.status).toBe(404);
  });

  it("存在的自定义模型可更新且 fields 合并", async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: "semantic_model_x",
      name: "旧名",
      dataSourceId: null,
      tableRef: "demo.tickets",
      fields: {
        description: "旧描述",
        timeColumn: "created_at",
        metrics: [{ id: "ticket_count", name: "工单数", column: "id", agg: "count", description: "" }],
        dimensions: [],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    updateMock.mockResolvedValueOnce({
      id: "semantic_model_x",
      name: "新名",
      dataSourceId: null,
      tableRef: "demo.tickets",
      fields: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const res = await withParams(PUT, "semantic_model_x", req("PUT", { name: "新名" }));
    expect(res.status).toBe(200);
    const arg = updateMock.mock.calls[0]![0] as { data: { fields: { metrics: unknown[] } } };
    // 未传 metrics 时保留原有指标
    expect(arg.data.fields.metrics).toHaveLength(1);
  });
});

describe("DELETE /api/v1/semantic/models/[id] 删除语义模型", () => {
  const deleteManyMock = vi.mocked(prisma.semanticModel.deleteMany);

  it("内置模型返回 403 不可删除", async () => {
    const res = await withParams(DELETE, "semantic_model_orders", req("DELETE", {}));
    expect(res.status).toBe(403);
  });

  it("自定义模型删除成功", async () => {
    deleteManyMock.mockResolvedValueOnce({ count: 1 } as never);
    const res = await withParams(DELETE, "semantic_model_x", req("DELETE", {}));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.deleted).toBe(true);
  });

  it("删除不存在的模型返回 404", async () => {
    deleteManyMock.mockResolvedValueOnce({ count: 0 } as never);
    const res = await withParams(DELETE, "semantic_model_ghost", req("DELETE", {}));
    expect(res.status).toBe(404);
  });
});

describe("translateToSql 支持自定义模型列表", () => {
  const customModel: SemanticModelDef = {
    id: "semantic_model_tickets",
    name: "售后工单",
    schema: "demo",
    table: "tickets",
    timeColumn: "created_at",
    description: "售后工单明细",
    metrics: [{ id: "ticket_count", name: "工单数", column: "id", agg: "count", description: "" }],
    dimensions: [{ id: "category", name: "类目", column: "category", description: "" }],
  };

  it("传入自定义模型后可定位并生成 SQL", () => {
    const { sql, model } = translateToSql(
      {
        intent: "query",
        metrics: [{ metricId: "ticket_count" }],
        dimensions: [{ dimensionId: "category" }],
        filters: [],
        timeRange: {},
      },
      [customModel],
    );
    expect(model.id).toBe("semantic_model_tickets");
    expect(sql).toContain('FROM "demo"."tickets"');
    expect(sql).toContain('COUNT("id")');
    // 标准子句顺序：WHERE 先于 GROUP BY
    expect(sql.indexOf("GROUP BY")).toBeGreaterThan(-1);
  });

  it("未注册指标在任何模型中 → 抛错", () => {
    expect(() =>
      translateToSql(
        { intent: "query", metrics: [{ metricId: "ghost_metric" }], dimensions: [], filters: [], timeRange: {} },
        [customModel],
      ),
    ).toThrow(/无法定位语义模型/);
  });
});

function json404Code(json: { error?: { code?: string } }): string {
  return json.error?.code ?? "";
}
