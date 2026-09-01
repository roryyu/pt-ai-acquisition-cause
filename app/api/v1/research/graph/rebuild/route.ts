import { handleApiError, ok, requireActor } from "@/lib/server/api-runtime";
import { prisma } from "@/lib/db";
import { extractGraphPatch } from "@/lib/server/research-graph/extractor";
import { emptyGraph, type KnowledgeGraph } from "@/lib/server/research-graph/types";
import { mergeGraph, saveGraph } from "@/lib/server/research-graph/store";

export const runtime = "nodejs";
export const maxDuration = 600;

/** 报告 answer 负载中与图谱重建相关的字段 */
interface ResearchAnswerPayload {
  content?: string;
  objective?: string;
  subQuestions?: Array<{ id?: string; question?: string; findings?: string[]; elapsedMs?: number }>;
}

/**
 * POST /api/v1/research/graph/rebuild — 从存量已完成研究重建知识图谱
 *
 * 清空现图谱 → 按时间正序遍历全部 completed 深度研究报告 →
 * 逐个 LLM 抽取图谱补丁并增量合并（串行防限流）→ 原子落盘。
 * 单篇抽取失败跳过不阻断整体重建。
 */
export async function POST(request: Request) {
  try {
    await requireActor(request);

    const questions = await prisma.question.findMany({
      where: {
        status: "completed",
        context: { path: ["kind"], equals: "deep_research" },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, content: true, answer: true, createdAt: true },
    });

    let graph: KnowledgeGraph = emptyGraph();
    let succeeded = 0;
    let skipped = 0;

    for (const q of questions) {
      const answer = (q.answer ?? {}) as ResearchAnswerPayload;
      const report = answer.content ?? "";
      if (!report.trim()) {
        skipped += 1;
        continue;
      }
      const subResults = (answer.subQuestions ?? []).map((s, i) => ({
        id: s.id ?? `sub_${i + 1}`,
        question: s.question ?? "",
        rationale: "",
        findings: s.findings ?? [],
        citationNos: [] as number[],
        searchedQueries: [] as string[],
        elapsedMs: s.elapsedMs ?? 0,
      }));
      try {
        const patch = await extractGraphPatch(q.content, answer.objective ?? q.content, subResults, report);
        if (!patch) {
          skipped += 1;
          continue;
        }
        const merged = mergeGraph(graph, patch, {
          questionId: q.id,
          question: q.content,
          objective: answer.objective ?? q.content,
          summary: patch.summary,
          createdAt: q.createdAt.toISOString(),
        });
        graph = merged.graph;
        succeeded += 1;
      } catch {
        skipped += 1;
      }
    }

    await saveGraph(graph);

    return ok({
      total: questions.length,
      succeeded,
      skipped,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      reportCount: graph.reports.length,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
