import { z } from "zod";
import {
  handleApiError,
  ok,
  readJson,
  requireActor,
  parsePagination,
} from "@/lib/server/api-runtime";
import { prisma, Prisma } from "@/lib/db";
import { newId } from "@/lib/server/ids";
import { ensureUserExists } from "@/lib/server/user";

const CreateInsightSchema = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(["report", "board", "digest"]).default("report"),
  description: z.string().max(1000).optional(),
  workspaceId: z.string().optional(),
});

/**
 * GET /api/v1/insights — 洞察文档列表（可按 kind 过滤：report/board/digest）
 */
export async function GET(request: Request) {
  try {
    await requireActor(request);
    const { skip, take } = parsePagination(request.url);
    const kind = new URL(request.url).searchParams.get("kind");

    const where: Prisma.InsightDocWhereInput = kind
      ? { kind: kind as "report" | "board" | "digest" }
      : {};

    const [docs, total] = await Promise.all([
      prisma.insightDoc.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip,
        take,
        select: {
          id: true,
          title: true,
          kind: true,
          description: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { bindings: true } },
        },
      }),
      prisma.insightDoc.count({ where }),
    ]);

    return ok({ docs, total, page: Math.floor(skip / take) + 1, pageSize: take });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST /api/v1/insights — 创建洞察文档（初始空 tldraw snapshot）
 */
export async function POST(request: Request) {
  try {
    const actor = await requireActor(request);
    const input = CreateInsightSchema.parse(await readJson<unknown>(request));
    await ensureUserExists(actor.id, actor.email, actor.name);

    const doc = await prisma.insightDoc.create({
      data: {
        id: newId("insight"),
        title: input.title,
        kind: input.kind,
        description: input.description ?? "",
        createdBy: actor.id,
        workspaceId: input.workspaceId ?? null,
        snapshot: {},
      },
    });

    return ok(doc, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
