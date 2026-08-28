import { z } from "zod";
import {
  handleApiError,
  ok,
  readJson,
  requireActor,
  parsePagination,
} from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";
import { newId } from "@/lib/server/ids";

const CreateMetricSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  formula: z.string().optional(),
  unit: z.string().max(50).optional(),
  dataSourceId: z.string().optional(),
});

/**
 * GET /api/v1/metrics — 获取指标列表
 */
export async function GET(request: Request) {
  try {
    await requireActor(request);
    const { skip, take } = parsePagination(request.url);
    const status = new URL(request.url).searchParams.get("status");

    const where = status ? { status: status as "draft" | "published" | "deprecated" } : {};

    const [metrics, total] = await Promise.all([
      prisma.metric.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip,
        take,
        include: { dataSource: { select: { id: true, name: true, type: true } } },
      }),
      prisma.metric.count({ where }),
    ]);

    return ok({ metrics, total });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST /api/v1/metrics — 创建指标
 */
export async function POST(request: Request) {
  try {
    const actor = await requireActor(request);
    const input = CreateMetricSchema.parse(await readJson<unknown>(request));

    const metric = await prisma.metric.create({
      data: {
        id: newId("metric"),
        name: input.name,
        description: input.description ?? "",
        formula: input.formula ?? "",
        unit: input.unit ?? null,
        ownerId: actor.id,
        dataSourceId: input.dataSourceId ?? null,
      },
    });

    return ok(metric, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
